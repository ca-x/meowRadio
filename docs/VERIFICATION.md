# Verification record

2026-09-15, initial implementation.

- Rust 1.94.0: `cargo fmt --check`, `cargo clippy --locked --all-targets -- -D warnings`, `cargo test --locked` (7 integration/security tests), `cargo build --release --locked` passed. The upstream vendored crate emits two existing dead-code warnings; application Clippy passes.
- Frontend: strict TypeScript + Vite production build, Vitest (6 playback lifecycle tests), npm audit (0 advisories) passed.
- Cargo audit against the locally fetched 1,246-advisory database passes with only the documented non-built RSA optional dependency excluded (`.cargo/audit.toml`). Live advisory refetch briefly failed; the same-session database was used for the final local check. CI performs a fresh fetch.
- actionlint passed for CI and Release workflows.
- Release executable served the embedded frontend and bundled font license, answered SQLite health/setup requests and fetched 24 real Radio Browser jazz results. `ldd` shows no external SQLite/OpenSSL dependency.
- Chromium/agent-browser: first-run wizard, real catalog, saving a station, actual playback of 101 SMOOTH JAZZ (`readyState=4`, `paused=false`), pause, three theme switches without replacing the audio element, LED 2D/3D controls, theme persistence, desktop 1440px and mobile 375px verified. Mobile `scrollWidth == innerWidth` for all three themes.
- axe-core 4.12.1 found 0 confirmed violations on checked walnut/LED views. Gradient/texture contrast checks were marked incomplete by the scanner, so this is not a claim of full WCAG certification. Labels, focus states, reduced-motion CSS and texture text colors were inspected.
- Local Docker CLI is not installed. CI includes a real Docker build, non-root startup and HTTP smoke test. Cross-platform archive and GHCR checks are performed by the tag-triggered Release workflow.

Coverage includes one-time environment initialization, concurrent wizard initialization, auth/CSRF/rate limiting, session expiration/logout, username collision, per-user favorites and restart persistence, proxy request routing and credential redaction, blocked private relay destinations, theme/audio stability and stale HLS/play promises.
