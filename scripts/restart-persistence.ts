import { getPayload } from 'payload'
import config from '../src/payload.config.js'

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
} else if (mode === 'session-read') {
  const found = await payload.find({
    collection: 'sessions',
    where: { sessionId: { equals: email } },
    overrideAccess: true,
  })
  console.log('SESSION_FOUND', found.totalDocs, found.docs[0]?.userId ?? '-')
}

process.exit(0)
