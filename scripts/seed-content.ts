/**
 * Content bank seed — ECLASS-19/21 (demo MVP scope).
 *
 * Idempotent: keyed by unique question `code` (upsert-by-create-if-missing).
 * Source: авторские задачи в структуре ФИПИ ОГЭ (математика, 2026) — topics
 * map to the codifier's skill lines. Answer keys live here only to be stored
 * server-side; the student payload never includes them.
 */
import { getPayload } from 'payload'
import type { Payload } from 'payload'
import config from '../src/payload.config'

interface SeedQuestion {
  code: string
  type: 'single-choice' | 'multiple-choice' | 'short-text' | 'extended-text'
  topic: string
  stem: string
  options?: { id: string; text: string }[]
  answerKey?: unknown
  points: number
}

const Q: SeedQuestion[] = [
  // Числа и вычисления
  { code: 'M-NUM-001', type: 'single-choice', topic: 'Числа и вычисления', points: 1,
    stem: 'Найдите значение выражения 0,7 · (−10)³ − 20.',
    options: [{ id: 'a', text: '−920' }, { id: 'b', text: '−720' }, { id: 'c', text: '−520' }, { id: 'd', text: '920' }],
    answerKey: { id: 'b' } },
  { code: 'M-NUM-002', type: 'short-text', topic: 'Числа и вычисления', points: 1,
    stem: 'Найдите значение выражения (4,9 · 10⁻³) · (4 · 10⁻²).',
    answerKey: { accepted: ['0,000196', '0.000196', '1,96·10^-4'.replace('·', '*')] } },
  { code: 'M-NUM-003', type: 'single-choice', topic: 'Числа и вычисления', points: 1,
    stem: 'Какое из чисел √0,36; √36; √3,6 является иррациональным?',
    options: [{ id: 'a', text: '√0,36' }, { id: 'b', text: '√36' }, { id: 'c', text: '√3,6' }, { id: 'd', text: 'все рациональны' }],
    answerKey: { id: 'c' } },
  // Числовые неравенства, координатная прямая
  { code: 'M-INEQ-001', type: 'single-choice', topic: 'Неравенства', points: 1,
    stem: 'На координатной прямой отмечены числа a и b. Какое из утверждений неверно, если a < b < 0?',
    options: [{ id: 'a', text: 'ab > 0' }, { id: 'b', text: 'a + b < 0' }, { id: 'c', text: 'b − a > 0' }, { id: 'd', text: 'a − b > 0' }],
    answerKey: { id: 'd' } },
  { code: 'M-INEQ-002', type: 'short-text', topic: 'Неравенства', points: 1,
    stem: 'Решите неравенство 7 − 3x ≥ 4x − 7. В ответе укажите наибольшее целое решение, если x < 2.',
    answerKey: { accepted: ['1'] } },
  // Квадратные корни
  { code: 'M-SQRT-001', type: 'short-text', topic: 'Квадратные корни', points: 1,
    stem: 'Найдите значение выражения √45 · √20.',
    answerKey: { accepted: ['30'] } },
  { code: 'M-SQRT-002', type: 'single-choice', topic: 'Квадратные корни', points: 1,
    stem: 'Укажите промежуток, которому принадлежит √77.',
    options: [{ id: 'a', text: '[7; 8]' }, { id: 'b', text: '[8; 9]' }, { id: 'c', text: '[9; 10]' }, { id: 'd', text: '[6; 7]' }],
    answerKey: { id: 'b' } },
  // Уравнения и системы
  { code: 'M-EQ-001', type: 'short-text', topic: 'Уравнения', points: 1,
    stem: 'Решите уравнение x² − 7x + 10 = 0. В ответе укажите больший корень.',
    answerKey: { accepted: ['5'] } },
  { code: 'M-EQ-002', type: 'multiple-choice', topic: 'Уравнения', points: 2,
    stem: 'Выберите ВСЕ числа, являющиеся корнями уравнения x² − 5x + 6 = 0.',
    options: [{ id: 'a', text: '2' }, { id: 'b', text: '3' }, { id: 'c', text: '−2' }, { id: 'd', text: '6' }, { id: 'e', text: '1' }],
    answerKey: { ids: ['a', 'b'] } },
  { code: 'M-EQ-003', type: 'short-text', topic: 'Уравнения', points: 1,
    stem: 'Система: x + y = 7, x − y = 1. Найдите x.',
    answerKey: { accepted: ['4'] } },
  // Функции и графики
  { code: 'M-FN-001', type: 'single-choice', topic: 'Функции', points: 1,
    stem: 'На рисунке прямая y = kx + b проходит через точки (0; −2) и (2; 0). Найдите k.',
    options: [{ id: 'a', text: '1' }, { id: 'b', text: '−1' }, { id: 'c', text: '2' }, { id: 'd', text: '−2' }],
    answerKey: { id: 'a' } },
  { code: 'M-FN-002', type: 'short-text', topic: 'Функции', points: 1,
    stem: 'Найдите значение функции y = x² − 4x + 3 в точке x = 3.',
    answerKey: { accepted: ['0'] } },
  { code: 'M-FN-003', type: 'single-choice', topic: 'Функции', points: 1,
    stem: 'Ветви какой параболы направлены вниз?',
    options: [{ id: 'a', text: 'y = 2x² − x' }, { id: 'b', text: 'y = −x² + 3' }, { id: 'c', text: 'y = x² + 5x' }, { id: 'd', text: 'y = 0,5x²' }],
    answerKey: { id: 'b' } },
  // Прогрессии
  { code: 'M-PRG-001', type: 'short-text', topic: 'Прогрессии', points: 1,
    stem: 'Арифметическая прогрессия: 3, 7, 11, … Найдите её десятый член.',
    answerKey: { accepted: ['39'] } },
  { code: 'M-PRG-002', type: 'short-text', topic: 'Прогрессии', points: 1,
    stem: 'Геометрическая прогрессия: 1, 2, 4, … Найдите сумму первых пяти членов.',
    answerKey: { accepted: ['31'] } },
  // Текстовые задачи
  { code: 'M-TXT-001', type: 'short-text', topic: 'Текстовые задачи', points: 1,
    stem: 'Товар стоил 800 рублей. После скидки 15% он стал стоить… (в рублях)',
    answerKey: { accepted: ['680'] } },
  { code: 'M-TXT-002', type: 'short-text', topic: 'Текстовые задачи', points: 2,
    stem: 'Два велосипедиста выехали одновременно навстречу друг другу из пунктов, расстояние между которыми 60 км, и встретились через 2 часа. Скорость первого 14 км/ч. Найдите скорость второго (км/ч).',
    answerKey: { accepted: ['16'] } },
  // Планиметрия
  { code: 'M-GEO-001', type: 'single-choice', topic: 'Планиметрия', points: 1,
    stem: 'В треугольнике два угла равны 46° и 78°. Найдите третий угол.',
    options: [{ id: 'a', text: '56°' }, { id: 'b', text: '66°' }, { id: 'c', text: '46°' }, { id: 'd', text: '76°' }],
    answerKey: { id: 'a' } },
  { code: 'M-GEO-002', type: 'short-text', topic: 'Планиметрия', points: 1,
    stem: 'Катеты прямоугольного треугольника равны 6 и 8. Найдите гипотенузу.',
    answerKey: { accepted: ['10'] } },
  { code: 'M-GEO-003', type: 'single-choice', topic: 'Планиметрия', points: 1,
    stem: 'Сумма углов выпуклого пятиугольника равна:',
    options: [{ id: 'a', text: '360°' }, { id: 'b', text: '540°' }, { id: 'c', text: '720°' }, { id: 'd', text: '900°' }],
    answerKey: { id: 'b' } },
  // Вероятность и статистика
  { code: 'M-PROB-001', type: 'short-text', topic: 'Вероятность', points: 1,
    stem: 'В мешке 5 красных и 3 синих шара. Какова вероятность вынуть красный шар? (десятичной дробью)',
    answerKey: { accepted: ['0,625', '0.625'] } },
  { code: 'M-PROB-002', type: 'single-choice', topic: 'Вероятность', points: 1,
    stem: 'Среднее арифметическое чисел 4, 8, 12, 16 равно:',
    options: [{ id: 'a', text: '8' }, { id: 'b', text: '10' }, { id: 'c', text: '12' }, { id: 'd', text: '9' }],
    answerKey: { id: 'b' } },
  // Развёрнутые ответы (рубрики)
  { code: 'M-EXT-001', type: 'extended-text', topic: 'Уравнения', points: 2,
    stem: 'Решите уравнение (x² − 25) / (x − 5) = 0. Запишите полное решение: область допустимых значений, преобразование, ответ.' },
  { code: 'M-EXT-002', type: 'extended-text', topic: 'Планиметрия', points: 3,
    stem: 'В равнобедренном треугольнике ABC с основанием AC угол при вершине B равен 120°, боковая сторона равна 12. Найдите площадь треугольника. Запишите полное решение с обоснованием.' },
  { code: 'M-EXT-003', type: 'extended-text', topic: 'Текстовые задачи', points: 3,
    stem: 'Мастер выполняет заказ на 3 часа быстрее ученика. Вместе они выполняют заказ за 2 часа. За сколько часов выполнит заказ мастер? Запишите полное решение (уравнение, преобразования, ответ со смысловой проверкой).' },
]

/** Idempotent seed of the demo bank; reused by the E2E global setup. */
export async function seedContent(payload: Payload, subjectVersionId = 'math-oge-2026'): Promise<{ created: number; total: number }> {
  let created = 0
  for (const q of Q) {
    const existing = await payload.find({
      collection: 'questions',
      where: { code: { equals: q.code } },
      limit: 1,
      overrideAccess: true,
    })
    if (existing.totalDocs > 0) continue
    await payload.create({
      collection: 'questions',
      data: {
        subjectVersionId,
        code: q.code,
        revisionNumber: 1,
        type: q.type,
        topic: q.topic,
        stem: q.stem,
        options: q.options ?? [],
        answerKey: q.answerKey ?? null,
        points: q.points,
        source: 'authored',
        editorStatus: 'published',
        publishedAt: Date.now(),
      },
      overrideAccess: true,
    })
    created++
  }
  return { created, total: Q.length }
}

const main = async (): Promise<void> => {
  const payload = await getPayload({ config })
  const subjectVersionId = process.env.SEED_SUBJECT ?? 'math-oge-2026'
  const { created, total } = await seedContent(payload, subjectVersionId)
  console.log('SEED_CONTENT_DONE', `created=${created}`, `total=${total}`, `subject=${subjectVersionId}`)
  process.exit(0)
}

if (process.argv[1]?.includes('seed-content')) {
  main().catch((err) => {
    console.error('[seed-content] FAILED:', err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
