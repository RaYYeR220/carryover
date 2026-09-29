# Architecture

This is a module-by-module tour of `apps/server`, the call lifecycle from dial to summary, the Relay Brain's decision table, and the audio path. For the product-level picture, see [`README.md`](../README.md) and the diagram at [`architecture.svg`](architecture.svg).

## Workspace layout

```
apps/server/src/
  audio/      mu-law codec, DTMF synth/detect, hold-music generator, real-time pacer
  aai/        AssemblyAI clients: Voice Agent session, stored-agent registry, captions stream
  llm/        streaming chat provider, Chat-Completions wire format (Venice / AssemblyAI LLM Gateway)
  brain/      the BYO-LLM endpoint: request parsing, policy/tools, the fact gate, SSE writer
  call/       CallSession orchestrator, polite queue, line-state tracker, speaker map, summary, registry
  legs/       PhoneLeg implementations: browser practice line, simulated-business scenario, (PSTN: interface only)
  scenarios/  the simulated-business engine + scenario library (5 businesses)
  api/        Fastify routes, WebSocket handlers, MCP server, rate-limit/body-size guards
apps/web/src/ React SPA: landing, start-call flow, live call screen, sample player, practice line, history, profile
packages/protocol/src/  shared zod types: Autonomy, LineState, Fact, AppEvent, AppCommand, StartCallRequest, ...
```

## Call lifecycle

1. **Start.** `POST /api/calls` (or the MCP `place_call` tool) validates a `StartCallRequest` against the shared protocol schema, resolves the target into a `PhoneLeg` (`BrowserLeg` for a practice-line code, `ScenarioLeg` for a simulated business), applies the per-IP rate limit and the concurrent-call cap, and creates a `CallSession` (`apps/server/src/call/callRegistry.ts`, `apps/server/src/api/routes.ts`).
2. **`CallSession.start()`** (`apps/server/src/call/callSession.ts`) dials the leg, registers/reuses the stored relay agent for the chosen voice (`AgentRegistry.ensureRelayAgent`), opens a Voice Agent session against that stored agent, and opens an independent Universal-3.5 Pro captions session on the same inbound audio. All three (leg, Voice Agent, captions) must come up; a failure in any of them tears the others down and the call ends.
3. **While connected**, inbound audio from the leg is chunked to 100 ms (`FrameAggregator`) and fanned out to both AssemblyAI sessions. Caption turns update the `LineStateTracker` (menu / hold / human / voicemail) and the `SpeakerMap` (new-speaker detection), and — once final — are added to the fact-gate ledger as `'other'`-sourced evidence.
4. **The Voice Agent's own turns** call back into the Relay Brain (`POST /brain/v1/chat/completions`), which reads the call's live state through a `BrainCallView` (`CallSession.brainView()`) and returns verbatim text, silence, or a gated LLM stream — see [Brain decision table](#brain-decision-table) below.
5. **Typed text and ask-card answers** go through `PoliteQueue`, which holds them until the line is free (nobody talking, no reply of ours in flight), then sends `reply.create "RELAY_UTTERANCE:<nonce>"`; the Brain's next request pulls that exact text back out with the nonce and speaks it unmodified — no LLM involved for verbatim text.
6. **Every AppEvent** (captions, `agent.said`, `ask`, `alert`, `dtmf`, `gate.blocked`, `commitment`, …) is pushed to the app's WebSocket (`apps/server/src/api/appSocket.ts`) and kept in a bounded history so a reconnecting client replays a consistent view.
7. **End.** On hangup (either side), a time limit, or a fatal error, `CallSession.end()` closes the Voice Agent session, the captions session and the leg synchronously first (so a bookkeeping error can't skip cleanup), then runs `summarize()` against the transcript (LLM-generated outcome/bullets, falling back to the commitments noted live if the model call fails or the transcript is empty) and emits the final `summary` event.

## Brain decision table

`decide(parsed, view)` in [`apps/server/src/brain/policy.ts`](../apps/server/src/brain/policy.ts) is checked in this exact order on every request AssemblyAI's Voice Agent sends to the Brain:

| # | Condition | Result |
|---|---|---|
| 1 | No `BrainCallView` for the call tag (unknown/dead call) | silence: `unknown-call` |
| 2 | Line state is `ended` | silence: `call-ended` |
| 3 | A relay nonce (`RELAY_UTTERANCE:<id>`) is present | that exact text, verbatim — or silence (`stale-nonce`) if already taken/expired |
| 4 | Line state is `hold` | silence: `on-hold` |
| 5 | Autonomy is `relay` | silence: `relay-mode` |
| 6 | Typed text is queued and about to be spoken | silence: `user-typing-queued` |
| 7 | The last turn was a tool result for `press_keys`, `set_line_state`, or `note_commitment` | silence: `post-tool` — the key press / state change / note *is* the reply |
| 8 | More than 4 tool calls since the other party last spoke | silence: `tool-loop` |
| 9 | No conversation history at all | silence: `empty-history` |
| — | Otherwise | proxy: stream the LLM's reply through the fact gate |

When the decision is **proxy**, `runProxy()` streams the configured LLM (`systemPrompt(view)` + the six `RELAY_TOOLS`) sentence by sentence; each sentence is checked by `checkSentence()` (the fact gate) before being written to the SSE response, and a `press_keys` tool call is held until complete so its digits can be checked the same way. A blocked sentence stops generation, speaks a short filler ("One moment, let me check with &lt;name&gt;."), and raises a `gate.blocked` event with an ask card. The route never returns an HTTP error status to AssemblyAI — every failure mode (bad auth aside) degrades to a clean empty completion, because a POST timeout or a 500 leaves the Voice Agent hanging on live audio.

## Audio path

Everything is **G.711 μ‑law, 8 kHz, mono** end to end — the leg, both AssemblyAI sessions, and the simulated-business rep all speak the same format, so no resampling happens on the server's hot path (`apps/server/src/audio/mulaw.ts`).

- **Inbound:** a `FrameAggregator` (`apps/server/src/audio/pacer.ts`) buffers whatever frame sizes a leg delivers and emits exactly `CHUNK_BYTES` (800 bytes = 100 ms of 8 kHz mono μ‑law) at a time to each downstream sink (Voice Agent, captions, line-state audio-level detector).
- **Outbound:** a `RealtimePacer` emits one 800-byte chunk every 100 ms, at real-time pace, so agent speech is never sent faster than it can be heard. `Outbound` (`apps/server/src/call/outbound.ts`) wraps the one pacer per call and keeps a mirror of queued segments (`speech`, `pad`, `dtmf`), each tagged with the reply that produced it — so an interrupted reply's unplayed speech can be dropped from the queue without losing DTMF tones queued around it, and a reply is always padded to a full chunk boundary with μ‑law silence before anything else plays, so the last syllable of a sentence is never held hostage waiting for the next one.
- **DTMF** is synthesized in-band (`apps/server/src/audio/dtmf.ts`, standard dual-tone frequencies per ITU-T) and goes down the same outbound path as speech — never out-of-band signaling.
- **Hold music** (`apps/server/src/audio/holdMusic.ts`) is a generated μ‑law loop used by the practice line and scenario hold nodes so `LineStateTracker`'s music detector (sustained energy above −35 dBFS for 4 s, tolerating gaps up to 600 ms) has something real to classify.

## Legs

`PhoneLeg` (`apps/server/src/legs/phoneLeg.ts`) is the one interface every "other side of the call" implements: `start()`, `onAudio`/`sendAudio` (μ‑law both ways), `sendDtmf`, `onEnded`, `hangup`.

- **`BrowserLeg`** — a practice-line code/QR a person answers on their own phone/browser; audio flows over a WebSocket (`apps/server/src/api/lineSocket.ts`) to an AudioWorklet-based encoder/decoder in the browser.
- **`ScenarioLeg`** — a simulated business: `ScenarioEngine` (`apps/server/src/scenarios/engine.ts`) walks a small graph of `ivr` / `hold` / `rep` / `voicemail` nodes (`apps/server/src/scenarios/types.ts`), where `rep` nodes are themselves a second, independent Voice Agent session (inline session config: persona, checklist, greeting, its own tools and keyterms) — so a demo call has two Voice Agent sessions talking to each other with Carryover relaying between them.
- **PSTN** — `PhoneLeg` is the interface a real phone leg (e.g. Twilio) would implement; `resolveTarget()` in `apps/server/src/api/routes.ts` returns a 400 for a `pstn` target today. Not built in this codebase.

## MCP server

`apps/server/src/api/mcp.ts` mounts a stateless Streamable HTTP MCP server at `/mcp`: a fresh `McpServer`/transport pair per request, so tool calls carry their own `callId`/`appToken` instead of relying on a session. Seven tools: `list_scenarios`, `create_practice_line`, `place_call` (reuses the same `startCall()` as the REST API, so it gets identical rate-limit and validation guards), `get_call`, `answer_ask`, `say`, `hang_up`.
