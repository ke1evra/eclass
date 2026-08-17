import type { CollectionConfig } from 'payload'

/**
 * Attachments — ECLASS-30 (photo/PDF for extended answers).
 *
 * Files live on disk (UPLOADS_DIR) under random names — the original filename
 * is metadata only, never a path. The record is the access anchor: reads go
 * through the app, which checks attempt ownership (student owner or the
 * assignment's teacher); no guessable public URLs. MIME allowlist + size cap
 * are enforced at upload; EXIF/malware scanning is out of MVP scope (noted in
 * the task record).
 */
export const Attachments: CollectionConfig = {
  slug: 'attachments',
  access: {
    read: () => false,
    create: () => false,
    update: () => false,
    delete: () => false,
  },
  fields: [
    { name: 'attemptId', type: 'text', required: true, index: true },
    { name: 'questionCode', type: 'text', required: true },
    { name: 'studentId', type: 'text', required: true, index: true },
    { name: 'storedName', type: 'text', required: true },
    { name: 'originalName', type: 'text', required: true },
    { name: 'mimeType', type: 'text', required: true },
    { name: 'size', type: 'number', required: true },
    { name: 'createdAt', type: 'number', required: true },
  ],
}
