# Implementation plan
1. Foundation: configuration, migrations, authentication and route tests.
2. Catalog adapter and favorites; proxy-aware validated streaming relay.
3. React receiver and discovery interface, login and settings.
4. Embedded frontend, documentation, Docker and gated release workflows.
5. Build/test/browser/security checks, create repository, push and monitor CI.

## Final appearance and sleep-timer extension
1. SleepTimer component: clock-like hour/minute hand duration selection, presets, cancel, wall-clock deadline, keyboard/touch and expiry tests. Own files only; parent integrates into Player.
2. Independent light/dark palettes for all four skins, implemented only in color-modes.css.
3. Chinese/English UI dictionary from extracted keys. Parent wires i18next and component subscriptions, persists language/color choices in existing settings.
4. Resolve review findings: bounded directory failure cache; keep home/player mounted while standalone /login renders and carry intended favorite/proxy action through auth.
5. Full tests/browser review and publish v0.1.1.
