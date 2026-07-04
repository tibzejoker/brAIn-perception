# media-source

Virtual camera + microphone. One UI, one file path, one Play button — the
video plays into the **voice** (audio track → STT/diarization) and
**gaze** (frames → face/gaze tracking) pipelines in sync, and everything
downstream (intent, brain, tts) behaves exactly as with live devices.

No OS drivers, no virtual-device hacks: the node warms both perception
servers (`POST /api/warmup`, so the two playbacks start within
milliseconds of each other) then drives their file-capture modes
(`POST /api/capture/start {file}`).

## Topics

**Listens:**
- `media.play` — `{file: "/abs/path.mp4", loop?: bool}`. Warms models,
  then starts both captures. `loop` rewinds the gaze side at EOF instead
  of holding the last frame.
- `media.stop` — stop both captures.
- `media.status.request` — publish an immediate snapshot.

**Publishes:**
- `media.status` — `{state: idle|warming|playing|ended|error, file, loop,
  error, voice: {...}, gaze: {...}}` on every transition and once per
  second while playing.

## UI

Shows "what the camera sees" (the gaze server's annotated preview — the
video with live bounding boxes and gaze arrows) plus per-pipeline status
chips. The file path is remembered across sessions.

Scripted use (any bus publisher works):

```bash
curl -X POST http://localhost:3000/node/<media-node-id>/media.play \
  -H 'content-type: application/json' \
  -d '{"file": "/abs/path/demo.mp4"}'
```

Env: `VOICE_SERVER_URL` / `GAZE_SERVER_URL` (defaults `127.0.0.1:8765/8766`),
`MEDIA_POLL_INTERVAL_MS` (1000).
