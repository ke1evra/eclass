import { getPayload } from 'payload'
import config from '../src/payload.config.js'
import { createMongoRateLimiter } from '../src/auth/rate-limit'
import { migrateInvitesToHashes } from '../src/classes/invite-migration'
import { createAtomicJoin } from '../src/classes/atomic-join'

// ECLASS-56 proof: data created in one process is found in ANOTHER process.
// Argv: 'create <email>' or 'find <email>'.
const mode = process.argv[2]
const email = process.argv[3]
const payload = await getPayload({ config })

if (mode === 'create') {
  const u = await payload.create({
    collection: 'users',
    data: { email, password: 'longpass123', role: 'teacher' },
    overrideAccess: true,
  })
  console.log('CREATED', u.id, u.email)
} else if (mode === 'find') {
  const found = await payload.find({
    collection: 'users',
    where: { email: { equals: email } },
    overrideAccess: true,
  })
  console.log('FOUND', found.totalDocs, found.docs[0]?.id ?? '-', found.docs[0]?.email ?? '-')
} else if (mode === 'count') {
  const all = await payload.find({ collection: 'users', limit: 0, overrideAccess: true })
  console.log('TOTAL', all.totalDocs)
} else if (mode === 'session-persist') {
  const s = await payload.create({
    collection: 'sessions',
    data: {
      sessionId: email,
      userId: 'u-' + email,
      role: 'teacher',
      expiresAt: Date.now() + 3_600_000,
      revoked: false,
    },
    overrideAccess: true,
  })
  console.log('SESSION_CREATED', s.id)
} else if (mode === 'class-create') {
  // ECLASS-56/14 restart proof: a class written by THIS process must be
  // readable by a later, freshly booted process after this one has exited.
  const c = await payload.create({
    collection: 'classes',
    data: { ownerId: 'restart-proof-owner', subjectVersionId: 'math-oge-2026', name: email },
    overrideAccess: true,
  })
  console.log('CLASS_CREATED', c.id)
} else if (mode === 'class-find') {
  const found = await payload.find({
    collection: 'classes',
    where: { name: { equals: email } },
    overrideAccess: true,
  })
  console.log('CLASS_FOUND', found.totalDocs, found.docs[0]?.id ?? '-')
} else if (mode === 'invite-seed-legacy') {
  // ECLASS-57 concurrent-migration proof: a LEGACY plaintext invite row.
  const cls = await payload.create({
    collection: 'classes',
    data: { ownerId: 'legacy-migration-owner', subjectVersionId: 'math-oge-2026', name: `legacy-${Date.now()}` },
    overrideAccess: true,
  })
  const code = 'LEGACY' + Math.random().toString(36).slice(2, 6).toUpperCase()
  await payload.db.connection.collection('invites').insertOne({
    code, // PLAINTEXT, as the pre-hashing implementation wrote it
    classId: cls.id,
    ownerId: 'legacy-migration-owner',
    createdAt: Date.now(),
    expiresAt: Date.now() + 3_600_000,
    revoked: false,
  })
  console.log('LEGACY_SEEDED', code, cls.id)
} else if (mode === 'invite-migrate') {
  const n = await migrateInvitesToHashes(payload)
  console.log('MIGRATED', n)
} else if (mode === 'join-legacy') {
  const join = createAtomicJoin({ payload, clock: { now: () => Date.now() } })
  const result = await join.acceptInviteAndCreateStudent({
    code: email,
    login: `join-legacy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@eclasstest.ru`,
    displayName: 'Миграционный Ученик',
    password: 'longpass123',
  })
  console.log('JOIN_LEGACY', result.ok ? 'ok' : result.code)
} else if (mode === 'rate-hit') {
  // ECLASS-59 literal cross-process proof: THIS process burns N hits of a
  // named key, then exits; a fresh process must see the same window.
  const key = email
  const n = Number(process.argv[4] ?? 1)
  const limiter = createMongoRateLimiter({ payload, clock: { now: () => Date.now() }, windowMs: 60_000, max: 5 })
  let lastAllowed = true
  for (let i = 0; i < n; i++) lastAllowed = (await limiter.hit(key)).allowed
  console.log('RATE_HIT_DONE', lastAllowed)
} else if (mode === 'rate-check') {
  const limiter = createMongoRateLimiter({ payload, clock: { now: () => Date.now() }, windowMs: 60_000, max: 5 })
  const d = await limiter.hit(email)
  console.log('RATE_CHECK', d.allowed ? 'allowed' : 'denied', d.retryAfterMs)
} else if (mode === 'session-read') {
  const found = await payload.find({
    collection: 'sessions',
    where: { sessionId: { equals: email } },
    overrideAccess: true,
  })
  console.log('SESSION_FOUND', found.totalDocs, found.docs[0]?.userId ?? '-')
}

process.exit(0)
