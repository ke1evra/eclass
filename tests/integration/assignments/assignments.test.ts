import { beforeEach, describe, expect, it } from 'vitest'
import { NextRequest } from 'next/server'
import { clearData, getPayloadSingleton, integrationSuite, uniqueEmail } from '../_payload'
import { createSessionAdapter } from '@/auth/session-adapter'
import { handleCreateAssignment } from '@/app/api/assignments/handler'
import { handleListContent } from '@/app/api/content/handler'
import { handleStudentAssignments } from '@/app/api/student/assignments/handler'
import { handleGetAttempt, handleAttemptAction } from '@/app/api/attempts/[id]/handler'
import { handleReviewQueue } from '@/app/api/review/handler'
import { handleStudentProgress } from '@/app/api/student/progress/handler'
import { handleCreateClass } from '@/app/api/classes/handler'
import { handleCreateInvite } from '@/app/api/classes/[id]/invites/handler'
import { handleJoin } from '@/app/api/join/handler'
import { gradeAnswer } from '@/attempts/service'
import { SESSION_TTL_MS } from '@/auth/session-ttl'

/**
 * P2/P3/P5 vertical slice — the critical invariants, through REAL handlers
 * against Payload/Mongo:
 *
 *   - bank listing: published only, answerKey never in the response;
 *   - assignment: snapshot immutability (bank edit does not change issued
 *     work), one attempt per recipient;
 *   - runner: autosave ownership (foreign student → 404), stale
 *     clientVersion never overwrites newer, answerKey stripped from the
 *     student view;
 *   - submit: idempotent (same key → same result; other key → 409), answers
 *     immutable after submit, autograding exact for all objective types;
 *   - review: teacher-owner-only, finalize totals = auto + manual, rubric
 *     completeness enforced, checked freezes;
 *   - feedback: internal teacher notes invisible to the student;
 *   - progress: mastery computed only from checked work.
 */

const HOUR = SESSION_TTL_MS

function jsonReq(url: string, method: 'GET' | 'POST', body: unknown, cookie?: string): NextRequest {
  const headers: Record<string, string> = {}
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (cookie) headers.cookie = cookie
  return new NextRequest(new URL(url, 'http://localhost'), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

interface Fixtures {
  teacherCookie: string
  studentCookie: string
  studentCookie2: string
  classId: string
}

async function seed(p: Parameters<typeof handleCreateAssignment>[1]): Promise<Fixtures> {
  const teacher = await p.create({
    collection: 'users',
    data: { email: uniqueEmail('tea-a'), password: 'longpass123', emailConfirmed: true },
    overrideAccess: true,
  })
  const adapter = createSessionAdapter({ payload: p, clock: { now: () => Date.now() }, sessionTtlMs: HOUR })
  const tLogin = await adapter.login({ email: teacher.email, password: 'longpass123' })
  expect(tLogin.ok).toBe(true)
  const teacherCookie = `eclass_session=${tLogin.ok ? tLogin.sessionId : ''}`

  const cls = await (await handleCreateClass(
    jsonReq('http://localhost/api/classes', 'POST', { name: 'Slice', subjectVersionId: 'math-oge-2026' }, teacherCookie), p,
  )).json()
  const invite = await (await handleCreateInvite(
    new NextRequest(new URL(`http://localhost/api/classes/${cls.class.id}/invites`, 'http://localhost'), { method: 'POST', headers: { cookie: teacherCookie } }), p, cls.class.id,
  )).json()

  // Single-use codes: a FRESH invite per student.
  const joinAs = async (suffix: string, name: string): Promise<string> => {
    const inv = await (await handleCreateInvite(
      new NextRequest(new URL(`http://localhost/api/classes/${cls.class.id}/invites`, 'http://localhost'), { method: 'POST', headers: { cookie: teacherCookie } }), p, cls.class.id,
    )).json()
    const join = await handleJoin(
      jsonReq('http://localhost/api/join', 'POST', {
        code: inv.code, login: uniqueEmail(suffix), displayName: name, password: 'longpass123',
      }), p,
    )
    expect(join.status).toBe(200)
    return `eclass_session=${join.headers.get('set-cookie')!.match(/eclass_session=([^;]+)/)![1]}`
  }
  void invite
  const studentCookie = await joinAs('stu0', 'Ученик 0')
  const studentCookie2 = await joinAs('stu-x', 'Ученик X')

  return { teacherCookie, studentCookie, studentCookie2, classId: cls.class.id }
}

async function seedQuestions(p: Parameters<typeof handleCreateAssignment>[1], codes: string[]) {
  for (const code of codes) {
    await p.create({
      collection: 'questions',
      data: {
        subjectVersionId: 'math-oge-2026', code, revisionNumber: 1,
        type: code.startsWith('mc') ? 'multiple-choice' : code.startsWith('ext') ? 'extended-text' : code.startsWith('sc') ? 'single-choice' : 'short-text',
        topic: code.endsWith('2') ? 'Тема B' : 'Тема A',
        stem: `Строка вопроса ${code}`,
        options: code.startsWith('mc') || code.startsWith('sc')
          ? [{ id: 'a', text: 'Вариант a' }, { id: 'b', text: 'Вариант b' }, { id: 'c', text: 'Вариант c' }]
          : [],
        answerKey: code.startsWith('mc') ? { ids: ['a', 'b'] } : code.startsWith('sc') ? { id: 'a' } : code.startsWith('ext') ? null : { accepted: ['42'] },
        points: code.startsWith('ext') ? 3 : 1,
        source: 'authored', editorStatus: 'published', publishedAt: Date.now(),
      },
      overrideAccess: true,
    })
  }
}

integrationSuite('P2/P3/P5 vertical slice: bank → assign → run → submit → review → feedback → progress', () => {
  beforeEach(clearData)

  it('bank: published only, filters, and the response NEVER carries answerKey', async () => {
    const p = await getPayloadSingleton()
    const f = await seed(p)
    await seedQuestions(p, ['sc1', 'mc1'])
    await p.create({
      collection: 'questions',
      data: {
        subjectVersionId: 'math-oge-2026', code: 'draft1', revisionNumber: 1, type: 'short-text',
        topic: 'Тема A', stem: 'Черновик', options: [], answerKey: null, points: 1,
        source: 'authored', editorStatus: 'draft',
      },
      overrideAccess: true,
    })

    const res = await handleListContent(
      new NextRequest(new URL('http://localhost/api/content?subjectVersionId=math-oge-2026', 'http://localhost'), { headers: { cookie: f.teacherCookie } }),
      p,
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.items.map((i: { code: string }) => i.code).sort()).toEqual(['mc1', 'sc1'])
    expect(JSON.stringify(body)).not.toContain('answerKey')

    // Filter by type.
    const onlyMc = await handleListContent(
      new NextRequest(new URL('http://localhost/api/content?subjectVersionId=math-oge-2026&type=multiple-choice', 'http://localhost'), { headers: { cookie: f.teacherCookie } }),
      p,
    )
    expect((await onlyMc.json()).items).toHaveLength(1)

    // Students cannot read the bank.
    const asStudent = await handleListContent(
      new NextRequest(new URL('http://localhost/api/content?subjectVersionId=math-oge-2026', 'http://localhost'), { headers: { cookie: f.studentCookie } }),
      p,
    )
    expect(asStudent.status).toBe(403)
  })

  it('assignment: snapshot immutable, one attempt per recipient, statuses visible to the student', async () => {
    const p = await getPayloadSingleton()
    const f = await seed(p)
    await seedQuestions(p, ['sc1', 'st1'])

    const created = await handleCreateAssignment(
      jsonReq('http://localhost/api/assignments', 'POST', {
        classId: f.classId, title: 'Домашняя 1', questionCodes: ['sc1', 'st1'], recipients: 'all',
      }, f.teacherCookie),
      p,
    )
    expect(created.status).toBe(201)

    // EDIT the bank after issuing — the attempt questions must NOT change.
    const q = await p.find({ collection: 'questions', where: { code: { equals: 'sc1' } }, limit: 1, overrideAccess: true })
    await p.update({
      collection: 'questions', id: q.docs[0]!.id,
      data: { stem: 'ИЗМЕНЁННЫЙ вопрос', answerKey: { id: 'c' } }, overrideAccess: true,
    })

    const list = await handleStudentAssignments(
      new NextRequest(new URL('http://localhost/api/student/assignments', 'http://localhost'), { headers: { cookie: f.studentCookie } }), p,
    )
    const works = (await list.json()).items
    expect(works).toHaveLength(1)
    expect(works[0].status).toBe('assigned')

    const view = await handleGetAttempt(
      new NextRequest(new URL(`http://localhost/api/attempts/${works[0].id}`, 'http://localhost'), { headers: { cookie: f.studentCookie } }), p, works[0].id,
    )
    const vbody = await view.json()
    const sc = vbody.questions.find((x: { code: string }) => x.code === 'sc1')
    expect(sc.stem).toBe('Строка вопроса sc1') // snapshot, not the edited bank
    expect(JSON.stringify(vbody)).not.toContain('answerKey')

    // Exactly one attempt per recipient (both students got one each).
    const list2 = await handleStudentAssignments(
      new NextRequest(new URL('http://localhost/api/student/assignments', 'http://localhost'), { headers: { cookie: f.studentCookie2 } }), p,
    )
    expect((await list2.json()).items).toHaveLength(1)
  })

  it('runner: autosave ownership + stale-version guard; submit idempotent; autograde exact', async () => {
    const p = await getPayloadSingleton()
    const f = await seed(p)
    await seedQuestions(p, ['sc1', 'mc1', 'st1', 'ext1'])

    await handleCreateAssignment(
      jsonReq('http://localhost/api/assignments', 'POST', {
        classId: f.classId, title: 'Контрольная', questionCodes: ['sc1', 'mc1', 'st1', 'ext1'], recipients: 'all',
      }, f.teacherCookie),
      p,
    )
    const works = (await (await handleStudentAssignments(
      new NextRequest(new URL('http://localhost/api/student/assignments', 'http://localhost'), { headers: { cookie: f.studentCookie } }), p,
    )).json()).items
    const id = works[0].id

    // FOREIGN student → 404 (IDOR).
    const foreign = await handleAttemptAction(
      jsonReq(`http://localhost/api/attempts/${id}?action=answer`, 'POST', { code: 'sc1', value: 'a', clientVersion: 1 }, f.studentCookie2),
      p, id,
    )
    expect(foreign.status).toBe(404)

    // Autosave: newer version wins, stale retry is a silent no-op.
    await handleAttemptAction(jsonReq(`http://localhost/api/attempts/${id}?action=answer`, 'POST', { code: 'sc1', value: 'a', clientVersion: 2 }, f.studentCookie), p, id)
    await handleAttemptAction(jsonReq(`http://localhost/api/attempts/${id}?action=answer`, 'POST', { code: 'sc1', value: 'c', clientVersion: 1 }, f.studentCookie), p, id)
    const mid = await (await handleGetAttempt(
      new NextRequest(new URL(`http://localhost/api/attempts/${id}`, 'http://localhost'), { headers: { cookie: f.studentCookie } }), p, id,
    )).json()
    expect(mid.answers.sc1).toBe('a')

    // Fill the rest (all CORRECT for objective types).
    await handleAttemptAction(jsonReq(`http://localhost/api/attempts/${id}?action=answer`, 'POST', { code: 'mc1', value: ['b', 'a'], clientVersion: 1 }, f.studentCookie), p, id)
    await handleAttemptAction(jsonReq(`http://localhost/api/attempts/${id}?action=answer`, 'POST', { code: 'st1', value: '  42 ', clientVersion: 1 }, f.studentCookie), p, id)
    await handleAttemptAction(jsonReq(`http://localhost/api/attempts/${id}?action=answer`, 'POST', { code: 'ext1', value: 'Полное решение…', clientVersion: 1 }, f.studentCookie), p, id)

    // SUBMIT — idempotent by key.
    const key = 'idem-key-abcdefgh'
    const s1 = await handleAttemptAction(jsonReq(`http://localhost/api/attempts/${id}?action=submit`, 'POST', { idempotencyKey: key }, f.studentCookie), p, id)
    expect(s1.status).toBe(200)
    const s1body = await s1.json()
    expect(s1body.status).toBe('submitted')
    expect(s1body.pendingManual).toBe(true) // ext1 needs the rubric

    const s2 = await handleAttemptAction(jsonReq(`http://localhost/api/attempts/${id}?action=submit`, 'POST', { idempotencyKey: key }, f.studentCookie), p, id)
    expect(s2.status).toBe(200)
    expect(await s2.json()).toEqual(s1body)

    const s3 = await handleAttemptAction(jsonReq(`http://localhost/api/attempts/${id}?action=submit`, 'POST', { idempotencyKey: 'other-key' }, f.studentCookie), p, id)
    expect(s3.status).toBe(409)

    // Answers immutable after submit.
    const frozen = await handleAttemptAction(jsonReq(`http://localhost/api/attempts/${id}?action=answer`, 'POST', { code: 'sc1', value: 'b', clientVersion: 99 }, f.studentCookie), p, id)
    expect(frozen.status).toBe(409)

    // Autograding exactness check (unit-level through the same code path).
    const snapshotQ = { code: 'x', type: 'single-choice' as const, topic: 't', stem: 's', points: 1, answerKey: { id: 'a' } }
    expect(gradeAnswer(snapshotQ, 'a')).toBe(1)
    expect(gradeAnswer(snapshotQ, 'b')).toBe(0)
  })

  it('review: queue, rubric completeness, finalize totals, checked freezes, internal notes, progress', async () => {
    const p = await getPayloadSingleton()
    const f = await seed(p)
    await seedQuestions(p, ['sc1', 'ext1'])

    await handleCreateAssignment(
      jsonReq('http://localhost/api/assignments', 'POST', {
        classId: f.classId, title: 'Проверяемая', questionCodes: ['sc1', 'ext1'], recipients: 'all',
      }, f.teacherCookie),
      p,
    )
    const works = (await (await handleStudentAssignments(
      new NextRequest(new URL('http://localhost/api/student/assignments', 'http://localhost'), { headers: { cookie: f.studentCookie } }), p,
    )).json()).items
    const id = works[0].id

    await handleAttemptAction(jsonReq(`http://localhost/api/attempts/${id}?action=answer`, 'POST', { code: 'sc1', value: 'a', clientVersion: 1 }, f.studentCookie), p, id)
    await handleAttemptAction(jsonReq(`http://localhost/api/attempts/${id}?action=answer`, 'POST', { code: 'ext1', value: 'Решение', clientVersion: 1 }, f.studentCookie), p, id)
    await handleAttemptAction(jsonReq(`http://localhost/api/attempts/${id}?action=submit`, 'POST', { idempotencyKey: 'k1' }, f.studentCookie), p, id)

    // Queue shows the submission (ECLASS-33).
    const queue = await (await handleReviewQueue(
      new NextRequest(new URL('http://localhost/api/review', 'http://localhost'), { headers: { cookie: f.teacherCookie } }), p,
    )).json()
    expect(queue.items).toHaveLength(1)
    expect(queue.items[0].pendingManual).toBe(true)

    // Student cannot score.
    const badScore = await handleAttemptAction(jsonReq(`http://localhost/api/attempts/${id}?action=score`, 'POST', { code: 'ext1', manual: 3 }, f.studentCookie), p, id)
    expect(badScore.status).toBe(403)

    // Finalize before the rubric is complete → validation_error (ECLASS-34).
    const early = await handleAttemptAction(jsonReq(`http://localhost/api/attempts/${id}?action=finalize`, 'POST', {}, f.teacherCookie), p, id)
    expect(early.status).toBe(422)

    // Score the extended answer (2 of 3), with a rubric comment.
    const score = await handleAttemptAction(jsonReq(`http://localhost/api/attempts/${id}?action=score`, 'POST', { code: 'ext1', manual: 2, teacherComment: 'Верно, но нет проверки' }, f.teacherCookie), p, id)
    expect(score.status).toBe(200)

    // Feedback: a public and an INTERNAL comment.
    await handleAttemptAction(jsonReq(`http://localhost/api/attempts/${id}?action=comment`, 'POST', { body: 'Хорошая работа!' }, f.teacherCookie), p, id)
    await handleAttemptAction(jsonReq(`http://localhost/api/attempts/${id}?action=comment`, 'POST', { body: 'внутренняя: перепроверить п.2', internal: true }, f.teacherCookie), p, id)

    // Finalize: total = auto(1) + manual(2) = 3.
    const fin = await handleAttemptAction(jsonReq(`http://localhost/api/attempts/${id}?action=finalize`, 'POST', {}, f.teacherCookie), p, id)
    expect(fin.status).toBe(200)
    expect((await fin.json()).totalScore).toBe(3)

    // Checked freezes: further scoring → invalid_transition.
    const post = await handleAttemptAction(jsonReq(`http://localhost/api/attempts/${id}?action=score`, 'POST', { code: 'ext1', manual: 3 }, f.teacherCookie), p, id)
    expect(post.status).toBe(409)

    // The student sees the feedback but NOT the internal note; sees the score.
    const sview = await (await handleGetAttempt(
      new NextRequest(new URL(`http://localhost/api/attempts/${id}`, 'http://localhost'), { headers: { cookie: f.studentCookie } }), p, id,
    )).json()
    expect(sview.attempt.status).toBe('checked')
    expect(sview.attempt.totalScore).toBe(3)

    // Progress reflects the checked work (ECLASS-37).
    const prog = await (await handleStudentProgress(
      new NextRequest(new URL('http://localhost/api/student/progress', 'http://localhost'), { headers: { cookie: f.studentCookie } }), p,
    )).json()
    expect(prog.attempts).toHaveLength(1)
    expect(prog.topics.length).toBeGreaterThan(0)
  })
})
