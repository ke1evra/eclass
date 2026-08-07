/**
 * Content versioning service — ECLASS-18 (TDD-P2-01).
 *
 * The taxonomy + versioning core for the ФИПИ content bank. Encodes:
 *
 *   - SubjectVersion: a (subject, exam, academicYear) tuple is unique. ОГЭ and
 *     ЕГЭ of the same subject/year are distinct versions; a second subject is
 *     just another row, never a fork (acceptance: no hardcoding).
 *   - Published question revisions are IMMUTABLE. Fixing content creates a new
 *     revision (new id, same code, bumped revisionNumber); the old revision
 *     stays so already-issued submissions keep their reference.
 *   - Topics are soft-deleted: `deletedAt` is set, but the row remains so
 *     historical work stays linked and queryable.
 */
import { randomBytes } from 'node:crypto'
import { canPublishQuestion, type ContentSource, type EditorStatus } from '@/domain/content-policy'
import type { QuestionType } from '../api/contracts'
import type { z } from 'zod'

type QuestionTypeValue = z.infer<typeof QuestionType>

export interface Clock {
  now(): number
}

export interface SubjectVersion {
  id: string
  subject: string
  exam: 'oge' | 'ege'
  academicYear: number
  codifierUrl: string
  createdAt: number
}

export interface ExamSpec {
  id: string
  subjectVersionId: string
  totalTasks: number
  maxPrimaryScore: number
}

export interface Topic {
  id: string
  subjectVersionId: string
  code: string
  title: string
  deletedAt: number | null
}

export interface QuestionRevision {
  id: string
  subjectVersionId: string
  /** Stable ФИПИ code — constant across revisions of the same task. */
  code: string
  revisionNumber: number
  type: QuestionTypeValue
  source: ContentSource
  editorStatus: EditorStatus
  publishedAt: number | null
  payload?: unknown
  supersedesId?: string
}

export interface VersionStore {
  insertSubject(s: SubjectVersion): Promise<void>
  getSubject(id: string): Promise<SubjectVersion | undefined>
  findSubjectVersion(subject: string, exam: 'oge' | 'ege', academicYear: number): Promise<SubjectVersion | undefined>
  insertExamSpec(s: ExamSpec): Promise<void>
  getExamSpec(id: string): Promise<ExamSpec | undefined>
  insertTopic(t: Topic): Promise<void>
  softDeleteTopic(id: string): Promise<void>
  getTopic(id: string): Promise<Topic | undefined>
  appendQuestionRevision(q: QuestionRevision): Promise<void>
  getQuestion(id: string): Promise<QuestionRevision | undefined>
  getLatestQuestionRevision(subjectVersionId: string, code: string): Promise<QuestionRevision | undefined>
  /** CB-7: persist a patch to a question revision (no in-place mutation). */
  updateQuestion(id: string, patch: Partial<QuestionRevision>): Promise<QuestionRevision | undefined>
}

export type VersionResult<T> = ({ ok: true } & T) | { ok: false; code: string }

interface Options {
  store: VersionStore
  clock: Clock
}

const nextId = (prefix: string) => `${prefix}-${randomBytes(6).toString('hex')}`

export function createContentVersioningService(opts: Options) {
  const { store, clock } = opts

  return {
    async createSubjectVersion(input: {
      subject: string
      exam: 'oge' | 'ege'
      academicYear: number
      codifierUrl: string
    }): Promise<VersionResult<{ subjectVersion: SubjectVersion }>> {
      // Uniqueness: (subject, exam, academicYear).
      const existing = await store.findSubjectVersion(input.subject, input.exam, input.academicYear)
      if (existing) return { ok: false, code: 'conflict' }

      const subjectVersion: SubjectVersion = {
        id: nextId('subj'),
        subject: input.subject,
        exam: input.exam,
        academicYear: input.academicYear,
        codifierUrl: input.codifierUrl,
        createdAt: clock.now(),
      }
      await store.insertSubject(subjectVersion)
      return { ok: true, subjectVersion }
    },

    async createTopic(input: {
      subjectVersionId: string
      code: string
      title: string
    }): Promise<VersionResult<{ topic: Topic }>> {
      const subjectVersion = await store.getSubject(input.subjectVersionId)
      if (!subjectVersion) return { ok: false, code: 'not_found' }
      const topic: Topic = {
        id: nextId('topic'),
        subjectVersionId: input.subjectVersionId,
        code: input.code,
        title: input.title,
        deletedAt: null,
      }
      await store.insertTopic(topic)
      return { ok: true, topic }
    },

    /** Soft delete: history preserved (deletedAt set, row stays). */
    async deleteTopic(topicId: string): Promise<VersionResult<{ deleted: true }>> {
      const topic = await store.getTopic(topicId)
      if (!topic) return { ok: false, code: 'not_found' }
      await store.softDeleteTopic(topicId)
      return { ok: true, deleted: true }
    },

    async getTopic(topicId: string): Promise<Topic | undefined> {
      return store.getTopic(topicId)
    },

    async createQuestionDraft(input: {
      subjectVersionId: string
      code: string
      type: QuestionTypeValue
      source: ContentSource
    }): Promise<VersionResult<{ question: QuestionRevision }>> {
      const subjectVersion = await store.getSubject(input.subjectVersionId)
      if (!subjectVersion) return { ok: false, code: 'not_found' }
      const question: QuestionRevision = {
        id: nextId('q'),
        subjectVersionId: input.subjectVersionId,
        code: input.code,
        revisionNumber: 0,
        type: input.type,
        source: input.source,
        editorStatus: 'draft',
        publishedAt: null,
      }
      await store.appendQuestionRevision(question)
      return { ok: true, question }
    },

    async setEditorStatus(questionId: string, status: EditorStatus): Promise<VersionResult<{ updated: true }>> {
      const q = await store.getQuestion(questionId)
      if (!q) return { ok: false, code: 'not_found' }
      // CB-7: persist via store.updateQuestion, never mutate the fetched object.
      await store.updateQuestion(questionId, { editorStatus: status })
      return { ok: true, updated: true }
    },

    async publish(questionId: string): Promise<VersionResult<{ published: QuestionRevision }>> {
      const q = await store.getQuestion(questionId)
      if (!q) return { ok: false, code: 'not_found' }
      const decision = canPublishQuestion({
        id: q.id,
        subjectVersionId: q.subjectVersionId,
        type: q.type,
        source: q.source,
        editorStatus: q.editorStatus,
      })
      if (!decision.allowed) return { ok: false, code: 'validation_error', reason: decision.reason } as { ok: false; code: string; reason: string }
      // CB-7: persist the publication through the store.
      const published = await store.updateQuestion(questionId, {
        publishedAt: clock.now(),
        editorStatus: 'published',
      })
      if (!published) return { ok: false, code: 'not_found' }
      return { ok: true, published }
    },

    /** A published revision cannot be mutated in place. */
    async editPublished(questionId: string, _patch: { payload?: unknown }): Promise<VersionResult<{ question: QuestionRevision }>> {
      const q = await store.getQuestion(questionId)
      if (!q) return { ok: false, code: 'not_found' }
      if (q.publishedAt !== null) return { ok: false, code: 'immutable_published' }
      // Unpublished drafts could be edited; not part of this task's acceptance.
      return { ok: false, code: 'immutable_published' }
    },

    /** Fixing PUBLISHED content creates a NEW revision; the old one is preserved. */
    async createRevisionFix(
      questionId: string,
      input: { reason: string; source: ContentSource; payload?: unknown },
    ): Promise<VersionResult<{ revision: QuestionRevision }>> {
      const original = await store.getQuestion(questionId)
      if (!original) return { ok: false, code: 'not_found' }
      // CB-7: a fix is only meaningful against a published revision.
      if (original.publishedAt === null) return { ok: false, code: 'not_published' }
      const latest = await store.getLatestQuestionRevision(original.subjectVersionId, original.code)
      const nextRevNumber = (latest?.revisionNumber ?? 0) + 1
      const revision: QuestionRevision = {
        id: nextId('q'),
        subjectVersionId: original.subjectVersionId,
        code: original.code,
        revisionNumber: nextRevNumber,
        type: original.type,
        source: input.source,
        editorStatus: 'draft',
        publishedAt: null,
        payload: input.payload,
        supersedesId: original.id,
      }
      await store.appendQuestionRevision(revision)
      return { ok: true, revision }
    },
  }
}
