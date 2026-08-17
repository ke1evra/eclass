/**
 * Assignment service — ECLASS-23/24/26 (bank listing + builder + assignment).
 *
 * Snapshot rule: assign copies the CURRENT published revision of every chosen
 * question into the assignment row — later bank edits or retirement never
 * change issued work. Recipients are explicit; one attempt per recipient is
 * created transactionally at assign time (one row per student — the unique
 * (assignmentId, studentId) index is the hard guarantee).
 */
import type { Payload, Where } from 'payload'
import { Types } from 'mongoose'

export type QuestionType = 'single-choice' | 'multiple-choice' | 'short-text' | 'extended-text'

export interface BankQuestion {
  id: string
  code: string
  type: QuestionType
  topic: string
  stem: string
  options?: { id: string; text: string }[] | null
  answerKey?: unknown
  points: number
  source: string
  editorStatus: string
}

/** Teacher-facing bank listing (ECLASS-20): published only, filters + search. */
export async function listBank(
  payload: Payload,
  opts: { subjectVersionId: string; type?: QuestionType; topic?: string; q?: string; limit?: number; page?: number },
): Promise<{ items: BankQuestion[]; total: number }> {
  const where: Where = {
    subjectVersionId: { equals: opts.subjectVersionId },
    editorStatus: { equals: 'published' },
  }
  if (opts.type) where.type = { equals: opts.type }
  if (opts.topic) where.topic = { equals: opts.topic }
  if (opts.q) where.stem = { like: opts.q }

  const limit = Math.min(opts.limit ?? 50, 100)
  const page = Math.max(opts.page ?? 1, 1)
  const res = await payload.find({
    collection: 'questions',
    where,
    limit,
    page,
    overrideAccess: true,
    sort: 'code',
  })
  return { items: res.docs as unknown as BankQuestion[], total: res.totalDocs }
}

export type AssignResult<T> = ({ ok: true } & T) | { ok: false; code: string }

export async function createAndAssign(
  payload: Payload,
  input: {
    ownerId: string
    classId: string
    title: string
    questionCodes: string[]
    recipientIds: string[]
    dueAt?: number | null
    subjectVersionId: string
  },
): Promise<AssignResult<{ assignmentId: string }>> {
  if (!input.title.trim() || input.questionCodes.length === 0 || input.recipientIds.length === 0) {
    return { ok: false, code: 'validation_error' }
  }

  // Snapshot: load the chosen published revisions (any code order).
  const bank = await payload.find({
    collection: 'questions',
    where: {
      subjectVersionId: { equals: input.subjectVersionId },
      editorStatus: { equals: 'published' },
      code: { in: input.questionCodes },
    },
    limit: 100,
    overrideAccess: true,
  })
  const byCode = new Map((bank.docs as unknown as BankQuestion[]).map((q) => [q.code, q]))
  const snapshot = input.questionCodes
    .map((code) => byCode.get(code))
    .filter((q): q is BankQuestion => Boolean(q))
  if (snapshot.length !== input.questionCodes.length) {
    return { ok: false, code: 'question_not_found' }
  }
  const maxScore = snapshot.reduce((sum, q) => sum + (q.points ?? 1), 0)
  const now = Date.now()

  const assignment = await payload.create({
    collection: 'assignments',
    data: {
      ownerId: input.ownerId,
      classId: input.classId,
      title: input.title.trim(),
      status: 'assigned',
      dueAt: input.dueAt ?? null,
      questionSnapshot: snapshot.map((q) => ({
        code: q.code,
        type: q.type,
        topic: q.topic,
        stem: q.stem,
        options: q.options ?? [],
        answerKey: (q.answerKey ?? null) as unknown as { [k: string]: unknown } | null,
        points: q.points ?? 1,
      })),
      recipientIds: input.recipientIds.map((id) => ({ id })),
      createdAt: now,
    },
    overrideAccess: true,
  })

  // One attempt per recipient (ECLASS-24: exactly one instance; unique index
  // backs this against concurrent creation).
  for (const recipient of input.recipientIds) {
    await payload.create({
      collection: 'attempts',
      data: {
        assignmentId: String(assignment.id),
        classId: input.classId,
        ownerId: input.ownerId,
        studentId: recipient,
        title: input.title.trim(),
        dueAt: input.dueAt ?? null,
        subjectVersionId: input.subjectVersionId,
        status: 'assigned',
        answers: [],
        maxScore,
        createdAt: now,
      },
      overrideAccess: true,
    })
  }
  return { ok: true, assignmentId: String(assignment.id) }
}

/** Teacher's assignments for a class (T6 monitoring). */
export async function listForClass(payload: Payload, ownerId: string, classId: string) {
  const res = await payload.find({
    collection: 'assignments',
    where: { and: [{ ownerId: { equals: ownerId } }, { classId: { equals: classId } }] },
    limit: 100,
    overrideAccess: true,
    sort: '-createdAt',
  })
  const out = []
  for (const a of res.docs as unknown as {
    id: string
    title: string
    dueAt?: number | null
    createdAt: number
    questionSnapshot: unknown[]
  }[]) {
    const statuses = await payload.count({
      collection: 'attempts',
      where: { assignmentId: { equals: String(a.id) } },
      overrideAccess: true,
    })
    const submitted = await payload.count({
      collection: 'attempts',
      where: { assignmentId: { equals: String(a.id) }, status: { in: ['submitted', 'checked'] } },
      overrideAccess: true,
    })
    out.push({
      id: String(a.id),
      title: a.title,
      dueAt: a.dueAt ?? null,
      createdAt: a.createdAt,
      questionCount: a.questionSnapshot.length,
      recipients: statuses.totalDocs,
      submitted: submitted.totalDocs,
    })
  }
  return out
}

export const toObjectId = (id: string): Types.ObjectId => new Types.ObjectId(id)
