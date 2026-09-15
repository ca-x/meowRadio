# Local security patch of radiobrowser 0.6.1

Source: crates.io radiobrowser 0.6.1, MIT, https://gitlab.com/radiobrowser/radiobrowser-lib-rust.
The application still uses the upstream RadioBrowserAPI and ApiStation interfaces.

- reqwest 0.11 → 0.12.28: removes old h2 0.3 and rustls-webpki 0.101 dependencies (RUSTSEC-2026-0258, 0098, 0099, 0104).
- async-std-resolver 0.24 → hickory-resolver 0.26.1 using TokioResolver: removes vulnerable hickory-proto 0.24 (RUSTSEC-2026-0119).
- async-std is optional and enabled only for upstream's optional blocking facade; meowRadio uses async API only.
- Upstream's missing example target declaration is omitted in this source distribution.

Do not silently replace this patched copy with registry 0.6.1. Remove the patch when an upstream release includes equivalent dependency updates, then run the catalog integration tests and audit.
