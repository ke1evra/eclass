/**
 * Attempt service — ECLASS-27/28/29/33/34/35/36/37.
 *
 * Invariants enforced here (and proven in integration tests):
 *   - student reads/writes ONLY their own attempt (attempts keyed by studentId
 *     from the session Actor; never from the wire);
 *   - the student payload NEVER contains answerKey (stripped by construction);
 *   - autosave is versioned: a stale clientVersion loses silently (two devices
 *     never overwrite newer work);
 *   - submit is idempotent (the client key is consumed once; replay returns
 *     the same outcome) and grading runs SERVER-side against the snapshot;
 *   - after submit the answers are immutable; teacher scoring/finalize is
 *     owner-only; checked freezes everything.
 */
import type { Payload } from 'payload'
import type { Actor } from '@/domain/authorization'

export interface SnapshotQuestion {
  code: string
  type: 'single-choice' | 'multiple-choice' | 'short-text' | 'extended-text'
  topic: string
  stem: string
  options?: { id: string; text: string }[] | null
  answerKey?: unknown
  points: number
}

export type AttemptResult<T> = ({ ok: true } & T) | { ok: false; code: string }

const normalizeText = (v: string): string =>
  v.trim().toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ')

/** Server-side autograding against the snapshot (ECLASS-29 + ECLASS-33). */
export function gradeAnswer(q: SnapshotQuestion, value: unknown): number | null {
  if (q.type === 'single-choice') {
    const key = (q.answerKey as { id?: string } | null)?.id
    return typeof value === 'string' && value === key ? q.points : 0
  }
  if (q.type === 'multiple-choice') {
    const key = ((q.answerKey as { ids?: string[] } | null)?.ids ?? []).slice().sort()
    const got = Array.isArray(value) ? value.slice().sort() : []
    return key.length === got.length && key.every((k, i) => got[i] === k) ? q.points : 0
  }
  if (q.type === 'short-text') {
    const accepted = (q.answerKey as { accepted?: string[] } | null)?.accepted ?? []
    if (typeof value !== 'string') return 0
    const norm = normalizeText(value)
    return accepted.some((a) => normalizeText(a) === norm) ? q.points : 0
  }
  return null // extended-text → manual rubric review
}

async function loadAttempt(payload: Payload, attemptId: string) {
  const res = await payload.find({
    collection: 'attempts',
    where: { id: { equals: attemptId } },
    limit: 1,
    overrideAccess: true,
  })
  return res.docs[0] as
    | (Record<string, unknown> & {
        id: string
        assignmentId: string
        classId: string
        ownerId: string
        studentId: string
        title: string
        dueAt?: number | null
        subjectVersionId: string
        status: 'assigned' | 'in_progress' | 'submitted' | 'checked'
        answers: { code: string; value?: unknown; attachmentIds?: { id: string }[]; clientVersion?: number; savedAt?: number }[]
        scores?: { code: string; auto?: number | null; manual?: number | null; teacherComment?: string; flaggedForReview?: boolean }[]
        totalScore?: number | null
        maxScore?: number | null
        submittedAt?: number | null
        checkedAt?: number | null
        idempotencyKey?: string | null
        comments?: { authorId: string; authorRole: 'teacher' | 'student'; internal?: boolean; body: string; createdAt: number }[]
        createdAt: number
      })
    | undefined
}

async function loadSnapshot(payload: Payload, assignmentId: string): Promise<SnapshotQuestion[]> {
  const res = await payload.find({
    collection: 'assignments',
    where: { id: { equals: assignmentId } },
    limit: 1,
    overrideAccess: true,
  })
  const a = res.docs[0] as unknown as { questionSnapshot?: SnapshotQuestion[] } | undefined
  return a?.questionSnapshot ?? []
}

export function createAttemptsService(payload: Payload) {
  const assertStudentOwns = async (actor: Actor, attemptId: string) => {
    if (actor.role !== 'student') return { ok: false as const, code: 'forbidden' }
    const at = await loadAttempt(payload, attemptId)
    if (!at) return { ok: false as const, code: 'not_found' }
    if (at.studentId !== actor.id) return { ok: false as const, code: 'not_found' }
    return { ok: true as const, at }
  }

  const assertTeacherOwns = async (actor: Actor, attemptId: string) => {
    if (actor.role !== 'teacher') return { ok: false as const, code: 'forbidden' }
    const at = await loadAttempt(payload, attemptId)
    if (!at) return { ok: false as const, code: 'not_found' }
    if (at.ownerId !== actor.id) return { ok: false as const, code: 'not_found' }
    return { ok: true as const, at }
  }

  return {
    /** Student's own dashboard list (S2): statuses, due, next-step (ECLASS-27). */
    async listForStudent(studentId: string) {
      const res = await payload.find({
        collection: 'attempts',
        where: { studentId: { equals: studentId } },
        limit: 100,
        overrideAccess: true,
        sort: '-createdAt',
      })
      return (res.docs as unknown as Awaited<ReturnType<typeof loadAttempt>>[]).map((a) => ({
        id: a!.id,
        title: a!.title,
        status: a!.status,
        dueAt: a!.dueAt ?? null,
        maxScore: a!.maxScore ?? null,
        totalScore: a!.status === 'checked' ? (a!.totalScore ?? null) : null,
        submittedAt: a!.submittedAt ?? null,
      }))
    },

    /** Student view of one attempt: questions WITHOUT answer keys. */
    async studentView(actor: Actor, attemptId: string): Promise<
      AttemptResult<{
        attempt: {
          id: string
          title: string
          status: string
          dueAt: number | null
          maxScore: number | null
          totalScore: number | null
          submittedAt: number | null
        }
        questions: { code: string; type: string; topic: string; stem: string; options: { id: string; text: string }[]; points: number }[]
        answers: Record<string, unknown>
        attachmentIds: Record<string, string[]>
      }>
    > {
      const own = await assertStudentOwns(actor, attemptId)
      if (!own.ok) return own
      const snapshot = await loadSnapshot(payload, own.at.assignmentId)
      const answers: Record<string, unknown> = {}
      const attachmentIds: Record<string, string[]> = {}
      for (const a of own.at.answers ?? []) {
        const v = (a.value as { v?: unknown } | null | undefined)?.v
        if (v !== undefined && v !== null) answers[a.code] = v
        if (a.attachmentIds?.length) attachmentIds[a.code] = a.attachmentIds.map((x) => x.id)
      }
      return {
        ok: true,
        attempt: {
          id: own.at.id,
          title: own.at.title,
          status: own.at.status,
          dueAt: own.at.dueAt ?? null,
          maxScore: own.at.maxScore ?? null,
          totalScore: own.at.status === 'checked' ? (own.at.totalScore ?? null) : null,
          submittedAt: own.at.submittedAt ?? null,
        },
        questions: snapshot.map((q) => ({
          code: q.code,
          type: q.type,
          topic: q.topic,
          stem: q.stem,
          options: q.options ?? [],
          points: q.points,
        })),
        answers,
        attachmentIds,
      }
    },

    /** Autosave one answer (ECLASS-28): ≤2s debounce lives client-side, the
     * stale-version guard lives HERE (two devices never overwrite newer). */
    async saveAnswer(
      actor: Actor,
      attemptId: string,
      input: { code: string; value?: unknown; attachmentIds?: string[]; clientVersion: number },
    ): Promise<AttemptResult<{ saved: true }>> {
      const own = await assertStudentOwns(actor, attemptId)
      if (!own.ok) return own
      if (own.at.status === 'submitted' || own.at.status === 'checked') {
        return { ok: false, code: 'already_submitted' }
      }
      if (!input.code) return { ok: false, code: 'validation_error' }
      const snapshot = await loadSnapshot(payload, own.at.assignmentId)
      if (!snapshot.some((q) => q.code === input.code)) return { ok: false, code: 'not_found' }

      const answers: { code: string; value?: unknown; attachmentIds?: { id: string }[]; clientVersion?: number; savedAt?: number }[] = [
        ...(own.at.answers ?? []),
      ]
      const idx = answers.findIndex((a) => a.code === input.code)
      const existing = idx >= 0 ? answers[idx]! : undefined
      if (existing && (existing.clientVersion ?? 0) >= input.clientVersion) {
        return { ok: true, saved: true } // stale device — newer work wins
      }
      const updated = {
        code: input.code,
        // Payload json fields reject bare scalars — wrap (unwrap on read).
        value: { v: input.value ?? null } as never,
        attachmentIds: (input.attachmentIds ?? existing?.attachmentIds?.map((x) => x.id) ?? []).map((id) => ({ id })),
        clientVersion: input.clientVersion,
        savedAt: Date.now(),
      }
      if (idx >= 0) answers[idx] = updated
      else answers.push(updated)

      await payload.update({
        collection: 'attempts',
        id: own.at.id,
        data: { answers: answers as unknown as never, status: 'in_progress' },
        overrideAccess: true,
      })
      return { ok: true, saved: true }
    },

    /** Idempotent submit + autograde (ECLASS-29). */
    async submit(
      actor: Actor,
      attemptId: string,
      idempotencyKey: string,
    ): Promise<AttemptResult<{ status: string; totalScore: number | null; pendingManual: boolean }>> {
      const own = await assertStudentOwns(actor, attemptId)
      if (!own.ok) return own
      const at = own.at

      if (at.status === 'submitted' || at.status === 'checked') {
        // Idempotent replay: same key → same outcome; different key → conflict.
        if (at.idempotencyKey && at.idempotencyKey === idempotencyKey) {
          return {
            ok: true,
            status: at.status,
            totalScore: at.totalScore ?? null,
            pendingManual: (at.scores ?? []).some((s) => s.auto === null && s.manual == null),
          }
        }
        return { ok: false, code: 'already_submitted' }
      }

      const snapshot = await loadSnapshot(payload, at.assignmentId)
      const scores = snapshot.map((q) => {
        const answer = (at.answers ?? []).find((a) => a.code === q.code)
        const auto = gradeAnswer(q, (answer?.value as { v?: unknown } | null | undefined)?.v)
        return {
          code: q.code,
          auto,
          manual: null,
          teacherComment: null,
          flaggedForReview: q.type === 'extended-text',
        }
      })
      const answeredAll = snapshot.every((q) => {
        const a = (at.answers ?? []).find((x) => x.code === q.code)
        const v = (a?.value as { v?: unknown } | null | undefined)?.v
        return a && (v !== null && v !== undefined || a.attachmentIds?.length)
      })
      void answeredAll // unanswered questions are allowed — graded as wrong

      const autoTotal = scores.reduce((sum, s) => sum + (s.auto ?? 0), 0)
      const hasManual = scores.some((s) => s.auto === null)
      await payload.update({
        collection: 'attempts',
        id: at.id,
        data: {
          status: 'submitted',
          submittedAt: Date.now(),
          idempotencyKey,
          scores,
          totalScore: hasManual ? null : autoTotal,
        },
        overrideAccess: true,
      })
      return { ok: true, status: 'submitted', totalScore: hasManual ? null : autoTotal, pendingManual: hasManual }
    },

    /** Teacher review queue (ECLASS-33): submitted attempts of MY classes. */
    async reviewQueue(actor: Actor) {
      if (actor.role !== 'teacher') return []
      const res = await payload.find({
        collection: 'attempts',
        where: { and: [{ ownerId: { equals: actor.id } }, { status: { equals: 'submitted' } }] },
        limit: 100,
        overrideAccess: true,
        sort: 'submittedAt',
      })
      return (res.docs as unknown as Awaited<ReturnType<typeof loadAttempt>>[]).map((a) => ({
        id: a!.id,
        title: a!.title,
        studentId: a!.studentId,
        submittedAt: a!.submittedAt ?? 0,
        maxScore: a!.maxScore ?? 0,
        pendingManual: (a!.scores ?? []).some((s) => s.auto === null && s.manual == null),
      }))
    },

    /** Teacher full view: answers + answer keys + current scores. */
    async teacherView(actor: Actor, attemptId: string) {
      const own = await assertTeacherOwns(actor, attemptId)
      if (!own.ok) return own
      const snapshot = await loadSnapshot(payload, own.at.assignmentId)
      return {
        ok: true as const,
        attempt: own.at,
        snapshot,
        studentAnswers: Object.fromEntries(
          (own.at.answers ?? []).map((a) => [a.code, { value: (a.value as { v?: unknown } | null | undefined)?.v ?? null, attachmentIds: a.attachmentIds ?? [] }]),
        ),
      }
    },

    /** Rubric scoring (ECLASS-34): owner-only, before/at checked. */
    async score(
      actor: Actor,
      attemptId: string,
      input: { code: string; manual: number; teacherComment?: string },
    ): Promise<AttemptResult<{ saved: true }>> {
      const own = await assertTeacherOwns(actor, attemptId)
      if (!own.ok) return own
      if (own.at.status !== 'submitted') return { ok: false, code: 'invalid_transition' }
      const snapshot = await loadSnapshot(payload, own.at.assignmentId)
      const q = snapshot.find((s) => s.code === input.code)
      if (!q) return { ok: false, code: 'not_found' }
      if (input.manual < 0 || input.manual > q.points) return { ok: false, code: 'validation_error' }

      const scores = [...(own.at.scores ?? [])]
      const idx = scores.findIndex((s) => s.code === input.code)
      if (idx < 0) {
        scores.push({ code: input.code, auto: null, manual: input.manual, teacherComment: input.teacherComment ?? undefined, flaggedForReview: true })
      } else {
        scores[idx] = {
          ...scores[idx]!,
          manual: input.manual,
          teacherComment: input.teacherComment ?? scores[idx]!.teacherComment ?? undefined,
        }
      }
      await payload.update({ collection: 'attempts', id: own.at.id, data: { scores: scores as unknown as never }, overrideAccess: true })
      return { ok: true, saved: true }
    },

    /** Finalize (ECLASS-34): total = auto + manual; status=checked; frozen. */
    async finalize(actor: Actor, attemptId: string): Promise<AttemptResult<{ totalScore: number }>> {
      const own = await assertTeacherOwns(actor, attemptId)
      if (!own.ok) return own
      if (own.at.status !== 'submitted') return { ok: false, code: 'invalid_transition' }
      const snapshot = await loadSnapshot(payload, own.at.assignmentId)
      const byCode = new Map(snapshot.map((q) => [q.code, q]))
      const scores = own.at.scores ?? []
      if (snapshot.some((q) => byCode.get(q.code)?.type === 'extended-text' && scores.find((s) => s.code === q.code)?.manual == null)) {
        return { ok: false, code: 'validation_error' } // rubric incomplete
      }
      const total = scores.reduce((sum, s) => sum + (s.auto ?? 0) + (s.manual ?? 0), 0)
      await payload.update({
        collection: 'attempts',
        id: own.at.id,
        data: { status: 'checked', checkedAt: Date.now(), totalScore: total },
        overrideAccess: true,
      })
      return { ok: true, totalScore: total }
    },

    /** Feedback thread (ECLASS-35): internal notes stay teacher-only. */
    async addComment(
      actor: Actor,
      attemptId: string,
      input: { body: string; internal?: boolean },
    ): Promise<AttemptResult<{ saved: true }>> {
      if (!input.body.trim()) return { ok: false, code: 'validation_error' }
      if (actor.role === 'student') {
        const own = await assertStudentOwns(actor, attemptId)
        if (!own.ok) return own
        const comments = [...(own.at.comments ?? []), {
          authorId: actor.id, authorRole: 'student' as const, internal: false, body: input.body.trim(), createdAt: Date.now(),
        }]
        await payload.update({ collection: 'attempts', id: own.at.id, data: { comments: comments as unknown as never }, overrideAccess: true })
        return { ok: true, saved: true }
      }
      const own = await assertTeacherOwns(actor, attemptId)
      if (!own.ok) return own
      const comments = [...(own.at.comments ?? []), {
        authorId: actor.id, authorRole: 'teacher' as const, internal: Boolean(input.internal), body: input.body.trim(), createdAt: Date.now(),
      }]
      await payload.update({ collection: 'attempts', id: own.at.id, data: { comments: comments as unknown as never }, overrideAccess: true })
      return { ok: true, saved: true }
    },

    /** Comments for a viewer: students never see internal teacher notes. */
    async commentsFor(actor: Actor, attemptId: string) {
      const at =
        actor.role === 'student'
          ? (await assertStudentOwns(actor, attemptId)).at
          : (await assertTeacherOwns(actor, attemptId)).at
      if (!at) return null
      return (at.comments ?? []).filter((c) => !(c.internal && actor.role === 'student'))
    },

    /** Mastery by topic + trend (ECLASS-37) from the student's checked work. */
    async progress(studentId: string) {
      const res = await payload.find({
        collection: 'attempts',
        where: { and: [{ studentId: { equals: studentId } }, { status: { equals: 'checked' } }] },
        limit: 100,
        overrideAccess: true,
        sort: 'checkedAt',
      })
      const byTopic = new Map<string, { earned: number; max: number }>()
      for (const doc of res.docs as unknown as NonNullable<Awaited<ReturnType<typeof loadAttempt>>>[]) {
        const snapshot = await loadSnapshot(payload, doc.assignmentId)
        const byCode = new Map(snapshot.map((q) => [q.code, q]))
        for (const s of doc.scores ?? []) {
          const q = byCode.get(s.code)
          if (!q) continue
          const cur = byTopic.get(q.topic) ?? { earned: 0, max: 0 }
          cur.earned += (s.auto ?? 0) + (s.manual ?? 0)
          cur.max += q.points
          byTopic.set(q.topic, cur)
        }
      }
      const items = [...byTopic.entries()].map(([topic, v]) => ({
        topic,
        earned: v.earned,
        max: v.max,
        percent: v.max ? Math.round((v.earned / v.max) * 100) : 0,
      }))
      const attempts = (res.docs as unknown as { id: string; title: string; totalScore?: number | null; maxScore?: number | null; checkedAt?: number | null }[]).map((d) => ({
        id: d.id,
        title: d.title,
        totalScore: d.totalScore ?? 0,
        maxScore: d.maxScore ?? 0,
        checkedAt: d.checkedAt ?? 0,
      }))
      return { topics: items, attempts }
    },

    /** Remediation (ECLASS-36): new work from the failed topics' questions. */
    async remediation(
      actor: Actor,
      attemptId: string,
      pickQuestions: (candidates: { code: string; topic: string }[], failedTopics: string[]) => string[],
    ): Promise<AttemptResult<{ assignmentId: string } | { reused: true }>> {
      const own = await assertTeacherOwns(actor, attemptId)
      if (!own.ok) return own
      if (own.at.status !== 'checked') return { ok: false, code: 'invalid_transition' }
      const snapshot = await loadSnapshot(payload, own.at.assignmentId)
      const byCode = new Map(snapshot.map((q) => [q.code, q]))
      const failedTopics = [...new Set(
        (own.at.scores ?? [])
          .filter((s) => {
            const q = byCode.get(s.code)
            if (!q) return false
            const earned = (s.auto ?? 0) + (s.manual ?? 0)
            return earned < q.points
          })
          .map((s) => byCode.get(s.code)!.topic),
      )]
      if (failedTopics.length === 0) return { ok: false, code: 'validation_error' } // nothing to remediate

      const bank = await payload.find({
        collection: 'questions',
        where: {
          subjectVersionId: { equals: own.at.subjectVersionId },
          editorStatus: { equals: 'published' },
          topic: { in: failedTopics },
          code: { not_in: snapshot.map((q) => q.code) },
        },
        limit: 50,
        overrideAccess: true,
      })
      const candidates = (bank.docs as unknown as { code: string; topic: string }[])
      const chosen = pickQuestions(candidates, failedTopics)
      if (chosen.length === 0) return { ok: false, code: 'question_not_found' }

      const { createAndAssign } = await import('@/assignments/service')
      return createAndAssign(payload, {
        ownerId: actor.id,
        classId: own.at.classId,
        title: `Работа над ошибками: ${own.at.title}`,
        questionCodes: chosen,
        recipientIds: [own.at.studentId],
        dueAt: null,
        subjectVersionId: own.at.subjectVersionId,
      })
    },
  }
}
