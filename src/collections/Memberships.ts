import type { CollectionConfig, Where } from 'payload'

/**
 * Memberships — ECLASS-56 / ECLASS-62.
 *
 * Roster link student↔class. SECURITY (ECLASS-62): read access resolves the
 * caller's scope at query time — a teacher sees only memberships of classes
 * THEY own (resolved via a Local API lookup of their class ids), and a student
 * sees only their own membership rows. There is no blanket "teachers read all"
 * path: the previous `return true` for teachers leaked every membership.
 *
 * Mutation is server-only (invite/move flows); clients never write directly.
 */
export const Memberships: CollectionConfig = {
  slug: 'memberships',
  access: {
    read: async ({ req }): Promise<Where | boolean> => {
      if (!req.user) return false
      if (req.user.role === 'admin') return true
      if (req.user.role === 'student') return { studentId: { equals: req.user.id } }
      if (req.user.role === 'teacher') {
        // Resolve the class ids this teacher owns, then constrain memberships
        // to those classes. Without this join, a bare query would leak every
        // teacher's rosters. If the teacher owns no classes, return a where
        // that matches nothing ({ in: [] }) rather than `false`, so a find
        // yields zero docs instead of throwing Forbidden — the caller is
        // legitimately allowed to read their (empty) scope.
        const owned = await req.payload.find({
          collection: 'classes',
          where: { ownerId: { equals: req.user.id } },
          limit: 100,
          overrideAccess: true,
          depth: 0,
        })
        const classIds = owned.docs.map((c) => c.id)
        return { classId: { in: classIds } }
      }
      return { studentId: { exists: false } }
    },
    create: () => false,
    update: () => false,
    delete: () => false,
  },
  fields: [
    { name: 'classId', type: 'text', required: true },
    { name: 'studentId', type: 'text', required: true },
  ],
  indexes: [{ fields: ['classId', 'studentId'], unique: true }],
}
