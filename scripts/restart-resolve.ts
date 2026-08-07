import { readFileSync } from 'node:fs'
import { getPayload } from 'payload'
import config from '../src/payload.config'
import { resolveActor } from '../src/auth/payload-resolver'

// ECLASS-65 restart-resolver helper: runs in a SEPARATE Node process (spawned
// by tests/integration/auth/restart-resolver.test.ts). Reads the session id
// from a temp file, boots its OWN Payload against DATABASE_URL, and resolves
// the actor. Prints "RESOLVED <userId> <role>" on success, "ANONYMOUS" if the
// session did not resolve.
const sessionFile = process.argv[2]
if (!sessionFile) {
  console.error('NO SESSION FILE')
  process.exit(2)
}
const sessionId = readFileSync(sessionFile, 'utf-8').trim()

const payload = await getPayload({ config })
const clock = { now: () => Date.now() }
const actor = await resolveActor(payload, sessionId, clock)
if (!actor) {
  console.log('ANONYMOUS')
  process.exit(0)
}
console.log(`RESOLVED ${actor.id} ${actor.role}`)
process.exit(0)
