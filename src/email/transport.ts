/**
 * Email transport — ECLASS-67, hardened in ECLASS-68 (defect 6).
 *
 * Route handlers (Next.js convention: zero-arg `POST(req)`) cannot receive an
 * injected transport, so this module exposes a process-level accessor
 * `getEmailTransport()` with a `setEmailTransport()` override for tests. This
 * is the first mutable singleton on the auth path; the alternative (a Payload
 * plugin) is overkill for a single send site.
 *
 * Production default `loggingTransport` records ONLY metadata (to, subject) —
 * the body is suppressed because it carries the bearer confirmation token.
 * When SMTP_DSN is set, the FIRST access initializes the real SMTP adapter
 * (nodemailer, lazy connections). The adapter initializes here rather than in
 * instrumentation.ts because instrumentation is part of a module graph the
 * dev overlay compiles for the browser fallback, where node built-ins do not
 * resolve (observed: "Module not found: Can't resolve 'stream'" through
 * instrumentation → smtp → nodemailer).
 *
 * Tests use `InMemoryOutbox` (defined in the test files) and swap it in via
 * `setEmailTransport(outbox)` in `beforeEach`, reading the raw token
 * programmatically — it NEVER appears in a response body or CI log.
 */
import { createSmtpTransport } from './smtp'

export interface EmailMessage {
  to: string
  subject: string
  /** Free-form body. May contain a bearer token — transports MUST NOT log it. */
  body: string
}

export interface EmailTransport {
  send(msg: EmailMessage): Promise<void>
}

/**
 * Production placeholder. Logs metadata only; the body is intentionally NOT
 * printed — it contains the confirmation link with the raw bearer token.
 */
export const loggingTransport: EmailTransport = {
  async send({ to, subject }) {
    // Deliberately omit `body` — it carries the raw bearer token.
    console.log(`[email] to=${to} subject="${subject}" (body suppressed: contains bearer token)`)
  },
}

let current: EmailTransport = loggingTransport
/** False until the SMTP_DSN (if any) has been applied exactly once. */
let envInitialized = false

/** Test seam: forget the env initialization so a new SMTP_DSN applies. */
export const resetTransportEnvInit = (): void => {
  envInitialized = false
}

const initFromEnv = (): void => {
  if (envInitialized) return
  envInitialized = true
  const dsn = process.env.SMTP_DSN
  if (!dsn) return
  // A malformed DSN must be LOUD: falling back to the logging transport
  // silently would mean "emails sent" that were only console lines.
  current = createSmtpTransport(dsn)
}

/** Returns the active transport (SMTP when SMTP_DSN is set, else logging). */
export function getEmailTransport(): EmailTransport {
  initFromEnv()
  return current
}

/**
 * Overrides the active transport. Tests pass an `InMemoryOutbox` to capture
 * the confirmation token programmatically. Call `setEmailTransport(loggingTransport)`
 * in `afterAll` to restore hygiene between suites.
 */
export function setEmailTransport(transport: EmailTransport): void {
  envInitialized = true // an explicit override wins over any env wiring
  current = transport
}

/**
 * Whether a real email delivery path is wired. The signup route refuses with
 * 503 `email_not_configured` when this is false, so production cannot silently
 * create users who can never receive a confirmation link. True when:
 *   - NODE_ENV === 'test' (tests swap in an InMemoryOutbox via setEmailTransport)
 *   - a non-default transport has been set (setEmailTransport / SMTP_DSN)
 *   - SMTP_DSN is present (production SMTP, checked lazily so deploy-time env wins)
 */
export function isEmailConfigured(): boolean {
  initFromEnv()
  return (
    process.env.NODE_ENV === 'test' ||
    current !== loggingTransport ||
    Boolean(process.env.SMTP_DSN)
  )
}
