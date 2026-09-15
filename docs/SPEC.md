# meowRadio

Self-hosted multi-user internet radio. User request authorizes implementation and creation of ca-x/meowRadio.

## Capability map and build order
| Module | Responsibility | Depends on |
|---|---|---|
| identity | SQLite users, password hashing, cookie sessions | storage |
| catalog | Radio Browser search and station resolution | — |
| favorites | Private saved stations | identity, catalog |
| playback | Browser audio, optional server relay and outbound proxy | catalog |
| receiver | React skeuomorphic receiver, discovery, account/settings dialogs | all APIs |
| delivery | Embedded UI, Docker, release archives, GitHub Actions | all |

## Decisions
Rust/Axum + SQLx SQLite (WAL, foreign keys, migrations); radiobrowser crate for discovery/API models/client. React/TypeScript/Vite, Radix UI primitives and TanStack Query. No external runtime frontend server. Public browsing, opt-in local accounts. Session cookies are HttpOnly/SameSite Strict with hashed random tokens stored in SQLite. Registration can be disabled. Proxy credentials are deployment configuration, never browser-visible. Direct audio is default; authenticated relay is optional and validates/pins public destination IPs on every redirect. HLS plays directly using hls.js; relay supports continuous audio only.

Visual direction: walnut cabinet, brushed aluminum fascia, amber LCD, physical power button and volume dial; responsive down to 375px, keyboard controls, reduced motion, Chinese UI. Scale marks are station positions, not fictional FM frequencies.

## Acceptance
- Search by name/tag/country, paginate and handle upstream errors with retry.
- Play/pause/volume and station switching; meaningful loading/error states; no autoplay on load.
- Register/login/logout; duplicate usernames rejected; credentials hashed; sessions expire and logout revokes them.
- Favorites survive restart and are isolated by authenticated user, including delete.
- Deployment supports HTTP/HTTPS outbound proxy; browser settings select direct or relay playback and show non-secret proxy status.
- Release binary includes UI and SQLite; Linux amd64/arm64, macOS amd64/arm64, Windows amd64 archives plus checksums.
- Docker multi-architecture GHCR publishing on version tags, CI gates before release.

## Layout and commands
`src/` backend, `tests/` API integration tests, `web/src/` frontend, `.github/workflows/` delivery.
Build: `npm --prefix web ci --ignore-scripts && npm --prefix web run build && cargo build --locked --release`.
Verify: `cargo fmt --check`, `cargo clippy --locked --all-targets -- -D warnings`, `cargo test --locked`, `npm --prefix web run build`.
Style: rustfmt, small modules, bound SQL parameters; strict TypeScript, function components.
Example: `sqlx::query("DELETE FROM favorites WHERE user_id = ? AND station_id = ?").bind(user.id).bind(id)`.
Tests: real SQLite and HTTP routes; deterministic local catalog fixtures for failures, auth/isolation and relay security. Browser verify desktop/mobile and accessibility.
Boundaries: implement dependencies/schema/CI authorized here; never commit credentials or user databases; ask before deleting an existing external repository.

Initialization: first admin from MEOW_INIT_USERNAME + MEOW_INIT_PASSWORD or one-time web wizard; atomic installation claim, existing accounts never reset. Theme addition: user-provided cyan/violet glass design as “琉璃夜色”, alongside walnut, stored locally, switching preserves audio.

Dependency exception: a documented local radiobrowser 0.6.1 patch updates reqwest/Hickory to eliminate known vulnerabilities while preserving the upstream API.

Fourth theme: user-provided Dribbble shot 11629433, “云白拟态”: cloud-white/blue hardware, inset green circular tuner, real station-index slider, volume and speaker texture. Credit Oleksandr Plyuto / heartbeat; no copied brand/logo or imaginary MHz/EQ controls. Keep existing three themes and audio lifecycle.

Latest user constraints: Chinese product name 阿喵收音机. Login/registration must use standalone /login, never an authentication modal. Home must remain restrained: a single filter trigger with active count, country/language/tag/sort inside a Radix dialog (bottom sheet on mobile), draft edits apply explicitly; advanced audio options collapsed. Directory browsing works with an empty keyword. Add authenticated fixed-target proxy connectivity test with latency and a per-station proxy-play icon; ordinary station clicks play directly.

Final requested capabilities: simplified Chinese/English UI with persistent preference, independently selectable light/dark modes for each of the four skins, and a theme-matched clock sleep timer with draggable hour/minute hands plus keyboard/numeric alternatives. Countdown uses a wall-clock deadline and survives station/style/login transitions; configurable emphasis lead times off/10s/30s/60s/300s with restrained animation and reduced-motion support. Update all README screenshots and publish a new version tag after checks.
