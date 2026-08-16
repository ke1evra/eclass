/**
 * SMTP transport adapter — ECLASS-68 (defect 6).
 *
 * Parses SMTP_DSN (smtp://user:pass@host:port or smtps://…) into a nodemailer
 * transport implementing EmailTransport. Connection is lazy: nodemailer opens
 * the socket on first send, so boot-time wiring never blocks on SMTP
 * availability. Wired at app boot in src/instrumentation.ts when SMTP_DSN is
 * present; without it the app keeps the logging transport and signup refuses
 * with email_not_configured (fail-closed product behaviour, unchanged).
 */
import nodemailer from 'nodemailer'
import type { Transporter } from 'nodemailer'
import type { EmailTransport } from './transport'

export const createSmtpTransport = (dsn: string): EmailTransport => {
  let url: URL
  try {
    url = new URL(dsn)
  } catch {
    throw new Error(`SMTP_DSN is not a valid URL: ${dsn.slice(0, 32)}`)
  }
  if (url.protocol !== 'smtp:' && url.protocol !== 'smtps:') {
    throw new Error(`unsupported SMTP_DSN protocol: ${url.protocol}`)
  }
  const port = Number(url.port || (url.protocol === 'smtps:' ? 465 : 587))
  const transporter: Transporter = nodemailer.createTransport({
    host: url.hostname,
    port,
    secure: url.protocol === 'smtps:' || port === 465,
    auth: url.username
      ? { user: decodeURIComponent(url.username), pass: decodeURIComponent(url.password) }
      : undefined,
    // Delivery failures are the worker's retry signal; pool keeps the
    // connection warm between cron ticks.
    pool: true,
    maxConnections: 3,
  })

  return {
    async send(msg) {
      await transporter.sendMail({
        from: process.env.EMAIL_FROM ?? 'no-reply@eclass.local',
        to: msg.to,
        subject: msg.subject,
        text: msg.body,
    })
    },
  }
}
