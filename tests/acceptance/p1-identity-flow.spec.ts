import { test, expect, request as pwRequest } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { MongoClient } from 'mongodb'

/**
 * ECLASS-56 (Stage D) — the canonical P1 identity flow, NO SKIPS:
 *
 *   A1 role selection → A3 teacher signup → A4 email pending → (outbox
 *   confirm) → A2 login → T1 empty dashboard → T2 create class → T3 invite →
 *   A7 student join (mobile 390px) → S1 class joined → S2/A8 student
 *   workspace → roster shows the student (T3/T6) → E5 replay rejected.
 *
 * The confirmation token comes from the REAL Mongo outbox (email-jobs), the
 * same way a delivered email link would — no transport mocks at the boundary.
 * Requires DATABASE_URL (CI and local replset both provide it).
 */
const DATABASE_URL = process.env.DATABASE_URL ?? 'mongodb://127.0.0.1:27018/eclass?replicaSet=rs0'
const DB_NAME = new URL(DATABASE_URL).pathname.replace(/^\//, '') || 'eclass'

const runId = Date.now()
const teacherEmail = `e2e-teacher-${runId}@eclasstest.ru`
const teacherPassword = 'longpass123'
const studentLogin = `e2e-student-${runId}@eclasstest.ru`
const studentPassword = 'longpass123'

async function confirmationToken(login: string): Promise<string> {
  const client = new MongoClient(DATABASE_URL)
  await client.connect()
  try {
    const jobs = client.db(DB_NAME).collection('email-jobs')
    const job = await jobs.findOne({ to: login })
    expect(job, `outbox must hold a confirmation job for ${login}`).not.toBeNull()
    const token = String(job!.body).match(/token=([A-Za-z0-9_-]+)/)?.[1]
    expect(token, 'job body must contain the bearer token').toBeTruthy()
    return token as string
  } finally {
    await client.close()
  }
}

test.describe('P1 identity flow — ECLASS-2/13/14/15/16/56', () => {
  test('keyboard-only: the critical login flow is operable without a pointer (ECLASS-13/60 R12)', async ({ browser, baseURL }) => {
    test.setTimeout(120_000)

    // Provision a confirmed teacher through the API + outbox (same as email).
    const email = `e2e-kbd-${runId}@eclasstest.ru`
    const api = await pwRequest.newContext({ baseURL })
    expect((await api.post('/api/auth/signup', { data: { email, password: teacherPassword } })).status()).toBe(200)
    const token = await confirmationToken(email)
    expect((await api.post('/api/auth/confirm', { data: { token } })).status()).toBe(200)
    await api.dispose()

    // From here: KEYBOARD ONLY. Tab reaches every control in a sane order;
    // Enter submits. No page.mouse, no click().
    const page = await (await browser.newContext()).newPage()
    await page.goto('/login')

    await page.keyboard.press('Tab') // #email
    await expect(page.locator('#email')).toBeFocused()
    await page.keyboard.type(email)
    await page.keyboard.press('Tab') // #password
    await expect(page.locator('#password')).toBeFocused()
    await page.keyboard.type(teacherPassword)
    await page.keyboard.press('Tab') // submit
    await page.keyboard.press('Enter')

    await page.waitForURL('**/teacher')
    await expect(page.getByRole('heading', { name: 'Кабинет учителя' })).toBeVisible()
  })

  test('A1 → A3 → A4 → confirm → A2 → T1 → T2 → T3 → A7 → S1/S2/A8 → roster; E5 replay rejected', async ({ browser, baseURL }) => {
    test.setTimeout(180_000)

    // --- A1 role selection -------------------------------------------------
    const teacherCtx = await browser.newContext()
    const page = await teacherCtx.newPage()
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Экзамен Класс' })).toBeVisible()
    await expect(page.getByRole('link', { name: /Я учитель — войти/i })).toBeVisible()
    await expect(page.getByRole('link', { name: /Я ученик — войти по коду/i })).toBeVisible()

    // --- A3 teacher signup --------------------------------------------------
    await page.getByRole('link', { name: /Зарегистрироваться/i }).first().click()
    await page.waitForURL('**/signup')
    await page.fill('#email', teacherEmail)
    await page.fill('#password', teacherPassword)
    await page.click('button[type=submit]')
    await page.waitForURL('**/signup/pending**')

    // --- A4 email pending ---------------------------------------------------
    await expect(page.getByRole('heading', { name: /подтвердите email/i })).toBeVisible()

    // Confirm through the real outbox + confirm API (same as the email link).
    const token = await confirmationToken(teacherEmail)
    const api = await pwRequest.newContext({ baseURL })
    const confirmed = await api.post('/api/auth/confirm', { data: { token } })
    expect(confirmed.status(), `confirm body: ${await confirmed.text()}`).toBe(200)
    await api.dispose()

    // --- A2 login → T1 empty dashboard (with A6 onboarding) ----------------
    await page.goto('/login')
    await page.fill('#email', teacherEmail)
    await page.fill('#password', teacherPassword)
    await page.click('button[type=submit]')
    await page.waitForURL('**/teacher')
    await expect(page.getByRole('heading', { name: 'Кабинет учителя' })).toBeVisible()
    await expect(page.getByRole('heading', { name: /настройте первый класс/i })).toBeVisible()

    const a11yT1 = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()
    expect(
      a11yT1.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious'),
      JSON.stringify(a11yT1.violations, null, 2),
    ).toEqual([])

    // --- T2 create class ----------------------------------------------------
    await page.goto('/teacher/classes/new')
    await page.fill('#name', `E2E класс ${runId}`)
    await page.selectOption('#subjectVersionId', 'math-oge-2026')
    await page.click('button[type=submit]')
    await page.waitForURL(/\/teacher\/classes\/[^/]+$/)

    // --- T3 invite ----------------------------------------------------------
    await expect(page.getByRole('heading', { name: `E2E класс ${runId}` })).toBeVisible()
    await expect(page.getByTestId('empty-roster')).toBeVisible()
    await page.getByRole('button', { name: /создать код приглашения/i }).click()
    await page.waitForURL(/invite=/)
    const inviteText = await page.getByTestId('invite-code').innerText()
    const inviteCode = inviteText.match(/([A-Z2-9]{8})/)?.[1]
    expect(inviteCode, 'invite code rendered for the teacher').toBeTruthy()
    const classUrl = page.url()

    // --- A7 student join on a 390px mobile viewport -------------------------
    const studentCtx = await browser.newContext({ viewport: { width: 390, height: 844 } })
    const student = await studentCtx.newPage()
    await student.goto(`/join?code=${inviteCode}`)
    await expect(student.getByRole('heading', { name: /вход в класс по коду/i })).toBeVisible()
    await student.fill('#code', inviteCode!)
    await student.fill('#displayName', 'Аня Е2Е')
    await student.fill('#login', studentLogin)
    await student.fill('#password', studentPassword)
    await student.click('button[type=submit]')

    // --- S1 class joined / S2 empty works / A8 profile ----------------------
    await student.waitForURL('**/student')
    await expect(student.getByRole('heading', { name: 'Кабинет ученика' })).toBeVisible()
    await expect(student.getByText(/Математика/i).first()).toBeVisible()
    await expect(student.getByText(`E2E класс ${runId}`).first()).toBeVisible()
    await expect(student.getByTestId('empty-state')).toBeVisible()

    const a11yS1 = await new AxeBuilder({ page: student }).withTags(['wcag2a', 'wcag2aa']).analyze()
    expect(
      a11yS1.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious'),
      JSON.stringify(a11yS1.violations, null, 2),
    ).toEqual([])

    // A8: the student may change ONLY the display name.
    await student.fill('#displayName', 'Аня Е2Е (9А)')
    await student.getByRole('button', { name: /сохранить имя/i }).click()
    await expect(student.locator('#displayName')).toHaveValue('Аня Е2Е (9А)')

    // Student logout → back to A1.
    await student.getByRole('button', { name: /выйти/i }).click()
    await student.waitForURL(/\/$/)

    // --- T3/T6: the roster now shows the student by display name ------------
    await page.goto(classUrl)
    await expect(page.getByRole('heading', { name: 'Состав класса' })).toBeVisible()
    await expect(page.getByText('Аня Е2Е (9А)')).toBeVisible()

    // --- E5: the single-use code cannot admit a second student --------------
    const replayCtx = await browser.newContext({ viewport: { width: 390, height: 844 } })
    const replay = await replayCtx.newPage()
    await replay.goto(`/join?code=${inviteCode}`)
    await replay.fill('#displayName', 'Второй Ученик')
    await replay.fill('#login', `e2e-replay-${runId}@eclasstest.ru`)
    await replay.fill('#password', studentPassword)
    await replay.click('button[type=submit]')
    await replay.waitForURL(/error=invite_used/)
    await expect(replay.getByText(/код уже использован/i)).toBeVisible()
    await replayCtx.close()

    // Teacher logout → A1. Anonymous /teacher afterwards redirects to A2 with
    // the auth notice (session-expired/anonymous recovery at the UI level).
    await page.getByRole('button', { name: /выйти/i }).click()
    await page.waitForURL(/\/$/)
    await page.goto('/teacher')
    await page.waitForURL('**/login?notice=auth')
    await expect(page.getByText('Нужен вход учителя.')).toBeVisible()
    await teacherCtx.close()
    await studentCtx.close()
  })
})
