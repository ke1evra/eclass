import type { CollectionConfig } from 'payload'

/**
 * Questions — versioned content bank — ECLASS-18/19/20/21.
 *
 * A question revision row per code+revision (immutable once published per the
 * content policy; fixes create a NEW row). Answer keys live server-side only:
 * the student-facing attempt payload strips them by construction.
 *
 * Fields mirror the domain QuestionRevision (ECLASS-18) with the publication
 * gate from content-policy: editorStatus=published requires source+version.
 */
export const Questions: CollectionConfig = {
  slug: 'questions',
  access: {
    // Teachers READ the bank; only the server (Local API) writes.
    read: ({ req }) =>
      // Bank reads are teacher/admin-only; students meet questions via attempts.
      req.user?.role === 'teacher' || req.user?.role === 'admin',
    create: () => false,
    update: () => false,
    delete: () => false,
  },
  fields: [
    { name: 'subjectVersionId', type: 'text', required: true, index: true },
    { name: 'code', type: 'text', required: true },
    { name: 'revisionNumber', type: 'number', required: true, defaultValue: 1 },
    {
      name: 'type',
      type: 'select',
      required: true,
      options: ['single-choice', 'multiple-choice', 'short-text', 'extended-text'],
    },
    /** Skill/topic tag — drives mastery (ECLASS-37) and remediation (ECLASS-36). */
    { name: 'topic', type: 'text', required: true, index: true },
    { name: 'stem', type: 'textarea', required: true },
    {
      name: 'options',
      type: 'array',
      fields: [
        { name: 'id', type: 'text', required: true },
        { name: 'text', type: 'text', required: true },
      ],
    },
    /**
     * Server-only answer key: option ids for choice types; accepted normalized
     * answers for short-text; unused for extended-text (manual rubric review).
     */
    { name: 'answerKey', type: 'json' },
    { name: 'points', type: 'number', required: true, defaultValue: 1 },
    { name: 'source', type: 'select', required: true, options: ['fipi', 'authored'], defaultValue: 'authored' },
    {
      name: 'editorStatus',
      type: 'select',
      required: true,
      defaultValue: 'published',
      options: ['draft', 'review', 'published', 'retired'],
      index: true,
    },
    { name: 'publishedAt', type: 'number' },
  ],
  indexes: [{ fields: ['subjectVersionId', 'editorStatus'] }, { fields: ['code'], unique: true }],
}
