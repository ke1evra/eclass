import { getPayload } from 'payload'
import config from '../src/payload.config.js'
import { randomBytes } from 'node:crypto'

const payload = await getPayload({ config })
console.log('Payload initialized; collections:', payload.config.collections.map((c) => c.slug).join(', '))

const email = `t+${randomBytes(3).toString('hex')}@eclasstest.ru`
const u = await payload.create({
  collection: 'users',
  data: { email, password: 'longpass123', role: 'teacher' },
  overrideAccess: true,
})
console.log('created user:', u.id, u.email, u.role)

const found = await payload.find({
  collection: 'users',
  where: { email: { equals: email } },
  overrideAccess: true,
})
console.log('found by email:', found.totalDocs)

// Unique index check: create the same email again should fail.
try {
  await payload.create({
    collection: 'users',
    data: { email, password: 'longpass123', role: 'teacher' },
    overrideAccess: true,
  })
  console.log('DUPLICATE CREATE UNEXPECTEDLY SUCCEEDED (index missing)')
} catch {
  console.log('duplicate email rejected (unique enforced)')
}

// payload.destroy() hangs on Mongo; exit explicitly (the data is already persisted).
console.log('done')
process.exit(0)
