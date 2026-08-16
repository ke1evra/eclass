import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { buildConfig } from 'payload'
import { mongooseAdapter } from '@payloadcms/db-mongodb'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import { Users } from './collections/Users'
import { Sessions } from './collections/Sessions'
import { EmailJobs } from './collections/EmailJobs'
import { Classes } from './collections/Classes'
import { Memberships } from './collections/Memberships'
import { Invites } from './collections/Invites'

const filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(filename)

/**
 * Payload 3 configuration — ECLASS-56.
 *
 * Persistence: MongoDB (replica set for transactions, ECLASS-57). Collections
 * mirror the domain types from ECLASS-9 with SERVER-SIDE access control: every
 * read/mutate goes through the policy layer, never trusting client input.
 *
 * The in-memory AuthStore/ClassStore wiring (CB-4) is replaced by Payload Local
 * API adapters at the application boundary — there is no Map-backed store on
 * the production path.
 */
export default buildConfig({
  admin: {
    user: 'users',
    // The admin panel is a separate concern from the student/teacher app; access
    // to it is governed by the Users collection access functions.
  },
  editor: lexicalEditor({}),
  db: mongooseAdapter({
    // `replicaSet=rs0` MUST be in the URI: @payloadcms/db-mongodb disables the
    // transaction API (beginTransaction → null) when the client options carry
    // no replicaSet, even if the deployment actually is a replset.
    url: process.env.DATABASE_URL ?? 'mongodb://127.0.0.1:27018/eclass?replicaSet=rs0',
    // Replica set is required for transactions (ECLASS-57). The URL above points
    // at a local single-node replset; production uses the server Mongo replset.
    transactionOptions: {
      maxTimeMS: 5000,
    },
  }),
  secret: process.env.PAYLOAD_SECRET ?? 'insecure-p0-dev-secret-change-me',
  typescript: {
    outputFile: path.resolve(dirname, '../payload-types.ts'),
  },
  collections: [Users, Sessions, EmailJobs, Classes, Memberships, Invites],
})
