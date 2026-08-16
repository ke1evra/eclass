/**
 * App boot instrumentation — ECLASS-68.
 *
 * The SMTP adapter itself initializes lazily inside src/email/transport.ts on
 * first use (see the note there: importing nodemailer from instrumentation
 * drags it into a browser-compiled module graph). What boot DOES enforce is
 * the production secret policy: email bodies are sealed with a key derived
 * from PAYLOAD_SECRET (unless EMAIL_BODY_ENCRYPTION_KEY is set), so a
 * production process without a real secret must refuse to start rather than
 * silently seal everything under the public dev fallback key.
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
