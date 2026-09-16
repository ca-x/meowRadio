# Receiver themes and local recording

- Add Arc (Dribbble 24101705, Slava Kornilov / Geex Arts), Ivory, Monochrome, Silver retro, Pixel red from user references. Keep existing skins and live audio instance. Real station indexes, no invented frequency.
- Each new skin has its own CSS file; shared controls and settings dialog styles are separate. Chinese/English, light/dark and reduced motion remain supported.
- Broaden desktop settings to 820px, two Radix Tabs for Themes and Settings. Use a three-column desktop/two-column mobile theme grid.
- Local recording only for same-origin server relay, no microphone permission or crossOrigin changes. Detect MediaRecorder/captureStream and actual supported containers. Start/stop, bounded memory and duration, local-save prompt, canonical errors and format/bitrate/duration settings.
- Ruling: confirmed browser capability by recording real relayed CNR-2 HLS; ffprobe found Opus 48kHz stereo and measured non-silent audio (-17.7dB mean). Implement supported paths, explain unsupported browsers/direct playback without guessing.
- Verify UI/control continuity, responsive overflow, individual palettes, tab keyboard behavior and recording with real media; update README/screenshots/release.
