import type { Commitment, TranscriptEntry } from '@carryover/protocol';
import type { ChatMessage, LlmProvider } from '../llm/provider.js';

export interface SummaryContext {
  userName: string;
  targetLabel: string;
  goal?: string;
  // Commitments the agent noted during the call (note_commitment); the fallback result.
  commitments?: Commitment[];
}

export interface SummaryResult {
  outcome: string;
  bullets: string[];
  commitments: Commitment[];
}

export const SUMMARY_TIMEOUT_MS = 15_000;
const FALLBACK_OUTCOME = 'Call ended';
const MAX_TRANSCRIPT_CHARS = 12_000;
const MAX_BULLETS = 6;
const MAX_COMMITMENTS = 8;
const MAX_FIELD_CHARS = 300;

// Post-call summary from the transcript, in JSON mode. Never throws: any failure (provider
// down, bad JSON, missing fields) gives the fallback with the commitments noted live.
// CallSession also races this against SUMMARY_TIMEOUT_MS externally and moves on if it
// doesn't resolve in time, but without this AbortController the actual HTTP request would
// keep running in the background regardless -- this cancels it when `timeoutMs` fires, so
// nothing is left in flight after the caller has already given up.
export async function summarize(
  provider: LlmProvider,
  transcript: TranscriptEntry[],
  ctx: SummaryContext,
  timeoutMs = SUMMARY_TIMEOUT_MS,
): Promise<SummaryResult> {
  const noted = (ctx.commitments ?? []).map((c) => ({ ...c }));
  const fallback: SummaryResult = { outcome: FALLBACK_OUTCOME, bullets: [], commitments: noted };
  if (transcript.length === 0) return fallback;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const raw = await provider.complete(
      buildMessages(transcript, ctx),
      { json: true },
      controller.signal,
    );
    const parsed = parseSummary(raw);
    if (!parsed) return fallback;
    return {
      outcome: parsed.outcome,
      bullets: parsed.bullets,
      commitments: parsed.commitments.length > 0 ? parsed.commitments : noted,
    };
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

function buildMessages(transcript: TranscriptEntry[], ctx: SummaryContext): ChatMessage[] {
  const u = ctx.userName;
  const goal = ctx.goal?.trim() ? `\n${u}'s goal for the call: ${ctx.goal.trim()}` : '';
  const system = `You write the after-call summary for ${u}, who used Carryover, an automated phone relay, to call ${ctx.targetLabel}. In the transcript, "Them" is the other party and "Agent" is what was said for ${u}.${goal}

Use only what the transcript says. Never guess or fill in names, numbers, dates or times.
Reply with one JSON object and nothing else:
{"outcome": "one short sentence on how the call ended up", "bullets": ["up to ${MAX_BULLETS} short key points"], "commitments": [{"text": "what the other party promised or the agreed next step", "when": "date or time if one was said"}]}`;
  return [
    { role: 'system', content: system },
    { role: 'user', content: formatTranscript(transcript) },
  ];
}

function formatTranscript(transcript: TranscriptEntry[]): string {
  const lines = transcript.map((e) => {
    if (e.who === 'them') return `Them${e.person ? ` (person ${e.person})` : ''}: ${e.text}`;
    if (e.who === 'agent')
      return `Agent${e.source === 'relay' ? ' (typed by the user)' : ''}: ${e.text}`;
    return `Note: ${e.text}`;
  });
  const text = lines.join('\n');
  // Keep the end of a long call: that is where outcomes and commitments are.
  return text.length > MAX_TRANSCRIPT_CHARS ? text.slice(text.length - MAX_TRANSCRIPT_CHARS) : text;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function cleanString(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  return s ? s.slice(0, MAX_FIELD_CHARS) : undefined;
}

function parseSummary(raw: string): SummaryResult | undefined {
  const body = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!isRecord(data)) return undefined;
  const outcome = cleanString(data.outcome);
  if (!outcome) return undefined;

  const bullets = (Array.isArray(data.bullets) ? data.bullets : [])
    .map(cleanString)
    .filter((b): b is string => b !== undefined)
    .slice(0, MAX_BULLETS);

  const commitments: Commitment[] = [];
  for (const c of Array.isArray(data.commitments) ? data.commitments : []) {
    if (!isRecord(c)) continue;
    const text = cleanString(c.text);
    if (!text) continue;
    const when = cleanString(c.when);
    commitments.push(when ? { text, when } : { text });
    if (commitments.length >= MAX_COMMITMENTS) break;
  }
  return { outcome, bullets, commitments };
}
