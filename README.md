# Carryover

**An AI phone relay that lets Deaf, hard-of-hearing and speech-disabled people make ordinary phone calls.**

The phone is the last inaccessible everyday interface. Web forms have alt text; phone menus don't. Carryover answers, presses the keys, waits on hold, and speaks — while the person it's calling for reads a live transcript and types (or just watches). It discloses on every call that it's an automated relay.

A few numbers on why this matters:

- The US pays for phone relay through the Telecommunications Relay Services Fund: **$1.861B gross / $1.563B net** for FY2026‑27 ([FCC order DA‑26‑646](https://docs.fcc.gov/public/attachments/DA-26-646A1.pdf)).
- In MITRE's tests for the FCC, human relay captions lagged **4.8–6.8 s** behind the audio, against **1.1–1.4 s** for automatic speech recognition ([FCC DA‑20‑485](https://docs.fcc.gov/public/attachments/DA-20-485A1.pdf)).
- Federal relay rules have required operators to warn Deaf and hard-of-hearing callers about phone menus since 2000, because menus move "too fast to allow the TRS user to respond" ([47 CFR § 64.604(a)(3)(vii)](https://www.ecfr.gov/current/title-47/chapter-I/subchapter-B/part-64/subpart-F/section-64.604)). Nobody automates the menu itself — Carryover does.

## Try it

Live app: **https://carryover-r8ak.onrender.com** (free-tier hosting — the first request after a while may cold-start; give it a few seconds).

- [Watch a sample call](https://carryover-r8ak.onrender.com/app/sample) — a scripted, labelled replay of a prescription-refill call, no live audio required.
- [Start a call with a simulated business](https://carryover-r8ak.onrender.com/app/new) — pick a scenario (pharmacy, dental office, bank, clinic voicemail, utility company) and an autonomy mode.
- [Practice line](https://carryover-r8ak.onrender.com/app/new?to=practice) — your phone becomes the pharmacy: open the generated QR/code on a second device and answer as the person Carryover calls.

Video: coming soon

## What it does

**Autonomy modes** — chosen per call, changeable mid-call:

| Mode | Behavior |
|---|---|
| `relay` | The agent never speaks for you. Everything you type is spoken verbatim; it says nothing on its own. |
| `assist` | The agent handles greetings, small talk and simple confirmations, but calls `ask_user` for every decision — a menu route, a time, an amount. |
| `auto` | The agent may act toward a stated goal within its stated constraints (e.g. "refill my lisinopril prescription"), but it will never agree to anything outside that goal — a different price, product, date or new commitment always goes back to you. |

**Behaviors, on every call:**

- **Disclosure.** The first thing a human hears is: *"Hi, this is Carryover, an automated relay calling for &lt;name&gt;, who is &lt;Deaf / hard of hearing / unable to speak on the phone / using text&gt; and reading along. Please speak normally — I'll pass on everything you say."*
- **Type → speaks verbatim.** Text you type is queued and spoken exactly as written, as soon as the line is clear to speak — it is never rewritten by the model.
- **Phone menus, automatically.** The agent presses keypad options with in-band DTMF tones sent down the same audio path as speech (no out-of-band signaling needed).
- **Hold detection + pickup flash.** A level/timing detector on the inbound audio recognizes hold music and silence; when a person picks up, the app screen flashes and the phone vibrates so you don't have to be staring at it.
- **Ask-the-human cards.** When the agent needs something only you can decide, or a fact it doesn't have, it stops and raises a card: share a saved fact, type an answer, or decline — the call waits.
- **Code-enforced fabrication gate.** Every sentence the model wants to say on your behalf is checked by ordinary code (not a prompt) before it reaches the phone line. See [Safety design](#safety-design).
- **Live captions.** Both sides of the call are transcribed in real time, each word carrying its own confidence score, with automatic new-speaker detection so a transfer to someone else is visible immediately.
- **Post-call summary + calendar file.** When the call ends you get a plain-language outcome, bullet points, and any commitments the other side made — each downloadable as a `.ics` calendar file.
- **Local-first vault.** Your name and facts (date of birth, address, member IDs, …) are stored in the browser (IndexedDB, with a localStorage/memory fallback chain), not on the server. You choose which facts to share per call.

## How it uses AssemblyAI

Carryover is built around two AssemblyAI real-time products running in parallel over the same audio, plus AssemblyAI's LLM Gateway as an optional model provider.

**Voice Agent API — the relay's ears and mouth.**

- A single **stored agent** is registered once per (voice, Brain configuration) pair and reused across calls (`AgentRegistry.ensureRelayAgent`, `apps/server/src/aai/agentRegistry.ts`).
- Audio is **PCMU (G.711 μ-law) at 8 kHz** in both directions — the same format a real phone line uses, so nothing needs transcoding at the edge.
- The agent's LLM is **bring-your-own**: its `llm.base_url` points at Carryover's own endpoint, `POST /brain/v1/chat/completions` — a streaming Chat Completions-style HTTP route Carryover implements itself (`apps/server/src/brain/brainRoute.ts`). This is deliberate: it's the only way to (a) have the agent speak a user's typed text *verbatim*, (b) make it stay silent on cue (on hold, in relay mode, after a tool call with nothing to say), and (c) run every generated sentence through a code-level fact-checking gate before it can reach the phone line — none of which a hosted LLM behind a fixed system prompt can do.
- **Tool calling**: the agent is given six tools (`press_keys`, `ask_user`, `share_fact`, `note_commitment`, `set_line_state`, `end_call` — see [`apps/server/src/brain/policy.ts`](apps/server/src/brain/policy.ts)) that it calls mid-stream; DTMF presses are themselves gated against the fact ledger.
- **`reply.create`** is how typed text gets spoken: each utterance gets a one-shot nonce, the session sends `reply.create` with `RELAY_UTTERANCE:<nonce>`, and the Brain answers that one request with the exact text — verbatim, no LLM involved.

**Universal-3.5 Pro real-time streaming — parallel, independent captions.**

The *same* inbound μ-law audio is also streamed to a Universal-3.5 Pro session purely for captioning — a second, independent transcript the app displays, separate from whatever the Voice Agent itself hears (`apps/server/src/aai/captions.ts`):

| Parameter | Value | Why |
|---|---|---|
| `speech_model` | `universal-3-5-pro` | highest-accuracy streaming model |
| `speaker_labels` | `true`, `max_speakers=4` | detects when a call is transferred to someone new |
| per-word `confidence` | on every `CaptionWord` | the UI underlines low-confidence words instead of hiding uncertainty |
| `keyterms_prompt` | the user's name, short shared facts, and goal words | primes recognition for names and numbers specific to this call |
| `agent_context` (Context Carryover) | the relay's own last utterance, pushed after every turn via `UpdateConfiguration` | keeps the captioning model aware of what was just said, so it doesn't have to guess at names/numbers cold |
| `voice_focus` | `near-field` | biases toward the near-end mic/line, away from background noise |
| `continuous_partials` | `true` | partial captions keep streaming in real time instead of waiting for silence |

**A second Voice Agent session plays the simulated businesses.** Each demo scenario (pharmacy, dental office, bank, clinic, utility) runs its own inline Voice Agent session as the "rep" — a persona, a checklist, and its own keyterms and tools (`apps/server/src/scenarios/engine.ts`). The scripted IVR menu prompts and hold announcements those scenarios play are pre-rendered, once, as static audio using AssemblyAI voices (`apps/server/scripts/gen-ivr-assets.ts`).

**LLM Gateway.** Setting `LLM_PROVIDER=aai-gateway` in the server's environment points the Relay Brain's own model calls at AssemblyAI's LLM Gateway (`https://llm-gateway.assemblyai.com/v1`) instead of the default provider — a one-variable swap, no code change (`apps/server/src/llm/provider.ts`).

## Architecture

![Architecture diagram](docs/architecture.svg)

A short walk-through — see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full module-by-module description and the Brain's decision table.

- **Legs** (`apps/server/src/legs/`) are the "other side" of the call: `BrowserLeg` for a practice-line page, `ScenarioLeg` for a simulated business, and a `PhoneLeg` interface that a real PSTN leg (Twilio) would implement — designed but not built in this codebase.
- **`CallSession`** (`apps/server/src/call/callSession.ts`) is the orchestrator: one per call, it owns the leg, the two AssemblyAI sessions (Voice Agent + captions), and the app's event stream. Inside it:
  - **`PoliteQueue`** (`politeQueue.ts`) holds typed text until the line is actually free to speak, so the relay never talks over the other party or over its own in-flight reply.
  - **`LineStateTracker`** (`lineState.ts`) classifies what's on the line right now — menu, hold, a person, voicemail — from caption text and audio level, and can be overridden by the model's own `set_line_state` tool call.
- **Relay Brain** (`apps/server/src/brain/`) is the BYO-LLM endpoint: `requestParse.ts` reads AAI's request shape, `policy.ts` decides *whether* to proxy the LLM, stay silent, or answer verbatim, and `factGate.ts` is the fabrication gate every generated sentence passes through before it's streamed back.
- **MCP server** (`apps/server/src/api/mcp.ts`) exposes the same call-placing and call-control surface as the REST API as seven MCP tools, so another agent or automation can place and steer a Carryover call.
- **Web app** (`apps/web/`) is a React SPA: a landing page, a start-call flow, the live call screen (captions, ask cards, pickup takeover), a scripted sample player, a practice-line page that runs its own μ-law encode/decode in an AudioWorklet, history and a profile/vault page.

## Safety design

**The fabrication gate is code, not a prompt.** Every sentence the model wants to say on the user's behalf is parsed for dates, digit runs (3+ digits) and email addresses; each one must already be present in that call's *ledger* — the user's consented facts, anything the user typed, and everything the other party has said (`apps/server/src/brain/factGate.ts`). A sentence with an unverifiable fact is blocked before it reaches the phone line — a filler is spoken instead ("One moment, let me check with &lt;name&gt;.") and an ask card is raised. This is enforced independently of the system prompt: a model that ignores its instructions still can't get an invented number or date past the gate. DTMF is gated the same way — keying in an invented ID over the keypad is treated as the same fabrication as saying it.

**Negative control.** The evaluation scenarios include a fact that is deliberately never shared with the agent (a bank member ID, held only in the test's private answer key). A passing run means the agent never states that value — proof the gate blocks invention rather than merely matching a lucky coincidence.

**Honest limits**, documented in the gate's own source comment and worth restating here:

- **Echo-confirmation is prompt-only.** The gate stops the model from *inventing* a fact, not from wrongly *confirming* one the other party reads out ("Is her date of birth June 1st, 1986?"). That's guarded by the system prompt's explicit rule to call `ask_user` instead of confirming an unmatched value — a prompt, not code, so it can in principle be circumvented by an adversarial model.
- **Alphanumeric IDs are only gated on their digits** — `MX-4471` blocks on `4471`, but the letters aren't checked at all.
- Numbers under 3 digits (ages, "press 2", "20 mg") are not treated as facts.
- A number split across sentences into two-digit fragments is only caught when both fragments land in the same gated sentence.
- Digit groups separated by ordinary words ("45 or 12 or 99") are read as separate numbers, not one identifier.
- Names, street names and other non-numeric words are not gated at all.
- Clock times, ordinals, percentages, prices under $100, "24/7" and toll-free numbers are deliberately treated as ordinary speech, not facts — with exceptions when the sentence talks about an ID, "ends in", "last four", or (for years) a birth date.

**Disclosure happens on every call**, before anything else is said to a human. **Emergency calls are out of scope** — the system prompt instructs the model to never give or discuss emergency information and to hand any mention of an emergency straight to the user.

## Evaluation

Each scenario ships with a hidden answer key (goal, expected facts, a scripted "user" bot that answers ask cards, and — for the negative-control scenario — a private fact that must never be spoken). A harness runs the call against the real AssemblyAI APIs end to end and scores it on: IVR success, pickup-to-alert latency, verbatim relay accuracy (exact match and word-error rate against what was actually heard), caption word-error rate, fabrication count (an independent second pass of the fact gate over only the agent's own autonomous speech, not the production ledger — so the count isn't vacuously zero), negative-control pass/fail, ask precision/recall, and whether a transfer was detected. A "false-twin" test seeds a known invented fact into a synthetic transcript and confirms the metric actually counts it, so a `fabrications: 0` result means something.

Scorecard: see `eval/SCORECARD.md` (full run pending).

## Run it locally

**Prerequisites:** Node.js 24+, pnpm 9, an [AssemblyAI](https://www.assemblyai.com/) API key, an LLM provider key (Venice by default, or use the AssemblyAI LLM Gateway), and a way to give your local server a public HTTPS URL — [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) (`cloudflared tunnel --url http://localhost:8787`) is the simplest option, since AssemblyAI's Voice Agent must be able to reach your machine's `/brain/v1/chat/completions` endpoint over the internet.

**Environment** (`apps/server/src/config.ts`; see [`.env.example`](.env.example)):

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `ASSEMBLYAI_API_KEY` | yes | — | AssemblyAI API key (Voice Agent + streaming) |
| `PUBLIC_BASE_URL` | yes | — | Publicly reachable URL for this server (e.g. your cloudflared tunnel), used for the Brain endpoint and app links |
| `BRAIN_SECRET` | yes | — | Bearer secret the stored agent uses to call `/brain/v1/chat/completions` |
| `LLM_PROVIDER` | no | `venice` | `venice` or `aai-gateway` |
| `LLM_MODEL` | no | `gemini-3-8-flash` (venice) / provider default (aai-gateway) | model id for the chosen provider — see `apps/server/src/config.ts` for exact defaults |
| `VENICE_API_KEY` | only if `LLM_PROVIDER=venice` | — | Venice API key |
| `PORT` | no | `8787` | HTTP port |
| `TRUST_PROXY` | no | `loopback,linklocal,uniquelocal` outside tests | comma-separated Fastify trust-proxy presets/CIDRs, for correct per-visitor rate limiting behind a reverse proxy |

**Commands** (from the repo root):

```bash
pnpm install

# server, with your tunnel URL as PUBLIC_BASE_URL
pnpm dev

# web app (separate terminal; proxies /api, /brain, /ws to :8787)
pnpm --filter @carryover/web dev

# all tests (protocol + server + web)
pnpm test

# typecheck / lint
pnpm typecheck
pnpm lint
```

Once both are running, open `http://localhost:5173` for the web app, or drive the server directly with `pnpm --filter @carryover/server exec tsx scripts/watch-call.ts` (see the script for options).

**Running the evaluation harness:** the harness (hidden per-scenario answer keys, a scripted user bot, and the metrics described in [Evaluation](#evaluation)) lives in a separate `eval` workspace package built alongside this server. It is not part of this branch's `pnpm test` run yet — see [Honest limits](#honest-limits--not-in-scope).

## Tests

Run with `pnpm test` (`pnpm -r test`, i.e. every workspace package), against this commit:

| Package | Test files | Tests |
|---|---|---|
| `@carryover/protocol` | 1 | 3 |
| `@carryover/server` | 27 | 420 |
| `@carryover/web` | 26 | 301 |
| **Total** | **54** | **724** |

All green. `pnpm typecheck` and `pnpm lint` (Biome, 263 files) are both clean.

## Honest limits / not in scope

- **Not FCC-certified.** Carryover is not a certified Telecommunications Relay Service and does not draw on the TRS Fund.
- **PSTN calling is designed but not shipped in this build.** `PhoneLeg` is the interface a real phone leg (Twilio) would implement; only the browser practice line and simulated-business legs are wired up. `POST /api/calls` returns a 400 for a `pstn` target today, and `GET /api/health` reports `features.pstn: false`.
- **The simulated businesses are simulated.** Every scenario call is clearly labelled `"<business> (simulated)"` in the UI and API — it is a scripted AI persona for demo and evaluation purposes, not a real pharmacy, bank or clinic.
- **Free-tier hosting may cold-start.** The live deployment runs on a free Render instance; the first request after idling can take a few seconds.
- **The sample call is scripted and labelled.** `/app/sample` replays a fixed, pre-written script (including a compressed hold time) with an on-screen "Sample call · scripted" banner — it does not place a live call.
- **The evaluation harness and latency-hardening work described in this README are on a separate branch, not yet merged into the one this build ships from.** The `eval` measurements and the sub-3-second brain-latency figures in [`CLAIMS.md`](CLAIMS.md) are real, measured results, clearly marked there — but the live deployment above runs the pre-hardening turn-taking logic and does not resume a Voice Agent session after a dropped socket.

## License

[MIT](LICENSE)
