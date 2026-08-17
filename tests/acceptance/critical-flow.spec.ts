import { test, expect, request as pwRequest, type APIRequestContext } from '@playwright/test'
import { MongoClient } from 'mongodb'
import { openEmailBody } from '../../src/email/crypto'

/**
 * ECLASS-8 — product acceptance checklist (MVP critical flow).
 *
 * The gated skips for invite/assignment (15/23), submission (28–31) and
 * review/feedback (33–35) became REAL tests when those features landed:
 * each runs the actual product path (UI where the user journey lives, API
 * helpers only as setup shortcuts). The telemetry step stays gated by
 * ECLASS-38 (CB-6: no skip without an unblocking task). The full journey in
 * one spec lives in work-flow.spec.ts; these pin the ECLASS-8 contract one
 * claim per test.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? 'mongodb://127.0.0.1:27018/eclass?replicaSet=rs0'
const DB_NAME = new URL(DATABASE_URL).pathname.replace(/^\//, '') || 'eclass'
const PASSWORD = 'longpass123'

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

/** Signed-up + confirmed + logged-in teacher; session cookie inside the context. */
async function teacherApi(baseURL: string | undefined, tag: string): Promise<APIRequestContext> {
  const ctx = await pwRequest.newContext({ baseURL: baseURL ?? 'http://localhost:3000' })
  const email = `cf-t-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e4)}@eclasstest.ru`
  expect((await ctx.post('/api/auth/signup', { data: { email, password: PASSWORD } })).status()).toBe(200)
  const token = await confirmSignupToken(email)
  expect((await ctx.post('/api/auth/confirm', { data: { token } })).status()).toBe(200)
  expect((await ctx.post('/api/auth/login', { data: { email, password: PASSWORD } })).status()).toBe(200)
  return ctx
}

/** Class + fresh (unused) invite code. */
async function classWithInvite(
  baseURL: string | undefined,
  tag: string,
): Promise<{ teacher: APIRequestContext; classId: string; code: string }> {
  const teacher = await teacherApi(baseURL, tag)
  const cls = await (
    await teacher.post('/api/classes', { data: { name: `CF класс ${tag}`, subjectVersionId: 'math-oge-2026' } })
  ).json()
  expect(cls.ok).toBe(true)
  const inv = await (await teacher.post(`/api/classes/${cls.class.id}/invites`, { data: {} })).json()
  expect(inv.ok).toBe(true)
  return { teacher, classId: String(cls.class.id), code: String(inv.code) }
}

/** ClassWithInvite + a student who already joined via the API (invite consumed). */
async function classWithRoster(
  baseURL: string | undefined,
  tag: string,
): Promise<{ teacher: APIRequestContext; student: APIRequestContext; classId: string }> {
  const { teacher, classId, code } = await classWithInvite(baseURL, tag)
  const studentLogin = `cf-s-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e4)}@eclasstest.ru`
  const student = await pwRequest.newContext({ baseURL: baseURL ?? 'http://localhost:3000' })
  const join = await student.post('/api/join', {
    data: { code, login: studentLogin, displayName: `Ученик ${tag}`, password: PASSWORD },
  })
  expect(join.status()).toBe(200)
  return { teacher, student, classId }
}

/** Assign two questions of `type` to the whole class; returns the assignment id. */
async function assignWork(
  teacher: APIRequestContext,
  classId: string,
  title: string,
  type: 'single-choice' | 'short-text',
): Promise<string> {
  const bank = await (await teacher.get('/api/content', { params: { subjectVersionId: 'math-oge-2026', type } })).json()
  expect(bank.ok).toBe(true)
  const codes: string[] = bank.items.slice(0, 2).map((q: { code: string }) => q.code)
  expect(codes.length).toBe(2)
  const res = await (
    await teacher.post('/api/assignments', { data: { classId, title, questionCodes: codes, recipients: 'all' } })
  ).json()
  expect(res.ok).toBe(true)
  return String(res.assignmentId)
}

/** The student's attempt id for a work title. */
async function studentAttemptId(student: APIRequestContext, title: string): Promise<string> {
  const list = await (await student.get('/api/student/assignments')).json()
  const hit = list.items.find((i: { title: string }) => i.title === title)
  expect(hit).toBeDefined()
  return String(hit.id)
}

test.describe('MVP critical acceptance flow — ECLASS-8', () => {
  test('product checklist page exists and lists the 5 user needs', async ({ page }) => {
    await page.goto('/about/mvp')
    await expect(page.getByRole('heading', { name: /MVP scope/i })).toBeVisible()
    for (const fragment of [
      /актуального экзамена фипи/i,
      /пригласить ученика одной ссылкой/i,
      /выдать конкретную работу/i,
      /сдать работу с телефона без потери/i,
      /объясняющую обратную связь/i,
    ]) {
      await expect(page.locator('body')).toContainText(fragment)
    }
  })

  test('KPI targets are documented on the MVP page and match the metrics contract', async ({
    page,
  }) => {
    await page.goto('/about/mvp')
    await expect(page.locator('body')).toContainText('≥60%')
    await expect(page.locator('body')).toContainText('≥70%')
    await expect(page.locator('body')).toContainText('≤24')
    await expect(page.locator('body')).toContainText('≥35%')
  })

  // ECLASS-15 + ECLASS-23 landed: invite + assign within one teacher session.
  // Product target ≤ 3 min — asserted as the wall clock of the whole journey.
  test('teacher can invite a student and assign work within one session (target ≤ 3 min)', async ({
    browser,
    baseURL,
  }) => {
    const startedAt = Date.now()
    const { teacher, classId, code } = await classWithInvite(baseURL, 'invite')

    // The student joins through the public invite link on a phone viewport.
    const sp = await (await browser.newContext({ viewport: { width: 320, height: 690 } })).newPage()
    await sp.goto(`/join?code=${code}`)
    await sp.fill('#displayName', 'Приглашённый Ученик')
    await sp.fill('#login', `cf-join-${Date.now()}@eclasstest.ru`)
    await sp.fill('#password', PASSWORD)
    await sp.click('button[type=submit]')
    await sp.waitForURL('**/student')

    // Same teacher session assigns (builder UI path is covered in work-flow.spec.ts).
    const title = `CF работа ${Date.now()}`
    await assignWork(teacher, classId, title, 'single-choice')

    await sp.goto('/student')
    await expect(sp.getByRole('link', { name: title })).toBeVisible()
    expect(Date.now() - startedAt).toBeLessThan(180_000)
  })

  // ECLASS-28..31 landed: autosave/resume + idempotent submit.
  test('student submission survives reload and submits idempotently', async ({ browser, baseURL }) => {
    const { teacher, student, classId } = await classWithRoster(baseURL, 'submit')
    const title = `CF сдача ${Date.now()}`
    await assignWork(teacher, classId, title, 'short-text')
    const attemptId = await studentAttemptId(student, title)

    // UI runner: answer, save, reload — the answer must survive (S4.5).
    const ctx = await browser.newContext({ storageState: await student.storageState() })
    const sp = await ctx.newPage()
    await sp.goto(`/student/work/${attemptId}`)
    const answer = sp.locator('textarea[name=value]').first()
    await answer.fill('42')
    await answer.locator('xpath=ancestor::form').getByRole('button', { name: /сохранить ответ/i }).click()
    await expect(sp.getByTestId('work-status')).toContainText('в работе')
    await sp.reload()
    await expect(sp.locator('textarea[name=value]').first()).toHaveValue('42')

    await sp.getByRole('button', { name: /сдать работу/i }).click()
    await expect(sp.getByTestId('work-status')).toContainText(/сдано|проверено/)

    // Replay with a DIFFERENT key at the contract level → single-submission guard.
    const replay = await student.post(`/api/attempts/${attemptId}?action=submit`, {
      data: { idempotencyKey: `cf-replay-${Date.now()}` },
    })
    expect(replay.status()).toBe(409)
    await ctx.close()
  })

  // ECLASS-33..35 landed: review, finalize, feedback the student receives.
  test('teacher can review and send feedback that the student receives', async ({ browser, baseURL }) => {
    const { teacher, student, classId } = await classWithRoster(baseURL, 'review')
    const title = `CF проверка ${Date.now()}`
    await assignWork(teacher, classId, title, 'single-choice')
    const attemptId = await studentAttemptId(student, title)

    // Student answers and submits via the API (runner UI is covered above).
    const view = await (await student.get(`/api/attempts/${attemptId}`)).json()
    expect(view.ok).toBe(true)
    for (const q of view.questions) {
      const res = await student.post(`/api/attempts/${attemptId}?action=answer`, {
        data: { code: q.code, value: { v: 'a' }, clientVersion: 1 },
      })
      expect(res.status()).toBe(200)
    }
    expect(
      (await student.post(`/api/attempts/${attemptId}?action=submit`, { data: { idempotencyKey: `cf-sub-${Date.now()}` } }))
        .status(),
    ).toBe(200)

    // Teacher reviews in the UI: finalize, then leave feedback.
    const tctx = await browser.newContext({ storageState: await teacher.storageState() })
    const tp = await tctx.newPage()
    await tp.goto('/teacher/review')
    await tp.getByRole('link', { name: title }).click()
    await tp.waitForURL(/\/teacher\/review\//)
    await tp.getByRole('button', { name: /завершить проверку/i }).click()
    await tp.fill('#fb-body', 'Разбор ошибок на следующем уроке')
    await tp.getByRole('button', { name: /отправить/i }).click()
    await expect(tp.getByText('Разбор ошибок на следующем уроке')).toBeVisible()

    const sctx = await browser.newContext({ storageState: await student.storageState() })
    const sp = await sctx.newPage()
    await sp.goto(`/student/work/${attemptId}`)
    await expect(sp.getByTestId('work-status')).toContainText(/проверено: \d+\s*\/\s*\d+/)
    await expect(sp.getByText('Разбор ошибок на следующем уроке')).toBeVisible()
    await tctx.close()
    await sctx.close()
  })

  // GATED BY: ECLASS-38 (privacy-safe telemetry pipeline).
  test('funnel events activation/completion/feedback are emitted with the contract shape', async () => {
    test.skip(true, 'GATED BY ECLASS-38 (telemetry)')
  })
})
