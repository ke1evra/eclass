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

  // ECLASS-57: convert any legacy plaintext invite rows to their sha256 form.
  // Best-effort: a DB-less environment (e.g. some build workers) or a failed
  // migration logs loudly but does not kill the boot — see invite-migration.ts
  // for the failure-safety argument.
  if (process.env.DATABASE_URL) {
    try {
      const { getPayload } = await import('payload')
      const { default: config } = await import('./payload.config')
      const { migrateInvitesToHashes } = await import('./classes/invite-migration')
      const payload = await getPayload({ config })
      const migrated = await migrateInvitesToHashes(payload)
      if (migrated > 0) console.log(`[instrumentation] invite-code migration: ${migrated} row(s) hashed`)
    } catch (err) {
      console.error('[instrumentation] invite-code migration FAILED (legacy invites will not join; mint fresh codes):', err)
    }
  }
}
