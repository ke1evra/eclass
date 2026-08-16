import { beforeEach, describe, expect, it } from 'vitest'
import { NextRequest } from 'next/server'
import { clearData, getPayloadSingleton, integrationSuite, uniqueEmail } from '../_payload'
import { handleLogin } from '@/app/api/auth/login/handler'
import { handleJoin } from '@/app/api/join/handler'
import { handleCreateInvite } from '@/app/api/classes/[id]/invites/handler'
import { handleCreateClass } from '@/app/api/classes/handler'
import { createSessionAdapter } from '@/auth/session-adapter'
import { SESSION_TTL_MS } from '@/auth/session-ttl'

/**
 * ECLASS-13 review fix: ONE session TTL for every issuing site. Before the fix
 * the API login handler minted 1-hour sessions while UI/join minted 30-day —
 * the test pins both API paths to the shared constant (RED: login was 1h).
 */
const jsonReq = (url: string, body: unknown, cookie?: string): NextRequest => {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (cookie) headers.cookie = cookie
  return new NextRequest(new URL(url, 'http://localhost'), {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

integrationSuite('ECLASS-13: one session TTL for API, UI and join', () => {
  beforeEach(clearData)

  it('API login session lifetime === SESSION_TTL_MS (was 1 hour)', async () => {
    const p = await getPayloadSingleton()
    const email = uniqueEmail('ttl')
    await p.create({
      collection: 'users',
      data: { email, password: 'longpass123', emailConfirmed: true },
      overrideAccess: true,
    })

    const before = Date.now()
    const res = await handleLogin(jsonReq('http://localhost/api/auth/login', { email, password: 'longpass123' }), p)
    expect(res.status).toBe(200)

    const cookie = res.headers.get('set-cookie')!.match(/eclass_session=([^;]+)/)![1]!
    const row = await p.find({
      collection: 'sessions',
      where: { sessionId: { equals: cookie } },
      overrideAccess: true,
    })
    const expiresAt = (row.docs[0] as unknown as { expiresAt: number }).expiresAt
    expect(expiresAt - before).toBeGreaterThanOrEqual(SESSION_TTL_MS - 5_000)
    expect(expiresAt - before).toBeLessThanOrEqual(SESSION_TTL_MS + 5_000)

    // The cookie's Max-Age agrees with the row.
    const maxAge = Number(res.headers.get('set-cookie')!.match(/Max-Age=(\d+)/i)?.[1])
    expect(maxAge).toBe(Math.floor(SESSION_TTL_MS / 1000))
  })

  it('join session lifetime === SESSION_TTL_MS (via the shared issueSession)', async () => {
    const p = await getPayloadSingleton()
    const teacher = await p.create({
      collection: 'users',
      data: { email: uniqueEmail('ttl-tea'), password: 'longpass123', emailConfirmed: true },
      overrideAccess: true,
    })
    const adapter = createSessionAdapter({ payload: p, clock: { now: () => Date.now() }, sessionTtlMs: SESSION_TTL_MS })
    const login = await adapter.login({ email: teacher.email, password: 'longpass123' })
    const cookie = `eclass_session=${login.ok ? login.sessionId : ''}`

    const cls = await handleCreateClass(jsonReq('http://localhost/api/classes', { name: 'TTL', subjectVersionId: 'math-oge-2026' }, cookie), p)
    const classId = (await cls.json()).class.id
    const invite = await handleCreateInvite(new NextRequest(new URL(`http://localhost/api/classes/${classId}/invites`, 'http://localhost'), { method: 'POST', headers: { cookie } }), p, classId)
    const code = (await invite.json()).code

    const before = Date.now()
    const join = await handleJoin(
      jsonReq('http://localhost/api/join', { code, login: uniqueEmail('ttl-stu'), displayName: 'Т', password: 'longpass123' }),
      p,
    )
    expect(join.status).toBe(200)
    const joinCookie = join.headers.get('set-cookie')!.match(/eclass_session=([^;]+)/)![1]!
    const row = await p.find({ collection: 'sessions', where: { sessionId: { equals: joinCookie } }, overrideAccess: true })
    const expiresAt = (row.docs[0] as unknown as { expiresAt: number }).expiresAt
    expect(expiresAt - before).toBeGreaterThanOrEqual(SESSION_TTL_MS - 5_000)
  })
})
