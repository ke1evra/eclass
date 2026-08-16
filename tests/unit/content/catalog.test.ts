import { describe, expect, it } from 'vitest'
import { SUBJECT_CATALOG, findSubjectVersion, listSubjectVersions } from '@/content/catalog'

/** ECLASS-56 Stage A — the static MVP subject catalog behind T2. */
describe('subject version catalog', () => {
  it('finds a version by id and derives subject/exam/year', () => {
    const v = findSubjectVersion('math-oge-2026')!
    expect(v.subject).toBe('Математика')
    expect(v.exam).toBe('oge')
    expect(v.academicYear).toBe(2026)
  })

  it('returns undefined for unknown ids (no free-text subjects)', () => {
    expect(findSubjectVersion('whatever')).toBeUndefined()
    expect(findSubjectVersion('')).toBeUndefined()
  })

  it('exposes the full list for the T2 select; ids are unique', () => {
    const all = listSubjectVersions()
    expect(all.length).toBe(SUBJECT_CATALOG.length)
    expect(new Set(all.map((v) => v.id)).size).toBe(all.length)
  })
})
