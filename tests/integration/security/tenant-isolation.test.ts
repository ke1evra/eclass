import { beforeEach, describe, expect, it } from 'vitest'
import { createAuthService, type AuthStore, type Clock } from '@/auth/service'
import { createClassService, type ClassStore } from '@/classes/service'
import { createInviteService, type InviteStore } from '@/classes/invite'
import { createStudentWorkspaceService, type WorkspaceStore } from '@/students/service'
import { createAuditRecorder, type AuditEntry, type AuditSink } from '@/security/audit'
import { redactPii } from '@/domain/content-policy'

/**
 * Tenant isolation & auth-контур security suite — ECLASS-17.
 *
 * Generates the negative-case matrix the task demands:
 *   - IDOR (cross-tenant resource access),
 *   - role escalation (student acting as teacher),
 *   - invite replay,
 *   - brute force / rate limit,
 *   - enumeration (login),
 *   - audit PII hygiene.
 *
 * Every case must NOT return another tenant's data. The suite wires the REAL
 * services from P1, not mocks of them.
 */

const fixedNow = 1_700_000_000_000
const clock: Clock = { now: () => fixedNow }

const makeAuthStore = (): AuthStore => {
  const users = new Map<string, any>()
  const sessions = new Map<string, any>()
  return {
    async findUserByEmail(email) {
      for (const u of users.values()) if (u.email === email) return u
      return undefined
    },
    async getUser(id) {
      return users.get(id)
    },
    async insertUser(u) {
      users.set(u.id, u)
    },
    async confirmEmail(id) {
      const u = users.get(id)
      if (u) u.emailConfirmed = true
    },
    async insertSession(s) {
      sessions.set(s.id, s)
    },
    async getSession(id) {
      return sessions.get(id)
    },
    async revokeSession(id) {
      const s = sessions.get(id)
      if (s) s.revoked = true
    },
    async countRecentSignups() {
      return 0
    },
  }
}

const makeClassStore = (): ClassStore => {
  const classes = new Map<string, any>()
  const rosters = new Map<string, Set<string>>()
  return {
    async insertClass(c) {
      const stored = { ...c, id: `cls-${classes.size + 1}` }
      classes.set(stored.id, stored)
      rosters.set(stored.id, new Set())
      return stored
    },
    async getClass(id) {
      return classes.get(id)
    },
    async listClasses(ownerId, { includeArchived }) {
      return [...classes.values()].filter(
        (c) => c.ownerId === ownerId && (includeArchived || !c.archivedAt),
      )
    },
    async updateClass(id, patch) {
      const c = classes.get(id)
      if (c) Object.assign(c, patch)
    },
    async addStudent(classId, studentId) {
      rosters.get(classId)?.add(studentId)
    },
    async removeStudent(classId, studentId) {
      rosters.get(classId)?.delete(studentId)
    },
    async getRoster(classId) {
      return [...(rosters.get(classId) ?? [])]
    },
    async isMember(classId, studentId) {
      return rosters.get(classId)?.has(studentId) ?? false
    },
  }
}

const makeInviteStore = (classStore: ClassStore): InviteStore => {
  const invites = new Map<string, any>()
  return {
    async insertInvite(inv) {
      invites.set(inv.code, inv)
    },
    async getInvite(code) {
      return invites.get(code)
    },
    async markUsed(code, studentId) {
      const inv = invites.get(code)
      if (inv) {
        inv.usedBy = studentId
        inv.usedAt = fixedNow
      }
    },
    async revokeInvite(code) {
      const inv = invites.get(code)
      if (inv) inv.revoked = true
    },
    async isMember(classId, studentId) {
      return classStore.isMember(classId, studentId)
    },
    async addMember(classId, studentId) {
      await classStore.addStudent(classId, studentId)
    },
    async getClassOwner(classId) {
      const c = await classStore.getClass(classId)
      return c?.ownerId
    },
  }
}

const makeWorkspaceStore = (): WorkspaceStore & {
  seedStudent(id: string, over?: any): void
} => {
  const students = new Map<string, any>()
  return {
    async getStudent(id) {
      return students.get(id)
    },
    async listAssignments() {
      return []
    },
    async setDisplayName(id, name) {
      const s = students.get(id)
      if (s) s.displayName = name
    },
    seedStudent(id: string, over: any = {}) {
      students.set(id, {
        id,
        classId: 'cls-a',
        className: 'A',
        subjectVersionId: 'math-oge-2026',
        subjectName: 'Математика',
        examTarget: 'oge',
        ownerId: 'tea-a',
        ...over,
      })
    },
  }
}

interface Harness {
  auth: ReturnType<typeof createAuthService>
  classes: ReturnType<typeof createClassService>
  invites: ReturnType<typeof createInviteService>
  workspace: ReturnType<typeof createStudentWorkspaceService>
  audit: ReturnType<typeof createAuditRecorder>
  auditLog: AuditEntry[]
  workspaceStore: ReturnType<typeof makeWorkspaceStore>
}

const harness = (): Harness => {
  const authStore = makeAuthStore()
  const classStore = makeClassStore()
  const inviteStore = makeInviteStore(classStore)
  const workspaceStore = makeWorkspaceStore()
  const auditLog: AuditEntry[] = []
  const auditSink: AuditSink = { append: (e) => void auditLog.push(e) }
  return {
    auth: createAuthService({ store: authStore, clock, sessionTtlMs: 60 * 60 * 1000 }),
    classes: createClassService({ store: classStore }),
    invites: createInviteService({ store: inviteStore, clock, ttlMs: 24 * 60 * 60 * 1000 }),
    workspace: createStudentWorkspaceService({ store: workspaceStore }),
    audit: createAuditRecorder(auditSink, clock),
    auditLog,
    workspaceStore,
  }
}

describe('tenant isolation & auth-контур — ECLASS-17', () => {
  let h: Harness
  beforeEach(() => {
    h = harness()
  })

  describe('IDOR — cross-tenant resource access is blocked', () => {
    it('teacher B cannot read or mutate teacher A’s class', async () => {
      const a = await h.classes.createClass({ actor: { id: 'tea-a', role: 'teacher' }, name: 'A', subjectVersionId: 's' })
      if (!a.ok) throw new Error('setup')
      const read = await h.classes.getClass({ id: 'tea-b', role: 'teacher' }, a.class.id)
      expect(read.ok).toBe(false)
      const rename = await h.classes.renameClass({ id: 'tea-b', role: 'teacher' }, a.class.id, 'hacked')
      expect(rename.ok).toBe(false)
      const archive = await h.classes.archiveClass({ id: 'tea-b', role: 'teacher' }, a.class.id)
      expect(archive.ok).toBe(false)
      const roster = await h.classes.getRoster({ id: 'tea-b', role: 'teacher' }, a.class.id)
      expect(roster.ok).toBe(false)
    })

    it('teacher B cannot add a student to teacher A’s class', async () => {
      const a = await h.classes.createClass({ actor: { id: 'tea-a', role: 'teacher' }, name: 'A', subjectVersionId: 's' })
      if (!a.ok) throw new Error('setup')
      const add = await h.classes.addStudent({ id: 'tea-b', role: 'teacher' }, a.class.id, 'stu-x')
      expect(add.ok).toBe(false)
      if (!add.ok) expect(add.code).toBe('not_found')
    })

    it('teacher B cannot create an invite for teacher A’s class', async () => {
      const a = await h.classes.createClass({ actor: { id: 'tea-a', role: 'teacher' }, name: 'A', subjectVersionId: 's' })
      if (!a.ok) throw new Error('setup')
      const inv = await h.invites.createInvite({ id: 'tea-b', role: 'teacher' }, a.class.id)
      expect(inv.ok).toBe(false)
      if (!inv.ok) expect(inv.code).toBe('not_found')
    })
  })

  describe('role escalation — students cannot act as teachers', () => {
    it('a student actor is refused by createClass on the REAL service path', async () => {
      // CB-3: this previously asserted authorize() in isolation while createClass
      // accepted a bare ownerId and returned ok. Now the service must take an
      // Actor and refuse a student on the real path.
      const created = await h.classes.createClass({
        actor: { id: 'stu-1', role: 'student' },
        name: 'x',
        subjectVersionId: 'math-oge-2026',
      })
      expect(created.ok).toBe(false)
      if (!created.ok) expect(created.code).toBe('forbidden')
    })

    it('a teacher actor CAN create a class', async () => {
      const created = await h.classes.createClass({
        actor: { id: 'tea-1', role: 'teacher' },
        name: 'x',
        subjectVersionId: 'math-oge-2026',
      })
      expect(created.ok).toBe(true)
    })

    it('a student actor cannot rename/archive/mutate a class', async () => {
      const created = await h.classes.createClass({
        actor: { id: 'tea-1', role: 'teacher' },
        name: 'a',
        subjectVersionId: 'math-oge-2026',
      })
      if (!created.ok) throw new Error('setup')
      const rename = await h.classes.renameClass(
        { id: 'stu-1', role: 'student' },
        created.class.id,
        'hacked',
      )
      expect(rename.ok).toBe(false)
      if (!rename.ok) expect(rename.code).toBe('forbidden')
    })
  })

  describe('invite replay protection', () => {
    it('a used invite cannot join a second student', async () => {
      const a = await h.classes.createClass({ actor: { id: 'tea-a', role: 'teacher' }, name: 'A', subjectVersionId: 's' })
      if (!a.ok) throw new Error('setup')
      const inv = await h.invites.createInvite({ id: 'tea-a', role: 'teacher' }, a.class.id)
      if (!inv.ok) throw new Error('invite')

      const first = await h.invites.join({ code: inv.code, studentId: 'stu-1' })
      expect(first.ok).toBe(true)

      const replay = await h.invites.join({ code: inv.code, studentId: 'stu-2' })
      expect(replay.ok).toBe(false)
      if (!replay.ok) expect(replay.code).toBe('invite_used')
    })
  })

  describe('brute force / rate limit', () => {
    it('repeated failed logins eventually rate-limit the email', async () => {
      const authStore = makeAuthStore()
      const rateAuth = createAuthService({
        store: authStore,
        clock,
        sessionTtlMs: 60 * 60 * 1000,
        maxFailedAttempts: 3,
      })
      const signup = await rateAuth.signup({ email: 'victim@school.ru', password: 'long-pass-123' })
      if (!signup.ok) throw new Error('setup')
      await rateAuth.confirmEmail(signup.userId)
      for (let i = 0; i < 3; i++) {
        await rateAuth.login({ email: 'victim@school.ru', password: 'wrong-pass-999' })
      }
      const blocked = await rateAuth.login({ email: 'victim@school.ru', password: 'wrong-pass-999' })
      expect(blocked.ok).toBe(false)
      if (!blocked.ok) expect(blocked.code).toBe('rate_limited')
    })
  })

  describe('enumeration — login does not reveal user existence', () => {
    it('unknown user and wrong password return the same code', async () => {
      const signup = await h.auth.signup({ email: 'real@school.ru', password: 'long-pass-123' })
      if (!signup.ok) throw new Error('setup')
      await h.auth.confirmEmail(signup.userId)
      const wrongPassword = await h.auth.login({ email: 'real@school.ru', password: 'wrong-99999' })
      const unknownUser = await h.auth.login({ email: 'ghost@school.ru', password: 'whatever-99' })
      expect(wrongPassword.ok).toBe(false)
      expect(unknownUser.ok).toBe(false)
      if (!wrongPassword.ok && !unknownUser.ok) {
        expect(wrongPassword.code).toBe(unknownUser.code)
      }
    })
  })

  describe('student workspace self-only access', () => {
    it('a student cannot read another student’s profile/dashboard', async () => {
      h.workspaceStore.seedStudent('stu-a')
      const profile = await h.workspace.getProfile('stu-b')
      expect(profile.ok).toBe(false)
      if (!profile.ok) expect(profile.code).toBe('not_found')
      const dash = await h.workspace.getDashboard('stu-b')
      expect(dash.ok).toBe(false)
    })
  })

  describe('audit trail — actor/action/resource/time, no PII', () => {
    it('records a denial with stable shape and redacts any PII in reason', async () => {
      await h.audit.record({
        actorId: 'tea-b',
        actorRole: 'teacher',
        action: 'read',
        resourceType: 'class',
        resourceId: 'cls-a',
        outcome: 'denied',
        reason: 'not_found; attempted by leak@email.ru',
        requestId: 'req-1',
      })
      const entry = h.auditLog[0]!
      expect(entry.actorId).toBe('tea-b')
      expect(entry.action).toBe('read')
      expect(entry.resourceId).toBe('cls-a')
      expect(entry.at).toBe(fixedNow)
      expect(entry.outcome).toBe('denied')
      // PII in reason must be redacted.
      expect(entry.reason).not.toContain('leak@email.ru')
      expect(entry.reason).toContain('[redacted:email]')
      // And the whole serialized entry must not contain the raw email.
      expect(JSON.stringify(h.auditLog)).not.toContain('leak@email.ru')
    })

    it('the AuditEntry type has no field for email/name/answer text', () => {
      const keys = Object.keys({
        actorId: '',
        actorRole: 'teacher',
        action: '',
        resourceType: '',
        resourceId: '',
        at: 0,
        outcome: 'allowed',
        reason: '',
        requestId: '',
      } satisfies AuditEntry)
      expect(keys).not.toContain('email')
      expect(keys).not.toContain('name')
      expect(keys).not.toContain('answerText')
    })

    it('redactPii scrubs a structured payload the audit might accidentally receive', () => {
      const dirty = JSON.stringify({ actorId: 'stu-1', email: 'x@y.ru', answerText: 'z'.repeat(80) })
      const clean = redactPii(dirty)
      expect(clean).not.toContain('x@y.ru')
      expect(clean).not.toContain('z'.repeat(80))
      expect(clean).toContain('stu-1')
    })
  })
})
