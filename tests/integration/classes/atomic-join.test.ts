import { beforeEach, describe, expect, it } from 'vitest'
import type { Payload } from 'payload'
import { clearData, getPayloadSingleton, integrationSuite, uniqueEmail } from '../_payload'
import { createAtomicJoin } from '@/classes/atomic-join'
import { getClassServices } from '@/classes/server'
import type { Actor } from '@/domain/authorization'

/**
 * ECLASS-57 — atomic invite acceptance on the real Mongo replica set.
 *
 *   - two PARALLEL accepts of the same code → exactly ONE membership + one
 *     success; the loser gets invite_used and leaves no user behind;
 *   - failure BETWEEN claim and membership insert → full rollback: invite NOT
 *     consumed, no orphan membership, no stranded user;
 *   - expired / revoked / unknown / used codes return their specific codes;
 *   - duplicate login → conflict with a clean retry path;
 *   - the unique (classId, studentId) index exists and rejects duplicates.
 */

const joinInput = (code: string, overrides: Partial<Parameters<ReturnType<typeof createAtomicJoin>['acceptInviteAndCreateStudent']>[0]> = {}) => ({
  code,
  login: uniqueEmail('stu'),
  displayName: 'Ученик Тест',
  password: 'longpass123',
  ...overrides,
})

async function seedClassWithInvite(p: Payload, overrides: Partial<{ expiresAt: number; revoked: boolean; usedBy: string }> = {}) {
  const teacher = await p.create({
    collection: 'users',
    data: { email: uniqueEmail('inv-tea'), password: 'longpass123', emailConfirmed: true },
    overrideAccess: true,
  })
  const actor: Actor = { id: String(teacher.id), role: 'teacher' }
  const { classService, inviteService } = getClassServices(p)
  const cls = await classService.createClass({ actor, name: 'Атомный класс', subjectVersionId: 'math-oge-2026' })
  if (!cls.ok) throw new Error('seed failed')
  const invite = await inviteService.createInvite(actor, cls.class.id)
  if (!invite.ok) throw new Error('invite seed failed')

  if (Object.keys(overrides).length > 0) {
    await p.db.connection.collection('invites').updateOne(
      { code: invite.code },
      { $set: overrides },
    )
  }
  return { classId: cls.class.id, code: invite.code, teacherId: teacher.id }
}

integrationSuite('ECLASS-57: atomic invite acceptance (Mongo transactions)', () => {
  beforeEach(clearData)

  it('happy path: student account + membership + consumed invite in one commit', async () => {
    const p = await getPayloadSingleton()
    const join = createAtomicJoin({ payload: p, clock: { now: () => Date.now() } })
    const { classId, code } = await seedClassWithInvite(p)
    const login = uniqueEmail('happy')

    const result = await join.acceptInviteAndCreateStudent(joinInput(code, { login }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.classId).toBe(classId)

    const user = await p.findByID({ collection: 'users', id: result.studentId, overrideAccess: true })
    expect((user as unknown as { role: string }).role).toBe('student')
    expect((user as unknown as { emailConfirmed: boolean }).emailConfirmed).toBe(true)

    const inv = await p.db.connection.collection('invites').findOne({ code })
    expect(inv?.usedBy).toBe(result.studentId)

    const memberCount = await p.count({
      collection: 'memberships',
      where: { and: [{ classId: { equals: classId } }, { studentId: { equals: result.studentId } }] },
      overrideAccess: true,
    })
    expect(memberCount.totalDocs).toBe(1)
  })

  it('two PARALLEL accepts → exactly one membership; loser: invite_used, no stranded user', async () => {
    const p = await getPayloadSingleton()
    const join = createAtomicJoin({ payload: p, clock: { now: () => Date.now() } })
    const { classId, code } = await seedClassWithInvite(p)
    const loginA = uniqueEmail('race-a')
    const loginB = uniqueEmail('race-b')

    const [a, b] = await Promise.all([
      join.acceptInviteAndCreateStudent(joinInput(code, { login: loginA, displayName: 'A' })),
      join.acceptInviteAndCreateStudent(joinInput(code, { login: loginB, displayName: 'B' })),
    ])

    const outcomes = [a, b].sort((x, y) => (x.ok === y.ok ? 0 : x.ok ? -1 : 1))
    expect(outcomes[0]!.ok).toBe(true)
    expect(outcomes[1]).toEqual({ ok: false, code: 'invite_used' })

    const members = await p.count({
      collection: 'memberships',
      where: { classId: { equals: classId } },
      overrideAccess: true,
    })
    expect(members.totalDocs).toBe(1)

    // The loser's account was rolled back with the transaction.
    const loserLogin = outcomes[0]!.ok && a.ok ? loginB : loginA
    const stranded = await p.find({
      collection: 'users',
      where: { email: { equals: loserLogin } },
      overrideAccess: true,
    })
    expect(stranded.totalDocs).toBe(0)
  })

  it('failure between claim and membership insert → FULL rollback (invite not consumed)', async () => {
    const p = await getPayloadSingleton()
    const { code } = await seedClassWithInvite(p)

    // Fault injection at the boundary: memberships insert fails AFTER the
    // invite was claimed inside the transaction.
    const failingPayload = new Proxy(p as unknown as Record<string | symbol, unknown>, {
      get(target, prop) {
        if (prop !== 'db') return Reflect.get(target, prop)
        const db = target[prop as 'db'] as Record<string, unknown>
        return new Proxy(db, {
          get(dbTarget, dbProp) {
            if (dbProp !== 'connection') return Reflect.get(dbTarget, dbProp)
            const conn = dbTarget[dbProp as 'connection'] as {
              collection: (name: string) => { insertOne: (doc: unknown, opts: unknown) => Promise<unknown> }
            }
            return new Proxy(conn, {
              get(connTarget, connProp) {
                if (connProp !== 'collection') return Reflect.get(connTarget, connProp)
                const orig = connTarget.collection.bind(connTarget)
                return (name: string) => {
                  const coll = orig(name)
                  if (name !== 'memberships') return coll
                  return {
                    ...coll,
                    insertOne: async () => {
                      throw new Error('injected membership failure')
                    },
                  }
                }
              },
            })
          },
        })
      },
    }) as unknown as Payload

    const join = createAtomicJoin({ payload: failingPayload, clock: { now: () => Date.now() } })
    const login = uniqueEmail('rollback')
    await expect(join.acceptInviteAndCreateStudent(joinInput(code, { login }))).rejects.toThrow(
      'injected membership failure',
    )

    // NOTHING persisted: invite unconsumed, no membership, no stranded user.
    const inv = await p.db.connection.collection('invites').findOne({ code })
    expect(inv?.usedBy ?? null).toBeNull()
    const users = await p.find({ collection: 'users', where: { email: { equals: login } }, overrideAccess: true })
    expect(users.totalDocs).toBe(0)
    const members = await p.count({ collection: 'memberships', where: {}, overrideAccess: true })
    expect(members.totalDocs).toBe(0)
  })

  it('expired / revoked / unknown / used codes return the specific safe codes', async () => {
    const p = await getPayloadSingleton()
    const join = createAtomicJoin({ payload: p, clock: { now: () => Date.now() } })

    const expired = await seedClassWithInvite(p, { expiresAt: Date.now() - 1000 })
    expect(await join.acceptInviteAndCreateStudent(joinInput(expired.code))).toEqual({
      ok: false,
      code: 'invite_expired',
    })

    const revoked = await seedClassWithInvite(p, { revoked: true })
    expect(await join.acceptInviteAndCreateStudent(joinInput(revoked.code))).toEqual({
      ok: false,
      code: 'invite_revoked',
    })

    expect(await join.acceptInviteAndCreateStudent(joinInput('NOPE1234'))).toEqual({
      ok: false,
      code: 'invite_invalid',
    })

    const used = await seedClassWithInvite(p, { usedBy: 'someone-before' })
    expect(await join.acceptInviteAndCreateStudent(joinInput(used.code))).toEqual({
      ok: false,
      code: 'invite_used',
    })
  })

  it('duplicate login → conflict, and the invite stays unconsumed (clean retry)', async () => {
    const p = await getPayloadSingleton()
    const join = createAtomicJoin({ payload: p, clock: { now: () => Date.now() } })
    const { code } = await seedClassWithInvite(p)
    const taken = uniqueEmail('taken')
    await p.create({
      collection: 'users',
      data: { email: taken, password: 'longpass123', emailConfirmed: true },
      overrideAccess: true,
    })

    const result = await join.acceptInviteAndCreateStudent(joinInput(code, { login: taken }))
    expect(result).toEqual({ ok: false, code: 'conflict' })

    const inv = await p.db.connection.collection('invites').findOne({ code })
    expect(inv?.usedBy ?? null).toBeNull()

    // Retry with a free login succeeds on the SAME code.
    const retry = await join.acceptInviteAndCreateStudent(joinInput(code))
    expect(retry.ok).toBe(true)
  })

  it('the (classId, studentId) unique index physically rejects duplicates', async () => {
    const p = await getPayloadSingleton()
    const { classId } = await seedClassWithInvite(p)
    const coll = p.db.connection.collection('memberships')
    await coll.insertOne({ classId, studentId: 'stu-dup' })
    await expect(coll.insertOne({ classId, studentId: 'stu-dup' })).rejects.toMatchObject({
      code: 11_000,
    })
  })

  it('validation branches: malformed code / login / displayName / password → validation_error', async () => {
    const p = await getPayloadSingleton()
    const join = createAtomicJoin({ payload: p, clock: { now: () => Date.now() } })

    expect(await join.acceptInviteAndCreateStudent({ code: '', login: 'a@b.ru', displayName: 'X', password: 'longpass123' })).toEqual({ ok: false, code: 'validation_error' })
    expect(await join.acceptInviteAndCreateStudent({ code: 'A'.repeat(80), login: 'a@b.ru', displayName: 'X', password: 'longpass123' })).toEqual({ ok: false, code: 'validation_error' })
    expect(await join.acceptInviteAndCreateStudent({ code: 'ABCD2345', login: 'not-an-email', displayName: 'X', password: 'longpass123' })).toEqual({ ok: false, code: 'validation_error' })
    expect(await join.acceptInviteAndCreateStudent({ code: 'ABCD2345', login: 'a@b.ru', displayName: '   ', password: 'longpass123' })).toEqual({ ok: false, code: 'validation_error' })
    expect(await join.acceptInviteAndCreateStudent({ code: 'ABCD2345', login: 'a@b.ru', displayName: 'X', password: 'short' })).toEqual({ ok: false, code: 'validation_error' })
  })
})
