---
name: operate-tts
description: Speak out loud through a running text-to-speech node. Use when a tts node is live and you want a reply spoken (pick a voice, keep it short).
requires_node: tts
---

# Driving a live TTS node

A `tts` node is running, so you can speak instead of only writing.

## How
1. Publish the text to speak on the tts node's input (it reads `content`).
2. Keep spoken replies short and plain — no markdown, no code blocks; they're read aloud verbatim.
3. To use a specific voice, request the voices list first, then pass a valid voice id; don't invent one.

## Pitfalls
- Don't send a wall of text to TTS — summarise to a sentence or two.
- If no voice is specified, let the node use its default; a bad voice id fails the utterance.
- This is node-scoped: it's only relevant while a tts instance is actually spawned.
