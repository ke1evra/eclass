import { beforeEach, describe, expect, it } from 'vitest'
import { NextRequest } from 'next/server'
import { MongoClient } from 'mongodb'
import { clearData, getPayloadSingleton, integrationSuite, uniqueEmail } from '../_payload'
import { createSessionAdapter } from '@/auth/session-adapter'
import { handleCreateClass, handleListClasses } from '@/app/api/classes/handler'
import { handleGetClass, handlePatchClass } from '@/app/api/classes/[id]/handler'
import { handleGetMembers } from '@/app/api/classes/[id]/members/handler'
import { handleCreateInvite } from '@/app/api/classes/[id]/invites/handler'
import { handleJoin } from '@/app/api/join/handler'

/**
 * ECLASS-56 (Stage A/B) — class boundary through REAL route handlers against
 * Payload/MongoDB. The proof matrix the task demands:
 *
 *   - CRUD: create → list → get → rename → archive, all persisted in Mongo
 *     (verified through a SECOND, direct MongoClient — not the app instance);
 *   - Actor ONLY from eclass_session: no cookie / forged cookie → 401;
 *   - IDOR: teacher B reading/writing teacher A's class → 404 (no existence
 *     leak), student actor → 403/404;
 *   - invite minting is owner-only and the code is opaque (no class or user
 *     ids inside);
 *   - roster exposes only id + displayName.
 */

const HOUR = 60 * 60 * 1000

function req(
  url: string,
  method: 'GET' | 'POST' | 'PATCH',
  body?: unknown,
  cookie?: string,
): NextRequest {
  const headers: Record<string, string> = {}
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (cookie) headers.cookie = cookie
  return new NextRequest(new URL(url, 'http://localhost'), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

const cookieOf = (res: Response): string | null => {
  const set = res.headers.get('set-cookie')
  return set?.match(/eclass_session=([^;]+)/)?.[1] ?? null
}

/** Confirmed teacher + a logged-in session cookie value. */
async function teacherFixture(p: Parameters<typeof handleCreateClass>[1], email?: string) {
  const user = await p.create({
    collection: 'users',
    data: {
      email: email ?? uniqueEmail('teacher'),
      password: 'longpass123',
      name: 'Учитель ' + Math.random().toString(36).slice(2, 6),
      emailConfirmed: true,
    },
    overrideAccess: true,
  })
  const adapter = createSessionAdapter({
    payload: p,
    clock: { now: () => Date.now() },
    sessionTtlMs: HOUR,
  })
  const login = await adapter.login({ email: user.email, password: 'longpass123' })
  expect(login.ok).toBe(true)
  return { userId: user.id, cookie: `eclass_session=${login.ok ? login.sessionId : ''}` }
}

integrationSuite('ECLASS-56: class boundary (routes → Payload/Mongo)', () => {
  beforeEach(clearData)

  it('create → list → get → rename → archive; persisted in Mongo (second client)', async () => {
    const p = await getPayloadSingleton()
    const t = await teacherFixture(p)

    const created = await handleCreateClass(
      req('http://localhost/api/classes', 'POST', { name: '9А математика', subjectVersionId: 'math-oge-2026' }, t.cookie),
      p,
    )
    expect(created.status).toBe(201)
    const { class: cls } = await created.json()
    expect(cls.name).toBe('9А математика')

    // Visible in the list; hidden after archiving unless asked explicitly.
    const listRes = await handleListClasses(req('http://localhost/api/classes', 'GET', undefined, t.cookie), p)
    const list = await listRes.json()
    expect(list.items).toHaveLength(1)

    const renamed = await handlePatchClass(
      req(`http://localhost/api/classes/${cls.id}`, 'PATCH', { name: '9Б математика' }, t.cookie),
      p,
      cls.id,
    )
    expect(renamed.status).toBe(200)
    expect((await renamed.json()).class.name).toBe('9Б математика')

    const archived = await handlePatchClass(
      req(`http://localhost/api/classes/${cls.id}`, 'PATCH', { archived: true }, t.cookie),
      p,
      cls.id,
    )
    expect(archived.status).toBe(200)

    const afterArchive = await handleListClasses(req('http://localhost/api/classes', 'GET', undefined, t.cookie), p)
    expect((await afterArchive.json()).items).toHaveLength(0)
    const withArchived = await handleListClasses(
      req('http://localhost/api/classes?includeArchived=true', 'GET', undefined, t.cookie),
      p,
    )
    expect((await withArchived.json()).items).toHaveLength(1)

    // A SECOND MongoClient sees the class: persistence is Mongo, not memory.
    const url = process.env.DATABASE_URL!
    const client = new MongoClient(url)
    await client.connect()
    try {
      const dbName = new URL(url).pathname.replace(/^\//, '') || 'eclass'
      const raw = await client.db(dbName).collection('classes').findOne({ name: '9Б математика' })
      expect(raw).not.toBeNull()
      expect(raw!.archivedAt).toBeTypeOf('number')
    } finally {
      await client.close()
    }
  })

  it('no cookie / forged cookie → 401; actor never comes from the body', async () => {
    const p = await getPayloadSingleton()
    const t = await teacherFixture(p)

    const noCookie = await handleCreateClass(
      req('http://localhost/api/classes', 'POST', { name: 'X', subjectVersionId: 'math-oge-2026' }),
      p,
    )
    expect(noCookie.status).toBe(401)

    const forged = await handleCreateClass(
      req('http://localhost/api/classes', 'POST', { name: 'X', subjectVersionId: 'math-oge-2026' }, 'eclass_session=forged-value'),
      p,
    )
    expect(forged.status).toBe(401)

    // Even with a VALID cookie, a userId in the body is not consulted: the
    // class is owned by the cookie's teacher.
    const created = await handleCreateClass(
      req('http://localhost/api/classes', 'POST', { name: 'OwnerCheck', subjectVersionId: 'math-oge-2026', ownerId: 'someone-else' }, t.cookie),
      p,
    )
    const { class: cls } = await created.json()
    const get = await handleGetClass(req(`http://localhost/api/classes/${cls.id}`, 'GET', undefined, t.cookie), p, cls.id)
    expect(get.status).toBe(200)
    const raw = await p.findByID({ collection: 'classes', id: cls.id, overrideAccess: true })
    expect((raw as unknown as { ownerId: string }).ownerId).toBe(t.userId)
  })

  it('IDOR: teacher B never sees or mutates teacher A\'s class (404, no leak)', async () => {
    const p = await getPayloadSingleton()
    const a = await teacherFixture(p, uniqueEmail('tea-a'))
    const b = await teacherFixture(p, uniqueEmail('tea-b'))

    const created = await handleCreateClass(
      req('http://localhost/api/classes', 'POST', { name: 'Класс А', subjectVersionId: 'rus-oge-2026' }, a.cookie),
      p,
    )
    const { class: cls } = await created.json()

    expect(
      (await handleGetClass(req(`http://localhost/api/classes/${cls.id}`, 'GET', undefined, b.cookie), p, cls.id)).status,
    ).toBe(404)
    expect(
      (await handlePatchClass(req(`http://localhost/api/classes/${cls.id}`, 'PATCH', { name: 'Взлом' }, b.cookie), p, cls.id)).status,
    ).toBe(404)
    expect(
      (await handleGetMembers(req(`http://localhost/api/classes/${cls.id}/members`, 'GET', undefined, b.cookie), p, cls.id)).status,
    ).toBe(404)
    expect(
      (await handleCreateInvite(req(`http://localhost/api/classes/${cls.id}/invites`, 'POST', {}, b.cookie), p, cls.id)).status,
    ).toBe(404)
  })

  it('student actor: cannot create classes (403) or read a teacher class (404)', async () => {
    const p = await getPayloadSingleton()
    const t = await teacherFixture(p)
    const created = await handleCreateClass(
      req('http://localhost/api/classes', 'POST', { name: 'Класс', subjectVersionId: 'math-ege-2026' }, t.cookie),
      p,
    )
    const { class: cls } = await created.json()

    // A student account via the same trusted path the join uses.
    const student = await p.create({
      collection: 'users',
      data: { email: uniqueEmail('stu'), password: 'longpass123', name: 'Ученик', role: 'student', emailConfirmed: true },
      overrideAccess: true,
    })
    expect(student.role).toBe('student')
    const adapter = createSessionAdapter({ payload: p, clock: { now: () => Date.now() }, sessionTtlMs: HOUR })
    const login = await adapter.login({ email: student.email, password: 'longpass123' })
    expect(login.ok).toBe(true)
    const studentCookie = `eclass_session=${login.ok ? login.sessionId : ''}`

    expect(
      (await handleCreateClass(
        req('http://localhost/api/classes', 'POST', { name: 'X', subjectVersionId: 'math-oge-2026' }, studentCookie),
        p,
      )).status,
    ).toBe(403)
    expect(
      (await handleGetClass(req(`http://localhost/api/classes/${cls.id}`, 'GET', undefined, studentCookie), p, cls.id)).status,
    ).toBe(404)
  })

  it('invite: owner-only minting, opaque code, roster shape is id+displayName only', async () => {
    const p = await getPayloadSingleton()
    const t = await teacherFixture(p)
    const created = await handleCreateClass(
      req('http://localhost/api/classes', 'POST', { name: 'Приглашения', subjectVersionId: 'inf-ege-2026' }, t.cookie),
      p,
    )
    const { class: cls } = await created.json()

    const invite = await handleCreateInvite(
      req(`http://localhost/api/classes/${cls.id}/invites`, 'POST', {}, t.cookie),
      p,
      cls.id,
    )
    expect(invite.status).toBe(201)
    const inviteBody = await invite.json()
    expect(inviteBody.code).toMatch(/^[A-Z2-9]{8}$/)
    // Opaque: no class id, no teacher id inside the code.
    expect(inviteBody.code).not.toContain(cls.id)
    expect(inviteBody.code).not.toContain(t.userId)

    // Student joins atomically; the roster then shows displayName only.
    const join = await handleJoin(
      req('http://localhost/api/join', 'POST', {
        code: inviteBody.code,
        login: uniqueEmail('joinstu'),
        displayName: 'Аня',
        password: 'longpass123',
      }),
      p,
    )
    expect(join.status).toBe(200)
    expect(cookieOf(join)).toBeTruthy()

    const members = await handleGetMembers(
      req(`http://localhost/api/classes/${cls.id}/members`, 'GET', undefined, t.cookie),
      p,
      cls.id,
    )
    expect(members.status).toBe(200)
    const roster = await members.json()
    expect(roster.items).toHaveLength(1)
    expect(roster.items[0]).toEqual({ id: roster.items[0].id, displayName: 'Аня' })
    // No email in the roster payload.
    const raw = JSON.stringify(roster)
    expect(raw).not.toContain('@')
  })
})
