/**
 * Demo teacher provisioning — deployment helper (no SMTP on demo stands).
 *
 * The signup→email-confirm path needs a real SMTP; on a demo deployment the
 * outbox stays sealed, so the usable entry point is a pre-provisioned
 * CONFIRMED teacher. Students need no email at all (join by invite code).
 *
 * Usage (server):
 *   set -a; . ./.env.production; set +a
 *   npx tsx scripts/seed-demo-teacher.ts
 * Override via DEMO_EMAIL / DEMO_PASSWORD env. Idempotent.
 */
import { getPayload } from 'payload'
import config from '../src/payload.config'

const main = async (): Promise<void> => {
  const email = (process.env.DEMO_EMAIL ?? 'demo@eclass.script-setup.ru').toLowerCase()
  const password = process.env.DEMO_PASSWORD ?? 'demo-teacher-2026'

  const payload = await getPayload({ config })
  const existing = await payload.find({
    collection: 'users',
    where: { email: { equals: email } },
    limit: 1,
    overrideAccess: true,
  })
  if (existing.totalDocs > 0) {
    console.log('DEMO_TEACHER_EXISTS', email)
    return
  }
  await payload.create({
    collection: 'users',
    data: { email, password, name: 'Демо-учитель', emailConfirmed: true },
    overrideAccess: true,
  })
  console.log('DEMO_TEACHER_CREATED', email)
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[seed-demo-teacher] FAILED:', err instanceof Error ? err.message : err)
    process.exit(1)
  })
