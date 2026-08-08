/**
 * Email transport — ECLASS-67.
 *
 * Route handlers (Next.js convention: zero-arg `POST(req)`) cannot receive an
 * injected transport, so this module exposes a process-level accessor
 * `getEmailTransport()` with a `setEmailTransport()` override for tests. This
 * is the first mutable singleton on the auth path; the alternative (a Payload
 * plugin) is overkill for a single send site.
 *
 * Production default `loggingTransport` records ONLY metadata (to, subject) —
 * the body is suppressed because it carries the bearer confirmation token.
 * The real SMTP/transactional transport is a separate infra task and will
 * `setEmailTransport` at app boot.
 *
 * Tests use `InMemoryOutbox` (defined in the test files) and swap it in via
 * `setEmailTransport(outbox)` in `beforeEach`, reading the raw token
 * programmatically — it NEVER appears in a response body or CI log.
 */
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
    // Deliberately omit `body` — it carries the raw confirmation token.
    console.log(`[email] to=${to} subject="${subject}" (body suppressed: contains bearer token)`)
  },
}

let current: EmailTransport = loggingTransport

/** Returns the active transport (production: loggingTransport unless swapped). */
export function getEmailTransport(): EmailTransport {
  return current
}

/**
 * Overrides the active transport. Tests pass an `InMemoryOutbox` to capture
 * the confirmation token programmatically. Call `setEmailTransport(loggingTransport)`
 * in `afterAll` to restore hygiene between suites.
 */
export function setEmailTransport(transport: EmailTransport): void {
  current = transport
}
