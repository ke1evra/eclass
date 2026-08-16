import { beforeEach, describe, expect, it } from 'vitest'
import { clearData, getPayloadSingleton, integrationSuite, uniqueEmail } from '../_payload'
import { createPayloadClassStore } from '@/classes/payload-store'
import { getClassServices } from '@/classes/server'
import type { Actor } from '@/domain/authorization'

/**
 * ECLASS-56 — Payload store adapter coverage for the roster/invite edges the
 * route tests do not reach: removeStudent, moveStudent, invite markUsed /
 * revoke / getClassOwner, and the archive-then-read history invariant.
 */
integrationSuite('ECLASS-56: payload class/invite store adapter', () => {
  beforeEach(clearData)

  it('roster lifecycle: add → duplicate guard → remove; move requires both owners', async () => {
    const p = await getPayloadSingleton()
    const { classService } = getClassServices(p)
    const teacher: Actor = { id: 'tea-store', role: 'teacher' }

    const a = await classService.createClass({ actor: teacher, name: 'A', subjectVersionId: 'math-oge-2026' })
    const b = await classService.createClass({ actor: teacher, name: 'B', subjectVersionId: 'math-oge-2026' })
    if (!a.ok || !b.ok) throw new Error('setup')

    const stu = 'stu-store-1'
    expect(await classService.addStudent(teacher, a.class.id, stu)).toEqual({ ok: true, added: true })
    expect(await classService.addStudent(teacher, a.class.id, stu)).toEqual({ ok: false, code: 'conflict' })
    expect(await classService.getRoster(teacher, a.class.id)).toEqual({
      ok: true,
      studentIds: [stu],
    })

    await classService.moveStudent(teacher, stu, a.class.id, b.class.id)
    expect(await classService.getRoster(teacher, a.class.id)).toEqual({ ok: true, studentIds: [] })
    expect(await classService.getRoster(teacher, b.class.id)).toEqual({ ok: true, studentIds: [stu] })

    await classService.removeStudent(teacher, b.class.id, stu)
    expect(await classService.getRoster(teacher, b.class.id)).toEqual({ ok: true, studentIds: [] })
  })

  it('invite store: insert → get → markUsed → revoke; getClassOwner resolves', async () => {
    const p = await getPayloadSingleton()
    const store = createPayloadClassStore(p)
    const { classService } = getClassServices(p)
    const teacher: Actor = { id: 'tea-inv', role: 'teacher' }

    const cls = await classService.createClass({ actor: teacher, name: 'Inv', subjectVersionId: 'rus-ege-2026' })
    if (!cls.ok) throw new Error('setup')
    expect(await store.getClassOwner(cls.class.id)).toBe(teacher.id)
    expect(await store.getClassOwner('nonexistent-id')).toBeUndefined()

    await store.insertInvite({
      code: 'STORETST',
      classId: cls.class.id,
      ownerId: teacher.id,
      createdAt: 1,
      expiresAt: 2,
      revoked: false,
    })
    const got = await store.getInvite('STORETST')
    expect(got?.classId).toBe(cls.class.id)
    expect(got?.revoked).toBe(false)

    await store.markUsed('STORETST', 'stu-x')
    expect((await store.getInvite('STORETST'))?.usedBy).toBe('stu-x')

    await store.revokeInvite('STORETST')
    expect((await store.getInvite('STORETST'))?.revoked).toBe(true)

    // Mark/revoke of an unknown code are no-ops, not throws.
    await store.markUsed('NOPE', 'stu')
    await store.revokeInvite('NOPE')
    expect(await store.getInvite('NOPE')).toBeUndefined()
  })

  it('archived class stays readable (history invariant) but hidden from the default list', async () => {
    const p = await getPayloadSingleton()
    const { classService } = getClassServices(p)
    const teacher: Actor = { id: 'tea-arch', role: 'teacher' }

    const cls = await classService.createClass({ actor: teacher, name: 'Archive me', subjectVersionId: 'inf-ege-2026' })
    if (!cls.ok) throw new Error('setup')
    await classService.archiveClass(teacher, cls.class.id)

    const stillReadable = await classService.getClass(teacher, cls.class.id)
    expect(stillReadable.ok).toBe(true)
    const list = await classService.listClasses(teacher.id, { includeArchived: false })
    expect(list.find((c) => c.id === cls.class.id)).toBeUndefined()
    const withArchived = await classService.listClasses(teacher.id, { includeArchived: true })
    expect(withArchived.find((c) => c.id === cls.class.id)).toBeDefined()
  })
})
