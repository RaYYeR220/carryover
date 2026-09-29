# Review in 5 minutes

Fast path for judges. Live app: **https://carryover-r8ak.onrender.com** (free-tier hosting — first load may cold-start a few seconds).

## 1. Watch the sample call (30 s, no setup)

Open **[/app/sample](https://carryover-r8ak.onrender.com/app/sample)** — it autoplays.

Look for:
- The "Sample call · scripted" banner — this replay is labelled, not a live call.
- The disclosure line at the start ("Hi, this is Carryover, an automated relay calling for Maya…").
- The **pickup flash**: when the script reaches "a person picked up," the whole screen flashes and a banner takes over — this is the same choreography a real pickup triggers.
- A caption word rendered with a dotted underline — a low-confidence word from Universal-3.5 Pro's per-word confidence score.
- The **ask card** when the pharmacist asks for a date of birth — Share / Type / Decline change how the rest of the script plays out.
- The summary sheet at the end: outcome, bullets, one commitment, and an "Add to calendar" (.ics) button.

## 2. Start a real call against a simulated business (2 min)

Open **[/app/new](https://carryover-r8ak.onrender.com/app/new)**, pick a scenario (e.g. "Prescription refill" — Riverside Pharmacy), leave autonomy on **Assist**, and press Call.

Look for:
- Live captions streaming in from the simulated IVR menu, then DTMF being pressed automatically to reach a person (watch the `dtmf` event / the pressed digit in the transcript).
- Hold detection, then the **pickup flash + phone buzz** the moment a person answers.
- The disclosure spoken to that "person" — queued the moment a person is detected, with the language model kept silent while it's pending.
- An **ask card** the moment the rep asks for something only you can answer (a name, a date of birth) — try Share (if you added a matching fact), Type, or Decline.
- Type something in the composer and watch it get queued (`relay.queued`) until the line is free, then spoken exactly as typed.
- The business name in the header reads `"<business> (simulated)"` — it's always labelled.

To see an ask card fire for a withheld fact: pick a scenario, don't share the requested fact, and wait for the ask card that asks you for it — try Share, Type, or Decline and watch the call proceed accordingly. To see the fabrication gate itself block an invented value, that's a code-level check, not something a demo call can trigger on cue — see it directly: `pnpm --filter @carryover/server exec vitest run test/brain/factGate.test.ts`.

## 3. Practice line with a second device (2 min)

Open **[/app/new?to=practice](https://carryover-r8ak.onrender.com/app/new?to=practice)** on your laptop and select the practice line as the destination — this is "your phone becomes the pharmacy." Scan the generated QR code with a phone (or open the shown URL, `/line/<code>`, on a second device/tab) and press **Answer**. Say something on the practice-line device; watch it show up as a live caption on the call screen, and type something on the call screen to hear it spoken back on the practice-line device.

## 4. Health and machine surfaces (30 s)

- **[/api/health](https://carryover-r8ak.onrender.com/api/health)** — `{ ok, calls, provider, model, version, features: { pstn, llmGateway } }`.
- **[/api/scenarios](https://carryover-r8ak.onrender.com/api/scenarios)** — the 5 simulated businesses.
- **/mcp** — a Streamable HTTP MCP server (`apps/server/src/api/mcp.ts`) exposing `list_scenarios`, `create_practice_line`, `place_call`, `get_call`, `answer_ask`, `say`, `hang_up`. Point any MCP client at `https://carryover-r8ak.onrender.com/mcp`.

## 5. Where the key code lives

| What | File |
|---|---|
| The fabrication gate (code, not a prompt) | `apps/server/src/brain/factGate.ts` |
| What gets said / stays silent / gets proxied through the gate | `apps/server/src/brain/policy.ts` (`decide()`), `apps/server/src/brain/brainRoute.ts` |
| The system prompt (autonomy rules, honest-disclosure-if-asked rule, FACT SHEET) — the proactive disclosure itself is queued by code, not the prompt | `apps/server/src/brain/policy.ts` (`systemPrompt()`); disclosure itself is `apps/server/src/call/callSession.ts` (`disclosureText()`) |
| Call orchestration (one per call) | `apps/server/src/call/callSession.ts` |
| Polite turn-taking for typed text | `apps/server/src/call/politeQueue.ts` |
| What's on the line right now (menu/hold/human/voicemail) | `apps/server/src/call/lineState.ts` |
| AssemblyAI Voice Agent client, incl. session resume after a dropped socket | `apps/server/src/aai/voiceAgent.ts`, `apps/server/src/aai/agentRegistry.ts` |
| AssemblyAI Universal-3.5 Pro captions client | `apps/server/src/aai/captions.ts` |
| The simulated-business engine (a second Voice Agent as the "rep") | `apps/server/src/scenarios/engine.ts` |
| REST + WebSocket + MCP | `apps/server/src/api/{routes,appSocket,lineSocket,mcp}.ts` |
| The pickup flash / ask card / call screen | `apps/web/src/call/{PickupTakeover,AskCard,CallScreen}.tsx` |
| The scripted sample player (autoplay, ask-choice branching) | `apps/web/src/sample/SamplePlayer.tsx`, `apps/web/src/sample/pharmacyScript.ts` |
| The evaluation harness (hidden answer keys, metrics, scorecard) | `eval/runner.ts`, `eval/metrics.ts`, `eval/SCORECARD.md` |

## 6. Run the tests

```bash
pnpm install
pnpm test        # protocol 4 + server 484 + web 326 + eval 42 = 856 tests, all green
pnpm typecheck
pnpm lint
```

To see the gate in isolation: `pnpm --filter @carryover/server exec vitest run test/brain/factGate.test.ts`. To see the evaluation scorecard: `eval/SCORECARD.md`.
