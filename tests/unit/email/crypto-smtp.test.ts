import { afterEach, describe, expect, it } from 'vitest'
import { createSmtpTransport } from '@/email/smtp'
import {
  getEmailTransport,
  isEmailConfigured,
  loggingTransport,
  resetTransportEnvInit,
  setEmailTransport,
} from '@/email/transport'
import { isSealed, openEmailBody, sealEmailBody } from '@/email/crypto'

/**
 * ECLASS-68 (defect 6) — SMTP adapter + env wiring, unit level.
 * No network: nodemailer connects lazily, so building the transport proves
 * DSN parsing and wiring; delivery is exercised at the integration/E2E layer.
 */
describe('ECLASS-68: SMTP adapter and env wiring', () => {
  afterEach(() => {
    delete process.env.SMTP_DSN
    setEmailTransport(loggingTransport)
    resetTransportEnvInit()
  })

  it('parses smtp:// DSN into a pooled transport', () => {
    const t = createSmtpTransport('smtp://user:p%40ss@smtp.example.com:2525')
    expect(typeof t.send).toBe('function')
  })

  it('parses smtps:// DSN (implicit port 465, secure)', () => {
    expect(() => createSmtpTransport('smtps://key:secret@mail.provider.com')).not.toThrow()
  })

  it('rejects a non-smtp DSN loudly', () => {
    expect(() => createSmtpTransport('http://localhost:3000')).toThrow(/unsupported SMTP_DSN/)
  })

  it('the first transport access wires SMTP from SMTP_DSN (lazy init)', () => {
    process.env.SMTP_DSN = 'smtp://u:p@localhost:2525'
    resetTransportEnvInit()
    const transport = getEmailTransport()
    expect(transport).not.toBe(loggingTransport)
    expect(isEmailConfigured()).toBe(true)

    // …and without a DSN the logging transport stays in place.
    delete process.env.SMTP_DSN
    setEmailTransport(loggingTransport)
    resetTransportEnvInit()
    expect(getEmailTransport()).toBe(loggingTransport)
  })

  it('a malformed DSN is LOUD at init, not a silent logging fallback', () => {
    process.env.SMTP_DSN = 'not-a-url'
    resetTransportEnvInit()
    expect(() => getEmailTransport()).toThrow(/SMTP_DSN/)
    // Restore for afterEach hygiene.
    setEmailTransport(loggingTransport)
  })
})

describe('ECLASS-68: sealed body helpers', () => {
  it('isSealed recognises the v1 format only', () => {
    expect(isSealed(sealEmailBody('x'))).toBe(true)
    expect(isSealed('plain text')).toBe(false)
    expect(isSealed(null)).toBe(false)
    expect(isSealed(undefined)).toBe(false)
  })
})
