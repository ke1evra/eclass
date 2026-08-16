import { beforeEach, describe, expect, it } from 'vitest'
import { NextRequest } from 'next/server'
import { clearData, getPayloadSingleton, integrationSuite, uniqueEmail } from '../_payload'
import { handleMe } from '@/app/api/me/handler'
import { createSessionAdapter } from '@/auth/session-adapter'
import { SESSION_TTL_MS } from '@/auth/session-ttl'

/**
 * ECLASS-56 review follow-up: /api/me is the session probe pages and E2E rely
 * on — it gets its own named test (matrix rule: every route, a named test).
 * Anonymous, teacher, student and dead-cookie shapes.
 */
const HOUR = 60 * 60 * 1000

const getReq = (cookie?: string): NextRequest => {
  const headers: Record<string, string> = {}
  if (cookie) headers.cookie = cookie
  return new NextRequest(new URL('http://localhost/api/me'), { method: 'GET', headers })
}

integrationSuite('ECLASS-56: GET /api/me session probe', () => {
  beforeEach(clearData)

  it('anonymous: {authenticated:false} and nothing else', async () => {
    const p = await getPayloadSingleton()
    const res = await handleMe(getReq(), p)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ authenticated: false })
  })

  it('dead cookie (expired row): anonymous shape — no leak that the session ever existed', async () => {
    const p = await getPayloadSingleton()
    const user = await p.create({
      collection: 'users',
      data: { email: uniqueEmail('me-dead'), password: 'longpass123', emailConfirmed: true },
      overrideAccess: true,
    })
    const adapter = createSessionAdapter({ payload: p, clock: { now: () => Date.now() }, sessionTtlMs: SESSION_TTL_MS })
    const login = await adapter.login({ email: user.email, password: 'longpass123' })
    expect(login.ok).toBe(true)
    await p.db.connection.collection('sessions').updateOne(
      { sessionId: login.ok ? login.sessionId : 'x' },
      { $set: { expiresAt: Date.now() - 1000 } },
    )
    const res = await handleMe(getReq(`eclass_session=${login.ok ? login.sessionId : 'x'}`), p)
    expect(await res.json()).toEqual({ authenticated: false })
  })

  it('teacher and student sessions report role+userId; no email in the payload', async () => {
    const p = await getPayloadSingleton()
    const teacher = await p.create({
      collection: 'users',
      data: { email: uniqueEmail('me-tea'), password: 'longpass123', emailConfirmed: true },
      overrideAccess: true,
    })
    const student = await p.create({
      collection: 'users',
      data: { email: uniqueEmail('me-stu'), password: 'longpass123', role: 'student', emailConfirmed: true },
      overrideAccess: true,
    })

    const adapter = createSessionAdapter({ payload: p, clock: { now: () => Date.now() }, sessionTtlMs: HOUR })
    const teaLogin = await adapter.login({ email: teacher.email, password: 'longpass123' })
    const stuLogin = await adapter.login({ email: student.email, password: 'longpass123' })
    expect(teaLogin.ok && stuLogin.ok).toBe(true)

    const teaRes = await handleMe(getReq(`eclass_session=${teaLogin.ok ? teaLogin.sessionId : ''}`), p)
    expect(await teaRes.json()).toEqual({ authenticated: true, role: 'teacher', userId: teacher.id })

    const stuRes = await handleMe(getReq(`eclass_session=${stuLogin.ok ? stuLogin.sessionId : ''}`), p)
    const stuBody = await stuRes.json()
    expect(stuBody).toEqual({ authenticated: true, role: 'student', userId: student.id })
    expect(JSON.stringify(stuBody)).not.toContain('@')
  })
})
