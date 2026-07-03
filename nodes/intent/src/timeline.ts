/**
 * In-memory ring buffer of voice + gaze events seen since start.
 * The correlator queries this each time a finalized voice segment lands
 * to compute the dominant gaze target during the speech window.
 */

export interface VoiceSegment {
  ts: number;            // wall-clock seconds when we saw the segment
  voice_profile_id: string;
  voice_name: string;
  text: string;
  t_start: number;
  t_end: number;
  confidence: number;
  provisional: boolean;
  person_id: string | null;
  ts_end: number | null; // wall-clock when audio ended (from voice engine)
  /** Set once the correlator consumed this segment — correlation can be
   *  reached from three paths (deferred arrival timer, person retro-link,
   *  late re-check) and must fire exactly once. */
  correlated: boolean;
}

export interface GazeEvent {
  ts: number;
  target_kind: string;   // 'profile' | 'camera' | 'scene' | 'unknown'
  source_gaze_profile_id: string | null;
  target_gaze_profile_id: string | null;
  description: string | null;
  gaze_x: number | null;
  gaze_y: number | null;
  source_person_id: string | null;
  target_person_id: string | null;
}

export interface TimelineEntry {
  kind: "voice" | "gaze";
  ts: number;
  person_id: string | null;
  voice_profile_id?: string | null;
  gaze_profile_id?: string | null;
  text?: string | null;
  t_start?: number | null;
  t_end?: number | null;
  target_kind?: string | null;
  target_gaze_profile_id?: string | null;
}

const VOICE_BUFFER_MAX = 500;
const GAZE_BUFFER_MAX = 1000;
const RETENTION_S = 300; // 5 min ring window

export class Timeline {
  private readonly voice: VoiceSegment[] = [];
  private readonly gaze: GazeEvent[] = [];
  /** Cursor for the gaze poll — caller manages it. */
  gaze_cursor = 0;

  get retention_s(): number { return RETENTION_S; }

  addVoice(seg: VoiceSegment): void {
    this.voice.push(seg);
    while (this.voice.length > VOICE_BUFFER_MAX) this.voice.shift();
  }

  addGaze(ev: GazeEvent): void {
    this.gaze.push(ev);
    while (this.gaze.length > GAZE_BUFFER_MAX) this.gaze.shift();
  }

  /** Return gaze events whose source_person_id matches and ts falls in [since, until]. */
  gazeEventsFor(personId: string, since: number, until: number): GazeEvent[] {
    return this.gaze.filter((e) =>
      e.source_person_id === personId && e.ts >= since && e.ts <= until,
    );
  }

  /** Snapshot for the timeline UI, optionally filtered by since-ts. */
  snapshot(since?: number): TimelineEntry[] {
    const cutoff = since ?? 0;
    const out: TimelineEntry[] = [];
    for (const v of this.voice) {
      if (v.ts < cutoff) continue;
      out.push({
        kind: "voice",
        ts: v.ts_end ?? v.ts,
        person_id: v.person_id,
        voice_profile_id: v.voice_profile_id,
        text: v.text,
        t_start: v.t_start,
        t_end: v.t_end,
      });
    }
    for (const g of this.gaze) {
      if (g.ts < cutoff) continue;
      out.push({
        kind: "gaze",
        ts: g.ts,
        person_id: g.source_person_id,
        gaze_profile_id: g.source_gaze_profile_id,
        target_kind: g.target_kind,
        target_gaze_profile_id: g.target_gaze_profile_id,
      });
    }
    return out.sort((a, b) => a.ts - b.ts);
  }

  /** Drop entries older than the retention window. Called periodically. */
  prune(now: number): void {
    const cutoff = now - RETENTION_S;
    while (this.voice.length && this.voice[0].ts < cutoff) this.voice.shift();
    while (this.gaze.length && this.gaze[0].ts < cutoff) this.gaze.shift();
  }

  /**
   * Retro-link buffered events to a person that was just created/updated.
   *
   * Voice profiles only exist after their first finalized segment and
   * humans link persons even later, so the segments and gaze events of
   * the last few seconds routinely predate the person row. Without this,
   * an utterance that arrived a moment before the link is silently lost
   * to the correlator.
   *
   * Mutates matching gaze events' person ids in place and returns the
   * voice segments (person_id stamped) that are now correlatable —
   * finalized, previously unlinked, matching the person's voice profile.
   */
  relink(person: { id: string; voice_profile_id: string | null; gaze_profile_id: string | null }): VoiceSegment[] {
    if (person.gaze_profile_id) {
      for (const g of this.gaze) {
        if (g.source_person_id === null && g.source_gaze_profile_id === person.gaze_profile_id) {
          g.source_person_id = person.id;
        }
        if (g.target_person_id === null && g.target_gaze_profile_id === person.gaze_profile_id) {
          g.target_person_id = person.id;
        }
      }
    }
    if (!person.voice_profile_id) return [];
    const out: VoiceSegment[] = [];
    for (const v of this.voice) {
      if (v.person_id !== null || v.provisional || v.correlated) continue;
      if (v.voice_profile_id !== person.voice_profile_id) continue;
      v.person_id = person.id;
      out.push(v);
    }
    return out;
  }
}
