/**
 * Subject version catalog — ECLASS-56 (Stage A).
 *
 * The static MVP catalog backs T2 (create class): the teacher picks a
 * subject+exam, the class stores the immutable `subjectVersionId`. A real
 * editable catalog lands with the content cabinet (ECLASS-70); until then the
 * set of versions is code, which keeps class creation honest (no free-text
 * subject) and gives the student workspace subjectName/examTarget without a
 * join on a not-yet-existing subjects collection.
 */

export interface SubjectVersionInfo {
  id: string
  subject: string
  exam: 'oge' | 'ege'
  academicYear: number
}

export const SUBJECT_CATALOG: readonly SubjectVersionInfo[] = [
  { id: 'math-oge-2026', subject: 'Математика', exam: 'oge', academicYear: 2026 },
  { id: 'math-ege-2026', subject: 'Математика', exam: 'ege', academicYear: 2026 },
  { id: 'rus-oge-2026', subject: 'Русский язык', exam: 'oge', academicYear: 2026 },
  { id: 'rus-ege-2026', subject: 'Русский язык', exam: 'ege', academicYear: 2026 },
  { id: 'inf-ege-2026', subject: 'Информатика', exam: 'ege', academicYear: 2026 },
  { id: 'phys-ege-2026', subject: 'Физика', exam: 'ege', academicYear: 2026 },
] as const

export const findSubjectVersion = (id: string): SubjectVersionInfo | undefined =>
  SUBJECT_CATALOG.find((v) => v.id === id)

export const listSubjectVersions = (): readonly SubjectVersionInfo[] => SUBJECT_CATALOG
