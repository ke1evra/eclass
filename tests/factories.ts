/**
 * Test factories — ECLASS-11.
 *
 * Single source of deterministic, PII-free test data. Every test in the
 * suite builds entities through these factories so that:
 *   - no production data ever enters tests (NFR privacy);
 *   - fixtures are stable across runs (deterministic IDs, injectable clocks);
 *   - adding a required domain field updates all tests at once via the factory.
 *
 * The factories NEVER emit email/name/answer text by default; opt-in fields
 * are explicit and named so they cannot leak silently.
 */
import type {
  Assignment,
  ClassEntity,
  Comment,
  QuestionVersion,
  Review,
  Student,
  Submission,
  User,
  Answer,
} from '@/domain/entities'

let counter = 0
const nextId = (prefix: string): string => {
  counter += 1
  return `${prefix}-${counter.toString(36)}`
}

/** Reset the counter at the start of a test file for fully deterministic IDs. */
export const resetFactoryIds = (): void => {
  counter = 0
}

const baseTimestamp = 1_700_000_000_000 // fixed epoch; tests inject clocks, not Date.now

export const userFactory = (over: Partial<User> & Pick<User, 'role'> = { role: 'teacher' }): User => ({
  id: over.id ?? nextId(over.role),
  role: over.role,
  ...(over as Partial<User>),
})

export const classFactory = (over: Partial<ClassEntity> = {}): ClassEntity => ({
  id: over.id ?? nextId('cls'),
  ownerId: over.ownerId ?? 'tea-1',
  subjectVersionId: over.subjectVersionId ?? 'subj-math-2026',
  name: over.name ?? 'Тестовый класс',
  ...over,
})

export const studentFactory = (over: Partial<Student> = {}): Student => ({
  id: over.id ?? nextId('stu'),
  classId: over.classId ?? 'cls-1',
  ...over,
})

export const questionFactory = (over: Partial<QuestionVersion> = {}): QuestionVersion => ({
  id: over.id ?? nextId('q'),
  subjectVersionId: over.subjectVersionId ?? 'subj-math-2026',
  type: over.type ?? 'single-choice',
  published: over.published ?? true,
  ...over,
})

export const assignmentFactory = (over: Partial<Assignment> = {}): Assignment => ({
  id: over.id ?? nextId('asg'),
  classId: over.classId ?? 'cls-1',
  ownerId: over.ownerId ?? 'tea-1',
  title: over.title ?? 'Тестовая работа',
  questionVersionIds: over.questionVersionIds ?? ['q-1'],
  recipientIds: over.recipientIds ?? ['stu-1'],
  ...over,
})

export const submissionFactory = (over: Partial<Submission> = {}): Submission => ({
  id: over.id ?? nextId('sub'),
  assignmentId: over.assignmentId ?? 'asg-1',
  studentId: over.studentId ?? 'stu-1',
  ownerId: over.ownerId ?? 'tea-1',
  status: over.status ?? 'assigned',
  createdAt: over.createdAt ?? baseTimestamp,
  updatedAt: over.updatedAt ?? baseTimestamp,
  ...over,
})

export const answerFactory = (over: Partial<Answer> = {}): Answer => ({
  id: over.id ?? nextId('ans'),
  submissionId: over.submissionId ?? 'sub-1',
  questionVersionId: over.questionVersionId ?? 'q-1',
  payload: over.payload ?? { value: 'A' },
  clientKey: over.clientKey ?? `client-key-${nextId('k')}`,
  updatedAt: over.updatedAt ?? baseTimestamp,
  ...over,
})

export const reviewFactory = (over: Partial<Review> = {}): Review => ({
  id: over.id ?? nextId('rev'),
  submissionId: over.submissionId ?? 'sub-1',
  reviewerId: over.reviewerId ?? 'tea-1',
  status: over.status ?? 'draft',
  ...over,
})

export const commentFactory = (over: Partial<Comment> = {}): Comment => ({
  id: over.id ?? nextId('cmt'),
  submissionId: over.submissionId ?? 'sub-1',
  authorId: over.authorId ?? 'tea-1',
  authorRole: over.authorRole ?? 'teacher',
  visibility: over.visibility ?? 'public',
  body: over.body ?? 'Хорошая работа',
  createdAt: over.createdAt ?? baseTimestamp,
  ...over,
})
