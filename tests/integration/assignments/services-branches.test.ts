import { beforeEach, expect, it } from 'vitest'
import { clearData, getPayloadSingleton, integrationSuite, uniqueEmail } from '../_payload'
import { createAndAssign, listBank, listForClass } from '@/assignments/service'
import { createAttemptsService } from '@/attempts/service'
import type { Actor } from '@/domain/authorization'

/**
 * Branch coverage for the work-flow services (complements the handler-level
 * slice in assignments.test.ts): bank filter/pagination clamps, assignment
 * validation paths, class monitoring counts, comment visibility at the
 * SERVICE layer, progress aggregation robustness, and every remediation
 * outcome. These are the authorization/lifecycle branches the coverage gate
 * exists for.
 */

async function seedQ(
  p: Parameters<typeof createAndAssign>[0],
  code: string,
  extra: Partial<{ type: string; topic: string; points: number; editorStatus: string }> = {},
) {
  const type = extra.type ?? (code.startsWith('mc') ? 'multiple-choice' : code.startsWith('ext') ? 'extended-text' : code.startsWith('sc') ? 'single-choice' : 'short-text')
  await p.create({
    collection: 'questions',
    data: {
      subjectVersionId: 'math-oge-2026',
      code,
      revisionNumber: 1,
      type,
      topic: extra.topic ?? 'Тема A',
      stem: `Строка вопроса ${code}`,
      options: type === 'multiple-choice' || type === 'single-choice' ? [{ id: 'a', text: 'a' }, { id: 'b', text: 'b' }] : [],
      answerKey: type === 'multiple-choice' ? { ids: ['a'] } : type === 'single-choice' ? { id: 'a' } : type === 'extended-text' ? null : { accepted: ['42'] },
      points: extra.points ?? 1,
      source: 'authored',
      editorStatus: extra.editorStatus ?? 'published',
      publishedAt: Date.now(),
    },
    overrideAccess: true,
  })
}


/** Narrow a service result union and assert its failure code. */
async function expectFail(r: Promise<{ ok: boolean; code?: string }>, code: string) {
  const res = await r
  expect(res.ok).toBe(false)
  expect(res.code).toBe(code)
}

async function seedActors(p: Parameters<typeof createAndAssign>[0]): Promise<{ teacher: Actor; student: Actor; classId: string }> {
  const teacherRow = await p.create({
    collection: 'users',
    data: { email: uniqueEmail('br-t'), password: 'longpass123', emailConfirmed: true, role: 'teacher' },
    overrideAccess: true,
  })
  const studentRow = await p.create({
    collection: 'users',
    data: { email: uniqueEmail('br-s'), password: 'longpass123', emailConfirmed: true, role: 'student', name: 'Ученик Б' },
    overrideAccess: true,
  })
  const cls = await p.create({
    collection: 'classes',
    data: { name: 'Ветки', subjectVersionId: 'math-oge-2026', ownerId: String(teacherRow.id) },
    overrideAccess: true,
  })
  return { teacher: { id: String(teacherRow.id), role: 'teacher' }, student: { id: String(studentRow.id), role: 'student' }, classId: String(cls.id) }
}

async function assign(p: Parameters<typeof createAndAssign>[0], f: { teacher: Actor; student: Actor; classId: string }, codes: string[], title = 'Работа') {
  const res = await createAndAssign(p, {
    ownerId: f.teacher.id, classId: f.classId, title, questionCodes: codes, recipientIds: [f.student.id], subjectVersionId: 'math-oge-2026',
  })
  expect(res.ok).toBe(true)
  return res as { ok: true; assignmentId: string }
}

integrationSuite('work-flow services: branch coverage (bank/validation/monitoring/comments/progress/remediation)', () => {
  beforeEach(clearData)

  it('listBank: type/topic/search filters and page/limit clamps', async () => {
    const p = await getPayloadSingleton()
    await seedQ(p, 'sc1', { topic: 'Тема A' })
    await seedQ(p, 'sc2', { topic: 'Тема B' })
    await seedQ(p, 'mc1', { topic: 'Тема A' })
    await seedQ(p, 'st1', { topic: 'Тема B' })

    const all = await listBank(p, { subjectVersionId: 'math-oge-2026' })
    expect(all.total).toBe(4)

    const byType = await listBank(p, { subjectVersionId: 'math-oge-2026', type: 'single-choice' })
    expect(byType.items.map((i) => i.code)).toEqual(['sc1', 'sc2'])

    const byTopic = await listBank(p, { subjectVersionId: 'math-oge-2026', topic: 'Тема A' })
    expect(byTopic.items.map((i) => i.code).sort()).toEqual(['mc1', 'sc1'])

    const bySearch = await listBank(p, { subjectVersionId: 'math-oge-2026', q: 'sc2' })
    expect(bySearch.items.map((i) => i.code)).toEqual(['sc2'])

    // page<1 → 1, limit>100 → 100: still a valid single page with everything.
    const clamped = await listBank(p, { subjectVersionId: 'math-oge-2026', page: 0, limit: 500 })
    expect(clamped.items).toHaveLength(4)

    // Drafts never appear.
    await seedQ(p, 'dr1', { editorStatus: 'draft' })
    expect((await listBank(p, { subjectVersionId: 'math-oge-2026' })).total).toBe(4)
  })

  it('createAndAssign: validation_error paths, question_not_found, dueAt persisted', async () => {
    const p = await getPayloadSingleton()
    const f = await seedActors(p)
    await seedQ(p, 'sc1')

    await expectFail(createAndAssign(p, { ownerId: f.teacher.id, classId: f.classId, title: '  ', questionCodes: ['sc1'], recipientIds: [f.student.id], subjectVersionId: 'math-oge-2026' }), 'validation_error')
    await expectFail(createAndAssign(p, { ownerId: f.teacher.id, classId: f.classId, title: 'T', questionCodes: [], recipientIds: [f.student.id], subjectVersionId: 'math-oge-2026' }), 'validation_error')
    await expectFail(createAndAssign(p, { ownerId: f.teacher.id, classId: f.classId, title: 'T', questionCodes: ['sc1'], recipientIds: [], subjectVersionId: 'math-oge-2026' }), 'validation_error')
    await expectFail(createAndAssign(p, { ownerId: f.teacher.id, classId: f.classId, title: 'T', questionCodes: ['nope'], recipientIds: [f.student.id], subjectVersionId: 'math-oge-2026' }), 'question_not_found')

    const dueAt = Date.now() + 86_400_000
    await assign(p, f, ['sc1'], 'Со сроком')
    const withDue = await createAndAssign(p, {
      ownerId: f.teacher.id, classId: f.classId, title: 'Со сроком 2', questionCodes: ['sc1'], recipientIds: [f.student.id], dueAt, subjectVersionId: 'math-oge-2026',
    })
    expect(withDue.ok).toBe(true)
    const attempts = await p.find({ collection: 'attempts', where: { title: { equals: 'Со сроком 2' } }, limit: 1, overrideAccess: true })
    expect((attempts.docs[0] as unknown as { dueAt: number }).dueAt).toBe(dueAt)
  })

  it('listForClass: recipient/submitted counts and question counts', async () => {
    const p = await getPayloadSingleton()
    const f = await seedActors(p)
    await seedQ(p, 'sc1')
    await seedQ(p, 'st1')
    await assign(p, f, ['sc1'], 'Первая')
    await assign(p, f, ['sc1', 'st1'], 'Вторая')

    const svc = createAttemptsService(p)
    const list0 = await listForClass(p, f.teacher.id, f.classId)
    expect(list0).toHaveLength(2)
    expect(list0.find((a) => a.title === 'Вторая')?.questionCount).toBe(2)

    // Submit the first work → its submitted count becomes 1.
    const works = await svc.listForStudent(f.student.id)
    const first = works.find((w) => w.title === 'Первая')!
    await svc.saveAnswer(f.student, first.id, { code: 'sc1', value: 'a', clientVersion: 1 })
    await svc.submit(f.student, first.id, 'branch-key-1')

    const list1 = await listForClass(p, f.teacher.id, f.classId)
    expect(list1.find((a) => a.title === 'Первая')?.submitted).toBe(1)
    expect(list1.find((a) => a.title === 'Вторая')?.submitted).toBe(0)

    // Foreign teacher sees nothing.
    expect(await listForClass(p, 'nobody', f.classId)).toHaveLength(0)
  })

  it('commentsFor: internal notes hidden from the student, kept for the teacher', async () => {
    const p = await getPayloadSingleton()
    const f = await seedActors(p)
    await seedQ(p, 'sc1')
    const a = await assign(p, f, ['sc1'])
    const svc = createAttemptsService(p)
    const works = await svc.listForStudent(f.student.id)
    const id = works[0]!.id

    expect(await svc.commentsFor(f.student, id)).toEqual([])
    await svc.addComment(f.teacher, id, { body: 'публично', internal: false })
    await svc.addComment(f.teacher, id, { body: 'служебная', internal: true })
    await svc.addComment(f.student, id, { body: 'вопрос' })

    const forStudent = await svc.commentsFor(f.student, id)
    expect(forStudent!.map((c) => c.body).sort()).toEqual(['вопрос', 'публично'])
    const forTeacher = await svc.commentsFor(f.teacher, id)
    expect(forTeacher!.map((c) => c.body).sort()).toEqual(['вопрос', 'публично', 'служебная'])
    void a
  })

  it('saveAnswer: unknown code → not_found; attachments retained across saves', async () => {
    const p = await getPayloadSingleton()
    const f = await seedActors(p)
    await seedQ(p, 'st1')
    await assign(p, f, ['st1'])
    const svc = createAttemptsService(p)
    const id = (await svc.listForStudent(f.student.id))[0]!.id

    await expectFail(svc.saveAnswer(f.student, id, { code: 'zzz', value: 'x', clientVersion: 1 }), 'not_found')

    await svc.saveAnswer(f.student, id, { code: 'st1', value: '42', attachmentIds: ['att-1'], clientVersion: 1 })
    await svc.saveAnswer(f.student, id, { code: 'st1', value: '43', clientVersion: 2 }) // no new attachments
    const view = await svc.studentView(f.student, id)
    expect(view.ok && (view as { answers: Record<string, unknown> }).answers.st1).toBe('43')
    expect(view.ok && (view as { attachmentIds: Record<string, string[]> }).attachmentIds.st1).toEqual(['att-1'])
  })

  it('progress: bogus score rows are skipped, topics aggregate auto+manual', async () => {
    const p = await getPayloadSingleton()
    const f = await seedActors(p)
    await seedQ(p, 'sc1', { topic: 'Тема A' })
    await seedQ(p, 'ext1', { topic: 'Тема B', points: 3 })
    await assign(p, f, ['sc1', 'ext1'])
    const svc = createAttemptsService(p)
    const id = (await svc.listForStudent(f.student.id))[0]!.id

    await svc.saveAnswer(f.student, id, { code: 'sc1', value: 'a', clientVersion: 1 })
    await svc.saveAnswer(f.student, id, { code: 'ext1', value: 'решение', clientVersion: 1 })
    await svc.submit(f.student, id, 'prog-key')
    await svc.score(f.teacher, id, { code: 'ext1', manual: 2 })
    await svc.finalize(f.teacher, id)

    // Inject a score row whose question vanished from the snapshot — progress must skip it.
    const row = await p.find({ collection: 'attempts', where: { id: { equals: id } }, limit: 1, overrideAccess: true })
    const at = row.docs[0] as unknown as { scores: { code: string }[] }
    await p.update({
      collection: 'attempts', id,
      data: { scores: [...at.scores, { code: 'ghost', auto: 5, manual: 5 }] as unknown as never },
      overrideAccess: true,
    })

    const prog = await svc.progress(f.student.id)
    const topicA = prog.topics.find((t) => t.topic === 'Тема A')!
    expect(topicA).toEqual({ topic: 'Тема A', earned: 1, max: 1, percent: 100 })
    const topicB = prog.topics.find((t) => t.topic === 'Тема B')!
    expect(topicB).toEqual({ topic: 'Тема B', earned: 2, max: 3, percent: 67 })
    expect(prog.attempts).toHaveLength(1)
  })

  it('teacherView: full data for the owner, nothing for a foreign teacher; score inserts a missing row', async () => {
    const p = await getPayloadSingleton()
    const f = await seedActors(p)
    await seedQ(p, 'sc1')
    await seedQ(p, 'ext1', { points: 3 })
    await assign(p, f, ['sc1', 'ext1'])
    const svc = createAttemptsService(p)
    const id = (await svc.listForStudent(f.student.id))[0]!.id

    await svc.saveAnswer(f.student, id, { code: 'sc1', value: 'a', clientVersion: 1 })
    await svc.saveAnswer(f.student, id, { code: 'ext1', value: 'решение', clientVersion: 1 })
    await svc.submit(f.student, id, 'tv-key')

    const view = await svc.teacherView(f.teacher, id)
    expect(view.ok).toBe(true)
    if (view.ok) {
      // The teacher sees the snapshot WITH answer keys and unwrapped answers.
      const sc = view.snapshot.find((q) => q.code === 'sc1')!
      expect((sc as unknown as { answerKey: unknown }).answerKey).toEqual({ id: 'a' })
      expect(view.studentAnswers.sc1!.value).toBe('a')
      expect(view.studentAnswers.ext1!.value).toBe('решение')
    }

    const foreign = { id: 'not-the-owner', role: 'teacher' as const }
    await expectFail(svc.teacherView(foreign, id), 'not_found')

    // Rubric scoring on a question whose score row is MISSING (row set removed)
    // takes the insert branch.
    const row = await p.find({ collection: 'attempts', where: { id: { equals: id } }, limit: 1, overrideAccess: true })
    const at = row.docs[0] as unknown as { scores: { code: string }[] }
    await p.update({
      collection: 'attempts', id,
      data: { scores: at.scores.filter((s) => s.code !== 'ext1') as unknown as never },
      overrideAccess: true,
    })
    const rescored = await svc.score(f.teacher, id, { code: 'ext1', manual: 2, teacherComment: 'ок' })
    expect(rescored.ok).toBe(true)
    await svc.finalize(f.teacher, id)
    const fin = await svc.teacherView(f.teacher, id)
    expect(fin.ok && (fin as { attempt: { totalScore: number } }).attempt.totalScore).toBe(3)
  })

  it('degenerate rows: missing optional fields exercise every null-fallback arm', async () => {
    const p = await getPayloadSingleton()
    const f = await seedActors(p)
    await seedQ(p, 'sc1')
    const a = await assign(p, f, ['sc1'])

    // Hand-made assignment+attempt rows with ONLY required fields (the
    // (assignmentId, studentId) unique index forbids reusing `a` here).
    const rawAssignment = await p.create({
      collection: 'assignments',
      data: {
        ownerId: f.teacher.id, classId: f.classId, title: 'Сырая работа',
        questionSnapshot: [{ code: 'sc1', type: 'single-choice', topic: 'Тема A', stem: 'Строка вопроса sc1', options: [], answerKey: { id: 'a' }, points: 1 }],
        recipientIds: [{ id: f.student.id }],
        createdAt: Date.now(),
      },
      overrideAccess: true,
    })
    const raw = await p.create({
      collection: 'attempts',
      data: {
        assignmentId: String(rawAssignment.id), classId: f.classId, ownerId: f.teacher.id,
        studentId: f.student.id, title: 'Сырая строка', subjectVersionId: 'math-oge-2026', createdAt: Date.now(),
      },
      overrideAccess: true,
    })
    const svc = createAttemptsService(p)

    // listForStudent / progress null-fallbacks (submittedAt/maxScore/checkedAt/totalScore ?? 0).
    const works = await svc.listForStudent(f.student.id)
    const rawWork = works.find((w) => w.title === 'Сырая строка')!
    expect(rawWork.submittedAt).toBeNull()
    expect(rawWork.totalScore).toBeNull()

    // saveAnswer on a row with NO answers array and NO clientVersion on the
    // existing entry; value omitted entirely (undefined arm).
    const saved = await svc.saveAnswer(f.student, String(raw.id), { code: 'sc1', clientVersion: 2 })
    expect(saved.ok).toBe(true)
    // A row whose stored value is literally null (unwrap arm).
    await p.update({
      collection: 'attempts', id: raw.id,
      data: { answers: [{ code: 'sc1', value: null }] as unknown as never },
      overrideAccess: true,
    })
    const tv = await svc.teacherView(f.teacher, String(raw.id))
    expect(tv.ok && tv.studentAnswers.sc1!.value).toBeNull()
    const sv = await svc.studentView(f.student, String(raw.id))
    expect(sv.ok && (sv as { answers: Record<string, unknown> }).answers).toEqual({})

    // commentsFor on a row with no comments field at all + foreign student → null.
    expect(await svc.commentsFor(f.student, String(raw.id))).toEqual([])
    expect(await svc.commentsFor({ id: 'stranger', role: 'student' }, String(raw.id))).toBeNull()

    // All-objective queue entry: pendingManual false arm.
    const real = works.find((w) => w.title === 'Работа')!.id
    await svc.saveAnswer(f.student, real, { code: 'sc1', value: 'a', clientVersion: 1 })
    await svc.submit(f.student, real, 'deg-key')
    const queue = await svc.reviewQueue(f.teacher)
    expect(queue.find((q) => q.id === real)!.pendingManual).toBe(false)
  })

  it('remediation: every outcome — wrong state, nothing failed, empty pick, happy path', async () => {
    const p = await getPayloadSingleton()
    const f = await seedActors(p)
    await seedQ(p, 'sc1', { topic: 'Тема A' })
    await seedQ(p, 'sc2', { topic: 'Тема A' }) // unseen alternative in the SAME topic
    await assign(p, f, ['sc1'])
    const svc = createAttemptsService(p)
    const id = (await svc.listForStudent(f.student.id))[0]!.id

    // Not checked yet.
    await expectFail(svc.remediation(f.teacher, id, (c) => c.map((q) => q.code)), 'invalid_transition')

    // Wrong answer → topic A fails; finalize to make it remediable.
    await svc.saveAnswer(f.student, id, { code: 'sc1', value: 'b', clientVersion: 1 })
    await svc.submit(f.student, id, 'rem-key')
    await svc.finalize(f.teacher, id)

    // Picker returns nothing → question_not_found.
    await expectFail(svc.remediation(f.teacher, id, () => []), 'question_not_found')

    // Happy path: a NEW assignment for the failed topic, excluding seen codes.
    const created = await svc.remediation(f.teacher, id, (candidates) => {
      expect(candidates.every((c) => c.topic === 'Тема A')).toBe(true)
      expect(candidates.map((c) => c.code)).toEqual(['sc2'])
      return candidates.map((c) => c.code)
    })
    expect(created.ok).toBe(true)
    const works = await svc.listForStudent(f.student.id)
    const rem = works.find((w) => w.title.startsWith('Работа над ошибками'))
    expect(rem).toBeDefined()

    // A ghost score row (code not in the snapshot) is skipped, and a foreign
    // teacher gets not_found.
    const row = await p.find({ collection: 'attempts', where: { id: { equals: id } }, limit: 1, overrideAccess: true })
    const at = row.docs[0] as unknown as { scores: { code: string }[] }
    await p.update({
      collection: 'attempts', id,
      data: { scores: [...at.scores, { code: 'ghost', auto: 0, manual: 0 }] as unknown as never },
      overrideAccess: true,
    })
    const ghostRes = await svc.remediation(f.teacher, id, (candidates) => {
      expect(candidates.map((c) => c.code)).toEqual(['sc2'])
      return candidates.map((c) => c.code)
    })
    expect(ghostRes.ok).toBe(true)
    await expectFail(svc.remediation({ id: 'stranger', role: 'teacher' }, id, (c) => c.map((q) => q.code)), 'not_found')

    // All-correct work has nothing to remediate.
    const ok = await assign(p, f, ['sc2'], 'Идеальная')
    const id2 = (await svc.listForStudent(f.student.id)).find((w) => w.title === 'Идеальная')!.id
    await svc.saveAnswer(f.student, id2, { code: 'sc2', value: 'a', clientVersion: 1 })
    await svc.submit(f.student, id2, 'rem-key-2')
    await svc.finalize(f.teacher, id2)
    await expectFail(svc.remediation(f.teacher, id2, (c) => c.map((q) => q.code)), 'validation_error')
    void ok
  })
})
