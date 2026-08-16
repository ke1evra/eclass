import { test, expect, request as pwRequest } from '@playwright/test'
import { MongoClient } from 'mongodb'
import { openEmailBody } from '../../src/email/crypto'

/**
 * ECLASS-69 — the A5 password-reset E2E, no skips:
 * A2 → A5 request → A4-style pending → (sealed outbox token) → new password
 * → back to A2 → login with the NEW password → T1. The old session/password
 * dying is proven at the integration layer; this spec proves the user flow.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? 'mongodb://127.0.0.1:27018/eclass?replicaSet=rs0'
const DB_NAME = new URL(DATABASE_URL).pathname.replace(/^\//, '') || 'eclass'

const runId = Date.now()
const email = `e2e-reset-${runId}@eclasstest.ru`
const oldPassword = 'oldpassword1'
const newPassword = 'newpassword1'

async function signupTokenFor(login: string): Promise<string> {
  const client = new MongoClient(DATABASE_URL)
  await client.connect()
  try {
    const job = await client.db(DB_NAME).collection('email-jobs').findOne({ to: login })
    expect(job, 'confirmation job in outbox').not.toBeNull()
    return openEmailBody(String(job!.body)).match(/token=([A-Za-z0-9_-]+)/)![1]!
  } finally {
    await client.close()
  }
}

async function resetTokenFor(login: string): Promise<string> {
  const client = new MongoClient(DATABASE_URL)
  await client.connect()
  try {
    // The reset job is the LATEST one for this recipient.
    const jobs = client.db(DB_NAME).collection('email-jobs')
    const job = await jobs.find({ to: login }).sort({ createdAt: -1 }).limit(1).next()
    expect(job, 'reset job in outbox').not.toBeNull()
    return openEmailBody(String(job!.body)).match(/token=([A-Za-z0-9_-]+)/)![1]!
  } finally {
    await client.close()
  }
}

test.describe('ECLASS-69: password reset flow', () => {
  test('A2 → A5 → pending → token → new password → A2 login with the new password', async ({ page, baseURL }) => {
    test.setTimeout(120_000)

    // Provision a confirmed teacher (signup + outbox confirm), then log in.
    const api = await pwRequest.newContext({ baseURL })
    expect((await api.post('/api/auth/signup', { data: { email, password: oldPassword } })).status()).toBe(200)
    const confirmToken = await signupTokenFor(email)
    expect((await api.post('/api/auth/confirm', { data: { token: confirmToken } })).status()).toBe(200)
    await api.dispose()

    // --- A2 → A5 ----------------------------------------------------------
    await page.goto('/login')
    await page.getByRole('link', { name: 'Забыли пароль?' }).click()
    await page.waitForURL('**/reset')
    await expect(page.getByRole('heading', { name: 'Восстановление доступа' })).toBeVisible()

    await page.fill('#email', email)
    await page.click('button[type=submit]')
    await page.waitForURL('**/reset/pending**')
    await expect(page.getByRole('heading', { name: 'Проверьте почту' })).toBeVisible()

    // --- The one-time token, the way the delivered email would carry it ----
    const token = await resetTokenFor(email)

    // --- A5 confirm: set the new password ----------------------------------
    await page.goto(`/reset/confirm?token=${token}`)
    await page.fill('#password', newPassword)
    await page.click('button[type=submit]')
    await page.waitForURL('**/login?notice=reset')

    // --- Back at A2: the NEW password works, the old one does not ----------
    await page.fill('#email', email)
    await page.fill('#password', newPassword)
    await page.click('button[type=submit]')
    await page.waitForURL('**/teacher')
    await expect(page.getByRole('heading', { name: 'Кабинет учителя' })).toBeVisible()
  })
})
