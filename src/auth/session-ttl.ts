/**
 * The ONE session lifetime for every issuing site — ECLASS-13 review fix.
 *
 * The API login handler minted 1-hour sessions while the UI actions and the
 * join flow minted 30-day ones: the same cookie had two policies depending on
 * which door it came from. Teachers and students work over weeks (PWA usage),
 * so the product lifetime is 30 days; revocation (logout, password reset) is
 * the kill switch, not expiry.
 */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
