# brAIn-perception

Perception nodes for the [brAIn framework](https://github.com/tibzejoker/brAIn):

- **`@brain/node-voice`** — local STT (faster-whisper) + speaker diarization (WeSpeaker), spawns its own Python server.
- **`@brain/node-gaze`** — face detection + recognition (InsightFace) + gaze direction (Gazelle) + scene description (Moondream), spawns its own Python server.
- **`@brain/node-intent`** — pure-TS correlator over `voice.transcript` + `gaze.target.resolved` bus events. Maintains a persons store linking voice ↔ gaze ↔ canonical name. Publishes `intent.detected` (every correlated utterance) and `intent.addressed` when a speaker addresses the AI (camera gaze) — the latter carries the conversation overheard since the last addressed exchange (capped via `INTENT_CONTEXT_MAX_UTTERANCES` / `INTENT_CONTEXT_MAX_CHARS`), so the brain wakes once, with context, instead of on every sentence.
- **`@brain/node-media-source`** — virtual camera + microphone. One UI / one bus message (`media.play {file}`) plays a video into voice + gaze **in sync**, as if it were live input — no OS virtual-device drivers.
- **`@brain/node-tts`** — text-to-speech. OS voices by default (say / espeak-ng / System.Speech), or the **Kokoro-82M neural voice** (`config_overrides.engine: "kokoro"`, pure ONNX in-process, ~86 MB auto-download). Subscribed to `chat.response` in the vocal-chat seed: the brain's replies are spoken out loud, and `tts.spoken` exposes the wav for replay/muxing.

This repo is an extracted opinionated stack — the core brAIn engine
lives at [tibzejoker/brAIn](https://github.com/tibzejoker/brAIn).

## Layout

```
nodes/
  voice/         # TS handler + ui/ + server/ (Python)
  gaze/          # TS handler + ui/ + server/ (Python)
  intent/        # pure TS handler + ui/
  tts/           # TS handler (OS voices or Kokoro-82M ONNX)
  media-source/  # virtual camera + mic (video file → voice+gaze in sync)
seeds/
  voice.yaml gaze.yaml intent.yaml vocal-chat.yaml
scripts/
  setup-py.mjs       # cross-platform venv + model download
  seed-*.mjs         # apply a seed to a running brAIn API
  demo-video.mjs     # hands-free E2E: a video drives the whole stack
  record-demo.mjs    # screen-record the demo, mux audio + AI voice
  demo-scene.html    # the composed 3-panel scene the recorder films
```

## How it runs

The node packages reference `@brain/core` / `@brain/sdk` via
`workspace:*`: this repo is designed to live next to a
[brAIn](https://github.com/tibzejoker/brAIn) checkout as a pnpm
workspace member — exactly the layout `npm create brain` produces.
From the framework root, `pnpm --filter @brain/node-<name> build`
builds a node, and the TypeRegistry auto-discovers the sister repo at
boot; the easiest install path is the marketplace (`pnpm brain pull`).

## Setup

```bash
# Python servers (one-off; downloads ~700 MB of ML models)
pnpm setup:voice
pnpm setup:gaze
```

## Video-file demo mode (replay a video as camera + mic)

Both Python servers accept a media file in place of the live device —
the file plays at real-time pace, so VAD/STT/diarization and face/gaze
detection behave exactly as with a webcam + mic:

```bash
curl -X POST localhost:8765/api/capture/start \
  -H 'content-type: application/json' -d '{"file": "/abs/path/demo.mp4"}'
curl -X POST localhost:8766/api/capture/start \
  -H 'content-type: application/json' -d '{"file": "/abs/path/demo.mp4", "fps": 6}'
```

The **media-source node** is the friendly face of this: open its UI in
the dashboard, paste one file path, hit ▶ Play — it warms both servers
and starts the two playbacks in sync, shows what the fake camera sees
(the annotated gaze preview), and exposes the same control on the bus
(`media.play` / `media.stop`) for scripted demos. At EOF gaze holds the
last frame (`loop: true` to rewind forever) and voice appends 2 s of
silence so the last utterance finalizes.

Both servers also expose `POST /api/warmup` (load the ML models
without starting a capture) so multi-source starts stay in sync.

End-to-end, hands-free (seeds vocal-chat, plays the video on both
servers, auto-links intent persons, waits for the brain's reply —
spoken aloud by the Kokoro tts node):

```bash
# stack must be running (brAIn/: pnpm start) + ollama serve
pnpm demo:video                # uses <workspace>/demo_video.mp4
pnpm demo:video /path/to.mp4   # or any file
pnpm demo:record               # same, screen-recorded to an mp4 with
                               # the demo audio AND the AI's voice muxed in
                               # (one-off: npm i playwright && npx playwright install chromium)
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
