import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { buildConfig } from 'payload'
import { postgresAdapter } from '@payloadcms/db-postgres'
import { lexicalEditor } from '@payloadcms/richtext-lexical'

const filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(filename)

/**
 * Payload 3 configuration skeleton.
 *
 * Domain collections (subjects, question-bank, classes, assignments,
 * submissions, reviews, feedback) are introduced by their own TDD tasks
 * (ECLASS-9 / ECLASS-11 / ECLASS-18 ...). This file is intentionally a
 * runnable-but-empty config so the rest of P0 (CI, contracts, E2E) has a
 * real application to point at.
 */
export default buildConfig({
  admin: {
    user: 'users',
  },
  editor: lexicalEditor({}),
  db: postgresAdapter({
    pool: {
      connectionString: process.env.DATABASE_URI ?? '',
    },
    push: false,
    migrationDir: path.resolve(dirname, '../migrations'),
  }),
  secret: process.env.PAYLOAD_SECRET ?? 'insecure-p0-dev-secret-change-me',
  typescript: {
    outputFile: path.resolve(dirname, '../payload-types.ts'),
  },
  collections: [
    {
      slug: 'users',
      auth: true,
      fields: [
        { name: 'name', type: 'text' },
        { name: 'role', type: 'select', options: ['teacher', 'student', 'admin'] },
      ],
      access: {
        // Tenant isolation is enforced per collection in ECLASS-17. The
        // default-deny placeholders here guarantee nothing is exposed by
        // accident before that task lands.
        read: () => false,
        create: () => false,
        update: () => false,
        delete: () => false,
      },
    },
  ],
})
