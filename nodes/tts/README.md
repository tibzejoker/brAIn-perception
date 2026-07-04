# tts

Text-to-speech node — gives the network a voice. Two engines:

- **OS voices** (default): `say` on macOS, `espeak-ng` on Linux,
  `System.Speech` on Windows. Zero downloads, instant.
- **Kokoro-82M** (`config_overrides.engine: "kokoro"`): neural TTS running
  fully in-process via [kokoro-js](https://www.npmjs.com/package/kokoro-js)
  (ONNX, no Python sidecar). The ~86 MB q8 model auto-downloads on first
  spawn and warms in the background; playback goes through the platform's
  wav player (`SoundPlayer` / `afplay` / `aplay`). Falls back to the OS
  engine if the model can't load.

## Topics

**Listens:**
- `tts.speak` — speak `payload.content` (metadata: `voice`, `rate`).
- `chat.response` — spoken aloud automatically **only when**
  `config_overrides.speak_replies: true` (the vocal-chat seed sets it);
  markdown is stripped first. Without the flag, replies stay text-only and
  the chat UI's 🔊 toggle drives speech on demand via `tts.speak`.
- `tts.cancel` — stop the current utterance.
- `tts.voices.list` — reply on `tts.voices` with the available voices
  (Kokoro: `af_heart`, `am_michael`, `bf_emma`, … — `af`/`am` en-US,
  `bf`/`bm` en-GB).

**Publishes:**
- `tts.status` — `ready` / `speaking` / `spoken` / `error`.
- `tts.spoken` *(kokoro engine)* — emitted right **before** playback with
  `{file, text, voice, started_at}`: the synthesized wav path, so tooling
  can replay it or mux it into a recording (`scripts/record-demo.mjs`
  uses exactly this to put the AI's voice into the demo mp4).

## Config

```yaml
config_overrides:
  engine: "kokoro"        # or omit for OS voices
  default_voice: "af_heart"
  default_rate: 180        # OS engines only (words/min)
  speak_replies: true      # auto-speak chat.response (default: off)
```

Env: `TTS_KOKORO_DTYPE` (default `q8`).
