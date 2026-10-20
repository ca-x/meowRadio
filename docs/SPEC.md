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
Rust/Axum + SQLx SQLite (WAL, foreign keys, migrations); radiobrowser crate for discovery/API models/client. React/TypeScript/Vite, Radix UI primitives and TanStack Query. No external runtime frontend server. Public browsing, opt-in local accounts. Session cookies are HttpOnly/SameSite Strict with hashed random tokens stored in SQLite. Registration can be disabled. Proxy credentials are deployment configuration, never browser-visible. Direct audio is default; authenticated relay is optional and validates/pins public destination IPs on every redirect. HLS uses native playback or lazy-loaded hls.js, directly or via authenticated signed-resource relay.

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


## v0.1.2 交互修订

首页顶栏提供中文/English 和浅色/暗色快捷切换，设置保留四种收音机外观、连接方式与版本。首页导航保留音频实例与当前筛选；浏览状态、页码及默认中转方式保存在本浏览器。HTTP HLS 可通过认证中转播放，所有子资源维持签名与公共目的地址检查。

宣传文字使用 TransientCopy：首次进入可见区域淡入 180ms、停留 1.5 秒、淡出 200ms，保留布局位置，重渲染不重复；减少动态效果时缩短透明度过渡。功能说明、错误与播放状态不自动隐藏。四种外观使用播放状态动效，仅实际播放且页面可见、音量非零时运动，不伪造频谱。LazyCat 控制栏能力仅在受支持 WebShell 环境启用。


## v0.2.0 confirmed behavior

Nine receiver skins; each new skin has a separate stylesheet. User menu: Personal options, System settings, Recordings, Sign out. Personal options has exactly Profile (nickname/avatar) and Change password tabs. System settings keeps Themes and Settings tabs with playback/recording preferences, proxy diagnostic and version. Recording management is a separate dialog. Temporary station/server playback does not change the saved default; current relay is controlled with an icon-only toggle and accessible tooltip.

Recordings are captured from same-origin relayed audio and uploaded under record/<username>/UUID; avatar files use avatar/<username>.webp. Owners are authenticated per request and upload identity is checked against captured owner. Stopping/changing station saves the previous segment; resume never automatically restarts recording. Stream recovery uses bounded backoff and respects pause, library playback and absolute sleep deadline.


## v0.3.0 personal sources

Owner-bound URL/file JSON sources with independent /sources management, format guide and example download. Home separates system/personal catalogs; favorites combine them with explicit personal-origin badges. Stable source-local station identities survive successful refreshes; failures retain the previous snapshot. All source mutations validate the captured owner header. Deletes cascade only corresponding personal favorites.

Multiple URLs per station, category paths, legacy allowlisted header/reuse suffixes; HTTP(S) audio/HLS/FLV, HTML/JSON/JSONP resolution and RTMP(S)/RTSP(S)/MMS/MMST/MMSH ingress. Server FFmpeg normalizes output to MP3/128k. Public-network pinning and redirect validation extend to every media resource. No imported shell commands or third-party JavaScript execution. Docker bundles FFmpeg; native installs require it.

Invalid import addresses and complete runtime validation failures appear in confirmation dialogs. Nothing is silently removed. Clearing c/d from A=[b,c,d] retains A=[b] and its favorite; only empty stations cascade-delete. Busy/missing media components are not invalid addresses. Confirmation is bound to the reviewed snapshot/current candidate identity; refresh or deletion cancels validation. Closing/navigating away cancels active scans.

## v0.4.0 globe and nebula browsing

User requested RoamDial-inspired interactions and the same browser rendering technology, then authorized version bump, commit, push and release tag. The reference bundle identifies Three.js r186 using WebGL 2; the application uses Three.js 0.186.1 and OrbitControls.

- List, globe and genre-nebula views share the current page of station results, searches, filters and favorites; persist the chosen view separately from the receiver skin.
- Render the globe and nebula in WebGL 2. Orbit by dragging, zoom by wheel/pinch or buttons, reset the camera, and support arrow/plus/minus keyboard control.
- Click a station marker to use the existing playback route and permissions. A keyboard-accessible station selector also provides listen, single-use server relay and favorite actions.
- Expose upstream optional latitude/longitude. Valid coordinates take precedence; country centroids are explicitly approximate. Preserve legacy saved station JSON without coordinates. Unknown locations remain playable through the selector, nebula or list.
- Group nebula markers by station genre, including imported Chinese category paths. Visual particles are decorative; only station markers are playable.
- Keep the existing audio element during view/source/search changes. Load Three.js only on demand; dispose all GPU resources on view replacement, stop drawing offscreen/hidden, and disable camera damping for reduced motion.
- Ship browser-local map data and third-party notices, translated controls, 375px responsive layout, WebGL failure/context-loss recovery and a usable list fallback.

Verification: frontend spatial/lifecycle/navigation tests, existing frontend and Rust suites, production build, formatting/Clippy, dependency audits and supported/unsupported WebGL browser checks.


## v0.4.1 viewport exploration and list page sizes

User corrected the original page-bound 3D design: list views must remain paged, while globe/nebula explore the complete directory with filters retained. Final clarification asks to render and filter only viewport-visible points and countries for performance.

- List page sizes 24/100/500/1000 persist independently; changing size resets source page indices. Private ownership and query validation remain enforced.
- 3D overview represents global countries and actual directory tags through nonplayable clusters, including a drillable unknown remainder for untagged/rare tags. There are no 3D previous/next-page controls.
- Visible viewport scopes drive cached/coalesced detail requests. Zooming and explicit cluster activation increase detail; partial results retain aggregate remainders. Never wait for a full remote dump, or claim partial detail is a complete station list.
- Visible geometry indices are culled against the camera and globe horizon before GPU submission. React visibility updates occur after camera settles, with a camera fingerprint preventing data-driven query loops. Camera survives detail updates; explicit main-search/filter scopes can recenter.
- Country options, selector nodes and genre buttons follow settled visibility. Genre badges explicitly count points, including aggregates; overlapping upstream tag totals are not added as unique station totals.
- Clusters offer Explore only and cannot enter the audio player, relay or favorites. Actual station selection preserves existing audio/permissions. Scope/owner changes cannot reuse private query placeholders.
- View queries validate bounded visible scopes and detail levels; cached exploration snapshots have a 100,000-node/128-key budget without truncating responses. Unknown counts remain unknown; small territories use bundled 50m country centroids.
