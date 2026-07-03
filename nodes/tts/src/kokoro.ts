/**
 * Kokoro-82M neural TTS backend — pure Node (kokoro-js + onnxruntime),
 * no Python server. The ~86 MB q8 model downloads from HuggingFace on
 * first load and is cached by transformers.js; synthesis writes a wav
 * to the node's data dir so callers (and demo tooling) can replay or
 * mux the audio.
 */
import * as fs from "node:fs";
import * as path from "node:path";

// kokoro-js is ESM-only while this package compiles to CommonJS: a literal
// `import()` would be transpiled by tsc into `require()` and crash at
// runtime. Routing through Function keeps it a real dynamic import.
const importEsm = new Function("m", "return import(m)") as (m: string) => Promise<unknown>;

const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
export const DEFAULT_KOKORO_VOICE = "af_heart";

interface KokoroAudio {
  save(file: string): Promise<void>;
}

interface KokoroTts {
  generate(text: string, opts: { voice: string; speed?: number }): Promise<KokoroAudio>;
  voices?: Record<string, unknown>;
}

interface KokoroModule {
  KokoroTTS: {
    from_pretrained(id: string, opts: { dtype: string }): Promise<KokoroTts>;
  };
}

let instance: Promise<KokoroTts> | null = null;
let loaded = false;

/** True once the model finished loading (never throws, never triggers a load). */
export function kokoroLoaded(): boolean {
  return loaded;
}

/**
 * Lazy singleton. First call downloads + loads the model (tens of seconds);
 * later calls reuse it. A failed load clears the slot so the next attempt
 * can retry (e.g. network came back).
 */
export function loadKokoro(): Promise<KokoroTts> {
  if (!instance) {
    const dtype = process.env.TTS_KOKORO_DTYPE ?? "q8";
    instance = (importEsm("kokoro-js") as Promise<KokoroModule>)
      .then((m) => m.KokoroTTS.from_pretrained(MODEL_ID, { dtype }))
      .then((tts) => {
        loaded = true;
        return tts;
      });
    instance.catch(() => { instance = null; });
  }
  return instance;
}

/** Synthesize `text` to a wav file in `outDir` and return its path. */
export async function kokoroSynthesize(
  text: string,
  voice: string,
  outDir: string,
  speed?: number,
): Promise<string> {
  const tts = await loadKokoro();
  fs.mkdirSync(outDir, { recursive: true });
  const audio = await tts.generate(text, { voice, speed });
  const file = path.join(outDir, `kokoro-${Date.now()}.wav`);
  await audio.save(file);
  return file;
}

/** Voice ids exposed by the loaded model (af_* / am_* = US, bf_* / bm_* = GB). */
export async function kokoroVoices(): Promise<Array<{ name: string; language?: string }>> {
  const tts = await loadKokoro();
  const ids = Object.keys(tts.voices ?? {});
  const fallback = [
    "af_heart", "af_bella", "af_nicole", "af_sarah", "am_adam", "am_michael",
    "bf_emma", "bf_isabella", "bm_george", "bm_lewis",
  ];
  return (ids.length > 0 ? ids : fallback).map((name) => ({
    name,
    language: name.startsWith("b") ? "en-GB" : "en-US",
  }));
}
