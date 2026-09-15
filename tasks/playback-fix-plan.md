# Playback routing and motion follow-up

User-reported defect: HTTP HLS is blocked by HTTPS mixed-content guard, then rejected by relay. Fix both the route decision and HLS transport, keeping proxy/DNS security intact.

1. Outbound transport: public destination validation/pinning per redirect; support HTTP/HTTPS streams through HTTP/HTTPS/SOCKS5 proxies without weakening TLS/SNI. Shared fetch interface permits deterministic HLS route tests.
2. HLS relay: rewrite master/media playlist URI lines and URI attributes into authenticated, user/station-bound signed resource URLs; bounded playlists, byte-range and key/map/segment support. Never accept caller-supplied raw resource URLs.
3. UI: HLS uses relayed URL when selected; HTTP on HTTPS routes into relay automatically (login if needed), with a single useful failure path. Decode errors from relayed manifests.
4. Add theme-matched playback-state motion to all four receiver skins, stop on pause/buffering/error/hidden/reduced motion. Do not alter native audio/CORS just for decorative motion.
5. Regression tests, browser verification, README/screenshots and next patch tag release.
