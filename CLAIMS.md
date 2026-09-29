# Claims and evidence

An evidence ledger for the claims in this repository's docs. Every claim is tagged:

- **REPRODUCIBLE** — a command in this repo proves it; run it yourself.
- **VERIFIED-LIVE** — observed in a real, live run against the actual AssemblyAI APIs (and, where noted, a real LLM). Cited with the measured numbers.
- **MODELED** — a calculation from published pricing or third-party figures, not a measurement of this system.
- **NOT-CLAIMED** — explicitly not asserted; see the list at the end.

Two of the entries below (marked inline) were measured on a latency-hardening pass and on the evaluation harness, both built as part of this project but **not yet merged into the `dev` branch this repository is built from**. They're included because they're real, measured results worth being honest about — not because the exact numbers are guaranteed to reproduce on `dev` today. Everything else describes what's actually in this branch.

## Correctness and safety

| Claim | Tag | Evidence |
|---|---|---|
| The fact gate (`apps/server/src/brain/factGate.ts`) blocks a generated sentence containing a date, digit run (3+ digits) or email address that isn't in the call's ledger, and allows one that is. | REPRODUCIBLE | `pnpm --filter @carryover/server exec vitest run test/brain/factGate.test.ts` — direct block/allow assertions, including adversarial forms (spoken digits, spelled-out dates, Unicode digits, zero-width separators). |
| The gate is enforced in code at the point sentences are streamed back to the phone line, not only in the system prompt. | REPRODUCIBLE | `apps/server/src/brain/brainRoute.ts`'s `release()` calls `checkSentence()` on every sentence boundary before writing it to the SSE response; `apps/server/src/brain/policy.ts`'s system prompt is a *second*, independent layer (rules 2–4), not the only one. Read both files. |
| A `press_keys` DTMF tool call is checked the same way: 4+ digits must be in the ledger before the tones are sent. | REPRODUCIBLE | `pnpm --filter @carryover/server exec vitest run test/brain/brainRoute.test.ts` — covers a blocked keyed sequence and an allowed short menu choice (≤3 digits). |
| Every AssemblyAI/leg/LLM session `CallSession` opens is closed on every exit path (normal end, leg drop, start failure, malformed event). | REPRODUCIBLE | `pnpm --filter @carryover/server exec vitest run test/call/callSession.test.ts` — asserts `va.end`/`captions.close`/`leg.hangup` are called synchronously in `end()`, including on abnormal exits, with no leaked timers (`vi.getTimerCount() === 0`). |
| Disclosure ("Hi, this is Carryover, an automated relay…") is queued on every call, before or immediately on reaching a human. | REPRODUCIBLE | `disclosureText()` in `apps/server/src/call/callSession.ts`, called unconditionally on the first transition to `human` (or after a fixed delay on a direct line leg); see `apps/server/test/call/callSession.test.ts`'s scripted pharmacy-call scenario. |
| A stored Voice Agent talks to a self-hosted BYO-LLM endpoint (`/brain/v1/chat/completions`) rather than a hosted model directly. | REPRODUCIBLE | `apps/server/src/aai/agentRegistry.ts`'s `ensureRelayAgent()` sets `llm: [{ base_url: "<PUBLIC_BASE_URL>/brain/v1", ... }]`; `apps/server/src/brain/brainRoute.ts` implements that endpoint. |
| Voice Agent audio and captions audio both run PCMU (G.711 μ-law) at 8 kHz. | REPRODUCIBLE | `agentRegistry.ts`'s `PCMU_FORMAT`; `captions.ts`'s `buildUrl()` sets `encoding=pcm_mulaw&sample_rate=8000`. |
| Live AssemblyAI wire shapes (session handshakes, agent list pagination, close codes, tool-result timing) were verified against the real API, not just cached docs, and two real bugs found that way were fixed (WS close code 1005→1000; `GET /v1/agents` response is `{agents,has_more,...}`, not a bare array). | VERIFIED-LIVE | Live smoke run against the real AssemblyAI API; see the development record for the exact request/response evidence. |
| A live call against a simulated pharmacy IVR: menu heard → DTMF `2` pressed (~4 s after the prompt finished) → hold detected → human pickup alert at ~42 s → disclosure spoken → name and date of birth answered correctly from consented facts. | VERIFIED-LIVE | Live run over a public tunnel, `autonomy=assist` with a stated goal, real AssemblyAI Voice Agent + Universal-3.5 Pro + LLM. |
| Brain time-to-first-spoken-text after a hardening pass on turn-taking and model selection: 0.75–1.46 s (request → first real text byte); the other party's last word → our answer audio: 2.1–2.7 s. | VERIFIED-LIVE *(hardening branch, not yet merged into `dev`)* | Measured with `LOG_LEVEL=debug` timestamps across three live calls (two demo scenarios), before/after comparison against an un-hardened baseline of 5.2–7.0 s (one turn never answered at all). |
| A scripted smoke evaluation run against a live pharmacy call: IVR success, pickup-alert latency 5.4 s, 1/1 verbatim utterances exact, caption word-error rate 0.014, 0 fabrications (checked by an independent second pass of the fact gate over the agent's autonomous speech only). | VERIFIED-LIVE *(evaluation harness, a separate `eval` workspace package, not yet merged into `dev`)* | One real end-to-end run (tunnel → real AssemblyAI APIs → Brain → app socket → harness → scoring), recorded in the harness's own results file. |
| A "false-twin" check proves the fabrication counter isn't vacuously zero: seeding a synthetic transcript with an invented date the agent said on its own is correctly counted as a fabrication. | REPRODUCIBLE *(within the `eval` package, not yet merged into `dev`)* | Unit test in the harness's metrics suite. |

## Product behavior

| Claim | Tag | Evidence |
|---|---|---|
| Autonomy has exactly three modes (`relay`, `assist`, `auto`) with the constraints described in the README. | REPRODUCIBLE | `packages/protocol/src/index.ts`'s `Autonomy` enum; `apps/server/src/brain/policy.ts`'s `autonomyRule()` and the `decide()` table (`relay` → forced silence unless a typed-text nonce is present). |
| Typed text is spoken verbatim, never rewritten by the model. | REPRODUCIBLE | `policy.ts`'s `decide()`: a request carrying a relay nonce returns `{ kind: 'verbatim', text }` before the LLM is ever invoked. |
| Live captions carry per-word confidence and speaker-change detection. | REPRODUCIBLE | `CaptionWord.confidence` (`packages/protocol/src/index.ts`); `speaker_labels=true&max_speakers=4` in `captions.ts`; `apps/server/src/call/speakers.ts`'s `SpeakerMap`. |
| A post-call summary includes an outcome, bullet points, and any commitments, each exportable as an `.ics` calendar file. | REPRODUCIBLE | `apps/server/src/call/summary.ts`; `apps/web/src/lib/ics.ts`'s `commitmentToIcs()`; see `apps/web/test/history/HistoryDetailPage.test.tsx`. |
| Facts are stored client-side (IndexedDB, falling back to localStorage then memory) and never sent to the server except the ones explicitly toggled to share for a given call. | REPRODUCIBLE | `apps/web/src/lib/store.ts`'s `resilientKv()`; `apps/web/src/start/request.ts`'s `buildStartCallRequest()` only includes facts whose key is in `sharedKeys`. |
| The demo/eval businesses are clearly labelled as simulated in the API and UI. | REPRODUCIBLE | `ScenarioLeg`'s `label` is `` `${business} (simulated)` `` (`apps/server/src/legs/scenarioLeg.ts`). |
| `pstn` call targets are rejected; PSTN is not wired up. | REPRODUCIBLE | `resolveTarget()` in `apps/server/src/api/routes.ts` returns a 400 for `kind: 'pstn'`; `GET /api/health` reports `features.pstn: false`. |
| Test suite, at this commit: protocol 3 tests / server 420 tests / web 301 tests, 724 total, all green; `pnpm typecheck` and `pnpm lint` (Biome, 263 files) both clean. | REPRODUCIBLE | `pnpm install && pnpm test && pnpm typecheck && pnpm lint`, run by hand against this commit. |

## Unit economics (market context, not a product claim)

| Claim | Tag | Evidence |
|---|---|---|
| Captions-only relay: ≈$0.0215/min direct AssemblyAI cost against the FCC's $0.95/min ASR-only IP CTS rate (~97.7% modeled gross margin); captions + voice agent: ≈$0.0965/min against the $2.271/min IP Relay rate (~95.8% modeled gross margin). | MODELED | Calculated from published AssemblyAI Voice Agent ($0.075/min) and Universal-3.5 Pro streaming ($0.0075/min) pricing ([assemblyai.com/pricing](https://www.assemblyai.com/pricing)) against the FCC's FY2026-27 per-minute compensation rates ([FCC DA-26-646](https://docs.fcc.gov/public/attachments/DA-26-646A1.pdf)). Not a measurement of what this deployment actually costs to run; doesn't include hosting, and FCC compensation for an automated, non-certified relay is untested. |

## NOT-CLAIMED

- **Not FCC-certified**, and no claim of TRS Fund eligibility or compensation for any minute of any call.
- **No emergency-calling capability.** The system prompt explicitly declines to give or discuss emergency information and defers to the user instead.
- **No PSTN calling in this build.** `PhoneLeg` is an interface that only the browser practice line and simulated-business legs implement today.
- **No claim that the fact gate catches every fabrication.** Its own source documents specific, deliberate gaps: sub-3-digit numbers, numbers split across two sentences, alphanumeric IDs beyond their digits, names and street addresses, and digit groups separated by ordinary words. See [README § Safety design](README.md#safety-design) and the comment block at the top of `apps/server/src/brain/factGate.ts`.
- **No claim that echo-confirmation is code-gated.** Confirming a wrong fact the other party reads out loud ("Yes, that's right") is guarded by the system prompt only, not by the fact gate — the sentence itself contains no invented fact for the gate to catch.
- **No claim of a completed, full 5-scenario evaluation scorecard in this branch.** One scenario has a live smoke result (above); the harness and hidden answer keys for all 5 scenarios exist as a separate, not-yet-merged workspace package. See `eval/SCORECARD.md` (full run pending) once merged.
- **No claim that the deployed live instance reflects the latency-hardening or session-resume work.** Those changes live on a branch not merged into `dev` as of this writing; the live app runs the pre-hardening turn-taking and does not resume a dropped Voice Agent session.
- **No claim of clinical, legal, financial or medical advice** given by the agent — it relays what it's told and what it's given to say, nothing more.
- **No claim that captions or the LLM's understanding are error-free.** Caption word-error rate and LLM behavior are measured, not guaranteed (see the Evaluation section of the README).
