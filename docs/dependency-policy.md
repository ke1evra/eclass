# Dependency compatibility and server CI

Payload packages are pinned together to 3.91.0: the runtime rejects mixed versions, including when separate processes boot. Update the four direct packages as one set and commit the lockfile.

Next remains on the patched 15.5 line (15.5.29). Nodemailer 10.3.1 and Zod 4.6.7 replace vulnerable major versions; existing SMTP, API-contract and application tests verify compatibility. The generated Payload types include the added password-reset timestamp.

Scoped overrides apply undici 7.30.1 to Payload and happy-dom 21.0.4 to Lexical headless. These replace vulnerable pinned transitive dependencies without downgrading the CMS. sharp is at least 0.35.5. Review the overrides when upstream updates its dependency pins.

The production gate remains `npm audit --omit=dev --audit-level=high`. The validated dependency tree has no high or critical production findings. Low-severity and development-tool findings are separate remaining maintenance work; the full development audit is not claimed clean.

The repository's `.npmrc` remains part of the reproducible installation (`legacy-peer-deps=true`). Server CI copies it before `npm ci`; it does not use a developer's npm configuration. Browser-test setup waits for Mongo collection/index initialization before transactional seeding into the disposable database.
