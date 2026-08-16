/**
 * App boot instrumentation — ECLASS-68 / ECLASS-57.
 *
 * Deliberately imports NOTHING from the server-only dependency world (payload,
 * nodemailer): Next compiles instrumentation into a module graph that the dev
 * overlay also builds for the browser fallback, where node built-ins do not
 * resolve (observed twice: 'stream' through nodemailer, then through payload
 * itself). Server work therefore initializes lazily where a server-only
 * module already lives: the SMTP adapter in src/email/transport.ts, and the
 * legacy invite-code migration via ensureInvitesHashed() from the class
 * services / join paths.
 *
 * What boot DOES enforce is the production secret policy: email bodies are
 * sealed with a key derived from PAYLOAD_SECRET (unless
 * EMAIL_BODY_ENCRYPTION_KEY is set), so a production process without a real
 * secret must refuse to start rather than silently seal everything under the
 * public dev fallback key.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return

  if (process.env.NODE_ENV === 'production') {
    if (
      !process.env.PAYLOAD_SECRET ||
      process.env.PAYLOAD_SECRET === 'insecure-p0-dev-secret-change-me'
    ) {
      throw new Error(
        'PAYLOAD_SECRET must be set in production (email bodies derive their key from it when EMAIL_BODY_ENCRYPTION_KEY is absent)',
      )
    }
  }
}
