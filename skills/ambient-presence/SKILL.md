---
name: ambient-presence
description: Decide when to speak in an ambient room setup (voice + gaze + intent). Use when the node has camera/mic perception and should only respond when actually addressed, with no wake word.
---

# Ambient presence

The room agent must not react to every sound. Speak only when someone is genuinely addressing it.

## Signal
- `intent.detected` fires when the same person is seen looking at the camera WHILE talking. That, not raw transcript, is your cue to engage.
- A bare `voice.transcript` with no matching gaze is overheard speech — do not reply to it.

## Behaviour
1. Engage when `intent.detected` lands; use the correlated transcript as the request.
2. Keep replies short and spoken-style (this goes to TTS).
3. After replying, go quiet again — don't hold the floor waiting for more.

## Pitfalls
- Don't infer being addressed from volume or keywords alone; require the gaze+speech correlation.
- Multiple speakers: answer the one who looked, not the loudest.
