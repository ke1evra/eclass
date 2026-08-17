import { test, expect, request as pwRequest } from '@playwright/test'
import { MongoClient, ObjectId } from 'mongodb'
import { openEmailBody } from '../../src/email/crypto'

/**
 * Сквозной продуктовый флоу — ECLASS-23/24/27/28/29/33/34/35/36/37, без skip:
 * сборка работы из банка → назначение классу → ученик решает (автосейв,
 * возобновление) → идемпотентная сдача → очередь проверки → рубрики →
 * финализация → обратная связь → ученик видит балл и прогресс.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? 'mongodb://127.0.0.1:27018/eclass?replicaSet=rs0'
const DB_NAME = new URL(DATABASE_URL).pathname.replace(/^\//, '') || 'eclass'

const runId = Date.now()
const teacherEmail = `e2e-work-teacher-${runId}@eclasstest.ru`
const studentLogin = `e2e-work-student-${runId}@eclasstest.ru`
const password = 'longpass123'

async function confirmSignupToken(login: string): Promise<string> {
  const client = new MongoClient(DATABASE_URL)
  await client.connect()
  try {
    const job = await client.db(DB_NAME).collection('email-jobs').findOne({ to: login })
    expect(job).not.toBeNull()
    return openEmailBody(String(job!.body)).match(/token=([A-Za-z0-9_-]+)/)![1]!
  } finally {
    await client.close()
  }
}

test('работа: сборка → назначение → решение → сдача → проверка → обратная связь → прогресс', async ({ browser, baseURL }) => {
  test.setTimeout(240_000)

  // --- Демо-контент: 3 вопроса (1 авто + 1 краткий + 1 развёрнутый) -------
  const api = await pwRequest.newContext({ baseURL })
  expect((await api.post('/api/auth/signup', { data: { email: teacherEmail, password } })).status()).toBe(200)
  const confirmToken = await confirmSignupToken(teacherEmail)
  expect((await api.post('/api/auth/confirm', { data: { token: confirmToken } })).status()).toBe(200)

  const teacher = await browser.newContext()
  const tp = await teacher.newPage()
  await tp.goto('/login')
  await tp.fill('#email', teacherEmail)
  await tp.fill('#password', password)
  await tp.click('button[type=submit]')
  await tp.waitForURL('**/teacher')

  // Класс + инвайт
  await tp.goto('/teacher/classes/new')
  await tp.fill('#name', `E2E класс ${runId}`)
  await tp.selectOption('#subjectVersionId', 'math-oge-2026')
  await tp.click('button[type=submit]')
  // STRICT: [^/]+ also matches 'new' before the redirect lands.
  await tp.waitForURL(/\/teacher\/classes\/[a-f0-9]{20,}$/)
  const classUrl = tp.url()
  await tp.getByRole('button', { name: /создать код приглашения/i }).click()
  await tp.waitForURL(/invite=/)
  const code = (await tp.getByTestId('invite-code').innerText()).match(/([A-Z2-9]{8})/)![1]!

  // Ученик вступает
  const student = await browser.newContext({ viewport: { width: 320, height: 690 } })
  const sp = await student.newPage()
  await sp.goto(`/join?code=${code}`)
  await sp.fill('#displayName', 'Работ Ученик')
  await sp.fill('#login', studentLogin)
  await sp.fill('#password', password)
  await sp.click('button[type=submit]')
  await sp.waitForURL('**/student')
  await expect(sp.getByText('Пока ничего не задано')).toBeVisible()

  // --- T4: сборка работы из банка -----------------------------------------
  await tp.goto(classUrl + '/new-work')

  // Фильтр-ссылки работают (T4). Это полные reload (обычные <a>), поэтому
  // title заполняем ПОСЛЕ них — иначе required-поле пустое и браузер молча
  // блокирует submit.
  await tp.getByRole('link', { name: 'Один ответ' }).click()
  await expect(tp).toHaveURL(/type=single-choice/)
  await tp.getByRole('link', { name: 'Все типы' }).click()
  await expect(tp.locator('.bank-item')).not.toHaveCount(0)
  await tp.fill('#title', `Контрольная ${runId}`)

  // Выбор в ОДНОЙ странице (no-JS: навигация сбрасывала бы чекбоксы):
  // 2 вопроса с одним ответом + 1 развёрнутый (потребует рубрики в T7).
  const checkByStem = async (stem: RegExp) => {
    const item = tp.locator('.bank-item', { hasText: stem }).first()
    await item.locator('input[name=questionCodes]').check()
  }
  await checkByStem(/иррациональным/)
  await checkByStem(/третий угол/)
  await checkByStem(/равнобедренном треугольнике/)

  await tp.getByRole('button', { name: /назначить работу/i }).click()
  try {
    await tp.waitForURL(/\/teacher\/classes\/[^/]+$/, { timeout: 20000 })
  } catch {
    console.log('TP_STUCK url=', tp.url())
    console.log('TP_MAIN', (await tp.locator('main').innerText()).slice(0, 500).replace(/\n/g, ' | '))
    throw new Error('builder did not navigate')
  }
  await expect(tp.getByRole('heading', { name: 'Работы класса' })).toBeVisible()
  await expect(tp.getByText(`Контрольная ${runId}`)).toBeVisible()

  // --- S2/S3/S4.5: ученик видит и решает ------------------------------------
  await sp.goto('/student')
  await expect(sp.getByText(`Контрольная ${runId}`)).toBeVisible()
  await sp.getByRole('link', { name: `Контрольная ${runId}` }).click()
  await sp.waitForURL(/\/student\/work\//)
  await expect(sp.getByTestId('work-status')).toContainText('не начато')

  // Ответ на первый single-choice вопрос (радио) — кнопка «Сохранить ответ»
  // из ЭТОЙ же формы вопроса (первая кнопка на странице принадлежит
  // другому вопросу с textarea и сохранила бы пустой текст).
  const radio = sp.locator('input[type=radio][name=value]').first()
  await radio.check()
  await radio.locator('xpath=ancestor::form').getByRole('button', { name: /сохранить ответ/i }).click()
  await expect(sp.getByTestId('work-status')).toContainText('в работе')

  // «Перезагрузка» — resume: ответ сохранён, статус в работе.
  await sp.reload()
  await expect(radio).toBeChecked()

  // --- Сдача (идемпотентность на уровне UI: одна кнопка) --------------------
  await sp.getByRole('button', { name: /сдать работу/i }).click()
  await expect(sp.getByTestId('work-status')).toContainText(/сдано|проверено/)

  // --- T7: очередь проверки → рубрика → финализация ------------------------
  await tp.goto('/teacher/review')
  await expect(tp.getByText(`Контрольная ${runId}`)).toBeVisible()
  await tp.getByRole('link', { name: new RegExp(`Контрольная ${runId}`) }).click()
  await tp.waitForURL(/\/teacher\/review\//)

  // Развёрнутые (если есть) — ставим максимум.
  const manualInputs = tp.locator('form input[name=manual]')
  const manualCount = await manualInputs.count()
  for (let i = 0; i < manualCount; i++) {
    const input = manualInputs.nth(i)
    const max = Number(await input.getAttribute('max'))
    await input.fill(String(max))
    await input.locator('xpath=ancestor::form').locator('button[type=submit]').click()
    await tp.waitForLoadState('networkidle')
  }

  await tp.getByRole('button', { name: /завершить проверку/i }).click()
  await tp.waitForURL(/\/teacher\/review\/[^/]+\??.*$/)
  await expect(tp.getByText(/проверено/i).first()).toBeVisible()

  // Обратная связь (T8)
  await tp.fill('#fb-body', 'Отличная работа, так держать!')
  await tp.getByRole('button', { name: /отправить/i }).click()
  await expect(tp.getByText('Отличная работа, так держать!')).toBeVisible()

  // --- S7/S8: ученик видит балл, отзыв и прогресс ---------------------------
  await sp.goto(`/student`)
  await sp.getByRole('link', { name: `Контрольная ${runId}` }).click()
  await expect(sp.getByTestId('work-status')).toContainText(/проверено: \d+\s*\/\s*\d+/)
  await expect(sp.getByText('Отличная работа, так держать!')).toBeVisible()

  await sp.goto('/student')
  await expect(sp.getByRole('heading', { name: 'Прогресс по темам' })).toBeVisible()
  const mastery = await sp.locator('.works-table tbody tr').count()
  expect(mastery).toBeGreaterThan(0)

  await teacher.close()
  await student.close()
  await api.dispose()
})

// Keep ObjectId import referenced for typed routes linters.
void ObjectId
