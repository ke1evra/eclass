import type { CollectionConfig } from 'payload'

/**
 * Assignments — ECLASS-23/24/26.
 *
 * An assignment carries an IMMUTABLE SNAPSHOT of every question at assign
 * time (later bank edits never mutate issued work — acceptance criterion),
 * plus the explicit recipient list (no implicit "everyone"). status:
 * draft → assigned. dueAt is optional; overdue work stays submittable
 * (teacher policy knob lives in the UI copy, not a hard gate — ECLASS-26).
 */
export const Assignments: CollectionConfig = {
  slug: 'assignments',
  access: {
    read: ({ req }) => {
      if (!req.user) return false
      if (req.user.role === 'admin') return true
      if (req.user.role === 'teacher') return { ownerId: { equals: req.user.id } }
      // Students reach assignments only through their attempts (Local API).
      return false
    },
    create: () => false,
    update: () => false,
    delete: () => false,
  },
  fields: [
    { name: 'ownerId', type: 'text', required: true, index: true },
    { name: 'classId', type: 'text', required: true, index: true },
    { name: 'title', type: 'text', required: true },
    { name: 'status', type: 'select', required: true, defaultValue: 'draft', options: ['draft', 'assigned'] },
    { name: 'dueAt', type: 'number' },
    {
      /** Immutable copy of the chosen question revisions (answerKey included server-side). */
      name: 'questionSnapshot',
      type: 'array',
      required: true,
      fields: [
        { name: 'code', type: 'text', required: true },
        { name: 'type', type: 'text', required: true },
        { name: 'topic', type: 'text', required: true },
        { name: 'stem', type: 'textarea', required: true },
        {
          name: 'options',
          type: 'array',
          fields: [
            { name: 'id', type: 'text', required: true },
            { name: 'text', type: 'text', required: true },
          ],
        },
        { name: 'answerKey', type: 'json' },
        { name: 'points', type: 'number', required: true },
      ],
    },
    /** Explicit recipients — student ids (acceptance: one recipient = one attempt). */
    { name: 'recipientIds', type: 'array', required: true, fields: [{ name: 'id', type: 'text' }] },
    { name: 'createdAt', type: 'number', required: true },
  ],
  indexes: [{ fields: ['classId'] }],
}
