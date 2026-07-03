/**
 * Intent node — pure-TS bus consumer.
 *
 * Subscribes to:
 *   - voice.transcript          (finalized SegmentEvent metadata)
 *   - gaze.target.resolved      (gaze /api/events row metadata)
 *   - intent.persons.*          (CRUD via bus, mirror of HTTP API)
 *
 * Publishes:
 *   - intent.detected           (one per correlated voice segment)
 *   - intent.persons.changed    (after create/update/delete)
 *
 * Owns:
 *   - SQLite at data/intent.db (persons + intents history)
 *   - HTTP+WS server on port 8767 (UI surface, mirror of legacy intent server)
 *
 * No Python child process. The Python code under nodes/intent/server is
 * superseded — voice and gaze handlers now bridge their own server events
 * onto the brAIn bus, and this node correlates them entirely in TS.
 */
import * as path from "node:path";
import * as fs from "node:fs";
import { BrainService, logger, getNodeDataRoot } from "@brain/core";
import type { NodeHandler, NodeInfo, NodeOnSpawn, NodeTeardown } from "@brain/sdk";
import { IntentStore, type IntentRecord, type Person } from "./store";
import { Timeline, type GazeEvent, type VoiceSegment } from "./timeline";
import { IntentCorrelator, DEFAULT_CORRELATOR_CONFIG } from "./correlator";
import { startIntentServer, type IntentServerHandle } from "./server";

const SERVER_PORT = Number(process.env.INTENT_SERVER_PORT ?? "8767");
// Correlation runs this long after a finalized segment arrives, not at
// arrival: gaze frames sit in the analysis queue for a beat, so the
// glance-at-camera belonging to an utterance can land on the bus a couple
// of seconds after its transcript. Correlating immediately would vote on
// a timeline that doesn't contain those events yet.
const CORRELATE_DEFER_MS = Number(process.env.INTENT_CORRELATE_DEFER_MS ?? "3000");
// Caps for the conversation delta shipped with each intent.addressed —
// everything overheard since the LAST addressed exchange, most recent kept.
const CONTEXT_MAX_UTTERANCES = Number(process.env.INTENT_CONTEXT_MAX_UTTERANCES ?? "20");
const CONTEXT_MAX_CHARS = Number(process.env.INTENT_CONTEXT_MAX_CHARS ?? "1500");

/** One overheard utterance, trimmed to what a prompt needs. */
interface ContextUtterance {
  ts: string;
  speaker: string;
  target_kind: string;
  target_name: string | null;
  text: string;
}

function toContextUtterance(intent: IntentRecord): ContextUtterance {
  return {
    ts: intent.ts,
    speaker: intent.source_name ?? "Unknown speaker",
    target_kind: intent.target_kind,
    target_name: intent.target_name,
    text: intent.text,
  };
}

/** Keep the most recent utterances within both caps (count + total chars). */
function capContext(buffer: readonly ContextUtterance[]): ContextUtterance[] {
  const out: ContextUtterance[] = [];
  let chars = 0;
  for (let i = buffer.length - 1; i >= 0 && out.length < CONTEXT_MAX_UTTERANCES; i--) {
    chars += buffer[i].text.length;
    if (chars > CONTEXT_MAX_CHARS && out.length > 0) break;
    out.unshift(buffer[i]);
  }
  return out;
}

// Where intent.db lives. Resolved lazily (on first boot, after the framework
// has wired its data root) so it lands in the shared <dataRoot>/ next to
// brain.db — getNodeDataRoot() is <dataRoot>/nodes, so its parent is the
// data root. INTENT_DB_DIR overrides for standalone/test runs.
function resolveDbDir(): string {
  return process.env.INTENT_DB_DIR ?? path.resolve(getNodeDataRoot(), "..");
}

let nodeId: string | null = null;
let store: IntentStore | null = null;
let timeline: Timeline | null = null;
let correlator: IntentCorrelator | null = null;
let server: IntentServerHandle | null = null;
let serverBoot: Promise<void> | null = null;
let pruneTimer: NodeJS.Timeout | null = null;
let contextBuffer: ContextUtterance[] = [];

function bus(): ReturnType<typeof getBusOrNull> { return getBusOrNull(); }
function getBusOrNull(): NonNullable<typeof BrainService.current>["bus"] | null {
  return BrainService.current?.bus ?? null;
}

function publish(topic: string, payload: Record<string, unknown>, criticality = 2): void {
  const b = bus();
  if (!b || !nodeId) return;
  b.publish({
    from: nodeId,
    topic,
    type: "text",
    criticality,
    payload: { content: JSON.stringify(payload) },
    metadata: payload,
  });
}

function ensureBoot(): Promise<void> {
  if (serverBoot) return serverBoot;
  const dbDir = resolveDbDir();
  const dbPath = path.join(dbDir, "intent.db");
  fs.mkdirSync(dbDir, { recursive: true });
  store = new IntentStore(dbPath);
  timeline = new Timeline();
  correlator = new IntentCorrelator(
    store, timeline, DEFAULT_CORRELATOR_CONFIG,
    (intent, dispatch) => {
      server?.broadcastIntent(intent);
      publish("intent.detected", intent as unknown as Record<string, unknown>, 4);
      if (!dispatch.addressed) {
        // Humans talking among themselves: accumulate as context, don't
        // wake the brain — it subscribes to intent.addressed only.
        contextBuffer.push(toContextUtterance(intent));
        return;
      }
      // Someone addressed the AI → ship the question together with the
      // conversation overheard since the last addressed exchange, then
      // start a fresh delta.
      const context = capContext(contextBuffer);
      publish("intent.addressed", {
        question: intent as unknown as Record<string, unknown>,
        context,
        dropped_utterances: contextBuffer.length - context.length,
        camera_overlap_s: dispatch.camera_overlap_s,
      }, 4);
      contextBuffer = [];
    },
  );
  pruneTimer = setInterval(() => timeline?.prune(Date.now() / 1000), 30_000);
  serverBoot = startIntentServer({
    port: SERVER_PORT,
    store,
    timeline,
    onPersonChange: (kind, person) => {
      if (kind !== "delete") retroCorrelate(person as Person);
      publish("intent.persons.changed", { kind, person });
    },
  }).then((handle) => {
    server = handle;
    if (handle.spawned) {
      logger.info({ port: SERVER_PORT, db: dbPath }, "intent node: server listening");
    } else {
      logger.warn(
        { port: SERVER_PORT, db: dbPath },
        "intent node: port already in use — attached to existing server (likely an orphan from a prior run; correlator runs anyway, persons writes go to the orphan's store)",
      );
    }
  });
  return serverBoot;
}

/**
 * Single choke-point into the correlator: resolves the person link if it
 * appeared since the segment arrived, and guarantees a segment correlates
 * exactly once no matter which path (deferred timer, person retro-link)
 * reaches it first.
 */
function fireCorrelation(seg: VoiceSegment): void {
  if (!store || !correlator || seg.correlated || seg.provisional) return;
  if (!seg.person_id) {
    const linked = store.findByVoice(seg.voice_profile_id);
    if (!linked) return; // retro-correlation fires it when the person lands
    seg.person_id = linked.id;
  }
  seg.correlated = true;
  correlator.onSegment(seg);
}

/**
 * Re-run correlation over buffered-but-unlinked events after a person is
 * created or updated. Voice profiles only exist once their first segment
 * finalizes, so person linkage always races the very utterances it is
 * meant to correlate — without this, the segment that triggered the link
 * never reaches the correlator (nor the brain).
 */
function retroCorrelate(person: Person): void {
  if (!timeline || !correlator) return;
  for (const seg of timeline.relink(person)) fireCorrelation(seg);
}

function ingestVoiceTranscript(metadata: Record<string, unknown>): void {
  if (!store || !timeline || !correlator) return;
  const voicePid = String(metadata.speaker_id ?? "");
  if (!voicePid) return;
  const provisional = Boolean(metadata.provisional);
  const linked = store.findByVoice(voicePid);
  const seg: VoiceSegment = {
    ts: Date.now() / 1000,
    voice_profile_id: voicePid,
    voice_name: String(metadata.name ?? ""),
    text: String(metadata.text ?? ""),
    t_start: Number(metadata.t_start ?? 0),
    t_end: Number(metadata.t_end ?? 0),
    confidence: Number(metadata.confidence ?? 0),
    provisional,
    person_id: linked?.id ?? null,
    ts_end: metadata.ts_end !== null && metadata.ts_end !== undefined ? Number(metadata.ts_end) : null,
    correlated: false,
  };
  timeline.addVoice(seg);
  if (!provisional) setTimeout(() => fireCorrelation(seg), CORRELATE_DEFER_MS);
}

function ingestGazeEvent(metadata: Record<string, unknown>): void {
  if (!store || !timeline) return;
  const sourceGid = (metadata.source_profile_id as string | null) ?? null;
  const targetGid = (metadata.target_profile_id as string | null) ?? null;
  const sourceP = sourceGid ? store.findByGaze(sourceGid) : null;
  const targetP = targetGid ? store.findByGaze(targetGid) : null;
  const ts = parseIsoEpoch(metadata.ts as string | undefined) ?? Date.now() / 1000;
  const ev: GazeEvent = {
    ts,
    target_kind: String(metadata.target_type ?? "unknown"),
    source_gaze_profile_id: sourceGid,
    target_gaze_profile_id: targetGid,
    description: (metadata.description as string | null) ?? null,
    gaze_x: (metadata.gaze_x as number | null) ?? null,
    gaze_y: (metadata.gaze_y as number | null) ?? null,
    source_person_id: sourceP?.id ?? null,
    target_person_id: targetP?.id ?? null,
  };
  timeline.addGaze(ev);
}

function parseIsoEpoch(s?: string): number | null {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t / 1000 : null;
}

function applyPersonCommand(topic: string, payload: Record<string, unknown>): void {
  if (!store) return;
  if (topic === "intent.persons.create") {
    const p = store.createPerson({
      name: String(payload.name ?? "Unknown"),
      color: payload.color as string | undefined,
      voice_profile_id: (payload.voice_profile_id as string | null | undefined) ?? null,
      gaze_profile_id: (payload.gaze_profile_id as string | null | undefined) ?? null,
    });
    retroCorrelate(p);
    publish("intent.persons.changed", { kind: "create", person: p });
  } else if (topic === "intent.persons.update") {
    const id = String(payload.id ?? "");
    if (!id) return;
    const p = store.patchPerson(id, payload as Partial<Person>);
    if (p) {
      retroCorrelate(p);
      publish("intent.persons.changed", { kind: "update", person: p });
    }
  } else if (topic === "intent.persons.delete") {
    const id = String(payload.id ?? "");
    if (!id) return;
    if (store.deletePerson(id)) publish("intent.persons.changed", { kind: "delete", person: { id } });
  }
}

export const onSpawn: NodeOnSpawn = async (info: NodeInfo) => {
  nodeId = info.id;
  await ensureBoot();
};

export const handler: NodeHandler = async (ctx) => {
  nodeId ??= ctx.node.id;
  await ensureBoot();

  for (const msg of ctx.messages) {
    const meta = msg.metadata ?? {};
    if (msg.topic === "voice.transcript") {
      ingestVoiceTranscript(meta);
    } else if (msg.topic === "gaze.target.resolved") {
      ingestGazeEvent(meta);
    } else if (msg.topic.startsWith("intent.persons.")) {
      applyPersonCommand(msg.topic, meta);
    }
  }
  return Promise.resolve();
};

export const teardown: NodeTeardown = async () => {
  if (pruneTimer) { clearInterval(pruneTimer); pruneTimer = null; }
  if (server) { await server.close(); server = null; }
  if (store) { store.close(); store = null; }
  serverBoot = null;
  timeline = null;
  correlator = null;
  contextBuffer = [];
  nodeId = null;
};

export default handler;
