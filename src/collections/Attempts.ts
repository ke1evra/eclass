import type { CollectionConfig } from 'payload'

/**
 * Attempts — one per (assignment, student) — ECLASS-27/28/29/33/34/35.
 *
 * Lifecycle: assigned → in_progress (first autosave/open) → submitted →
 * checked. Autosave writes per-question answers with a monotonic client
 * version (stale versions lose silently — no overwrite of newer work across
 * two devices). submit consumes the client idempotency key exactly once and
 * runs server-side autograding against the SNAPSHOT answer key; extended-text
 * stays null until the teacher's rubric review. checked freezes scores.
 * Comments thread (ECLASS-35) lives inline: authorRole gates visibility —
 * internal teacher notes are shown to the teacher only.
 */
export const Attempts: CollectionConfig = {
  slug: 'attempts',
  access: {
    read: ({ req }) => {
      if (!req.user) return false
      if (req.user.role === 'admin') return true
      if (req.user.role === 'student') return { studentId: { equals: req.user.id } }
      return false // teachers go through the server (ownerId on assignment)
    },
    create: () => false,
    update: () => false,
    delete: () => false,
  },
  fields: [
    { name: 'assignmentId', type: 'text', required: true, index: true },
    { name: 'classId', type: 'text', required: true, index: true },
    { name: 'ownerId', type: 'text', required: true },
    { name: 'studentId', type: 'text', required: true, index: true },
    { name: 'title', type: 'text', required: true },
    { name: 'dueAt', type: 'number' },
    { name: 'subjectVersionId', type: 'text', required: true },
    {
      name: 'status',
      type: 'select',
      required: true,
      defaultValue: 'assigned',
      options: ['assigned', 'in_progress', 'submitted', 'checked'],
      index: true,
    },
    {
      name: 'answers',
      type: 'array',
      fields: [
        { name: 'code', type: 'text', required: true },
        /** Option id / ids / short text / extended text. */
        { name: 'value', type: 'json' },
        { name: 'attachmentIds', type: 'array', fields: [{ name: 'id', type: 'text' }] },
        { name: 'clientVersion', type: 'number' },
        { name: 'savedAt', type: 'number' },
      ],
    },
    /** Per-question outcomes; auto for objective types, manual after review. */
    {
      name: 'scores',
      type: 'array',
      fields: [
        { name: 'code', type: 'text', required: true },
        { name: 'auto', type: 'number' },
        { name: 'manual', type: 'number' },
        { name: 'teacherComment', type: 'text' },
        { name: 'flaggedForReview', type: 'checkbox' },
      ],
    },
    { name: 'totalScore', type: 'number' },
    { name: 'maxScore', type: 'number' },
    { name: 'submittedAt', type: 'number' },
    { name: 'checkedAt', type: 'number' },
    /** Consumed client idempotency key — replay-safe submit (ECLASS-29). */
    { name: 'idempotencyKey', type: 'text', index: true },
    {
      name: 'comments',
      type: 'array',
      fields: [
        { name: 'authorId', type: 'text', required: true },
        { name: 'authorRole', type: 'select', required: true, options: ['teacher', 'student'] },
        { name: 'internal', type: 'checkbox', defaultValue: false },
        { name: 'body', type: 'textarea', required: true },
        { name: 'createdAt', type: 'number', required: true },
      ],
    },
    { name: 'createdAt', type: 'number', required: true },
  ],
  indexes: [
    { fields: ['assignmentId', 'studentId'], unique: true },
    { fields: ['classId', 'status'] },
  ],
}
