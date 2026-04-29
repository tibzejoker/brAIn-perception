# brAIn-perception

Perception nodes for the [brAIn framework](https://github.com/tibzejoker/brAIn):

- **`@brain/node-voice`** — local STT (faster-whisper) + speaker diarization (WeSpeaker), spawns its own Python server.
- **`@brain/node-gaze`** — face detection + recognition (InsightFace) + gaze direction (Gazelle) + scene description (Moondream), spawns its own Python server.
- **`@brain/node-intent`** — pure-TS correlator over `voice.transcript` + `gaze.target.resolved` bus events. Maintains a persons store linking voice ↔ gaze ↔ canonical name. Publishes `intent.detected`.

This repo is an extracted opinionated stack — the core brAIn engine
lives at [tibzejoker/brAIn](https://github.com/tibzejoker/brAIn).

## Layout

```
nodes/
  voice/    # TS handler + ui/ + server/ (Python)
  gaze/     # TS handler + ui/ + server/ (Python)
  intent/   # pure TS handler + ui/
seeds/
  voice.yaml gaze.yaml intent.yaml vocal-chat.yaml
scripts/
  setup-py.mjs       # cross-platform venv + model download
  seed-*.mjs         # apply a seed to a running brAIn API
```

## Status — work in progress (Phase 1.4)

This repo is being extracted from the main brAIn monorepo. **It does
not yet build or run on its own.** The node packages still reference
`@brain/core` and `@brain/sdk` via `workspace:*`, which will be
resolved when:

- (Phase 1.5) the brAIn framework's `@brain/core` and `@brain/sdk` are
  published, OR
- you have a sibling checkout of `brAIn/` next to this repo and use
  pnpm's `link-workspace-packages` mode.

Until then, treat this repo as the canonical source of the perception
nodes' code. The brAIn monorepo still ships in-tree copies under
`nodes/` for working dev.

## Setup

```bash
# Python servers (one-off; downloads ~700 MB of ML models)
pnpm setup:voice
pnpm setup:gaze
```

## Standalone Python (debug only)

```bash
pnpm dev:voice:server     # uvicorn :8765
pnpm dev:gaze:server      # uvicorn :8766
```

These run the Python servers in isolation — useful to curl
`/api/capture/start` and inspect events without booting the full brAIn
stack.

## License

[MIT](./LICENSE) — Copyright © 2026 Thibaut Léaux.
