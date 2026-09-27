import type { ChatMessage } from '../llm/provider.js';

// Parses the chat-completions body AAI's Voice Agent POSTs to the Brain.
// Observed shape (see test/fixtures/byo-*.json): messages[0] is the stored system prompt
// (ours, carrying the call tag) plus ~1.1k chars AAI appends; the other party's final
// transcript is role "user"; reply.create instructions arrive as a trailing "system"
// message for that one request only; after a tool result AAI appends a "system" notice.

export interface ParsedBrainRequest {
  callTag?: { kind: 'call'; callId: string };
  relayNonce?: string;
  lastRole: 'user' | 'assistant' | 'tool' | 'system' | 'none';
  lastToolName?: string;
  history: ChatMessage[] /* without AAI system prompt */;
  lastUserText?: string;
}

export const CALL_TAG_RE: RegExp = /\[\[carryover-call:([a-z0-9-]{8,40})\]\]/;
export const RELAY_NONCE_RE: RegExp = /RELAY_UTTERANCE:([a-z0-9]{8,32})/;

// System messages AAI injects on its own. They carry no new turn, so they are skipped
// when deciding what the conversation's last turn was (but kept in the history).
const POST_TOOL_NOTICE_RE = /^The function call ([A-Za-z0-9_-]+)\(/;
const AAI_NOTICE_RES: RegExp[] = [POST_TOOL_NOTICE_RE, /^Do what is outstanding\.?\s*$/];

const ROLES = new Set(['system', 'user', 'assistant', 'tool']);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function contentText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = content
      .map((p) => (isRecord(p) && typeof p.text === 'string' ? p.text : ''))
      .filter((s) => s !== '');
    return parts.length > 0 ? parts.join('') : null;
  }
  return null;
}

function normalizeMessage(raw: unknown): ChatMessage | undefined {
  if (!isRecord(raw) || typeof raw.role !== 'string' || !ROLES.has(raw.role)) return undefined;
  const msg: ChatMessage = {
    role: raw.role as ChatMessage['role'],
    content: contentText(raw.content),
  };
  if (Array.isArray(raw.tool_calls) && raw.tool_calls.length > 0) msg.tool_calls = raw.tool_calls;
  if (typeof raw.tool_call_id === 'string') msg.tool_call_id = raw.tool_call_id;
  if (typeof raw.name === 'string') msg.name = raw.name;
  return msg;
}

function isAaiNotice(m: ChatMessage): boolean {
  return m.role === 'system' && AAI_NOTICE_RES.some((re) => re.test(m.content ?? ''));
}

function toolNameFor(
  messages: ChatMessage[],
  toolIdx: number,
  notices: ChatMessage[],
): string | undefined {
  const tool = messages[toolIdx];
  if (!tool) return undefined;
  if (tool.name) return tool.name;
  if (tool.tool_call_id) {
    for (let i = toolIdx - 1; i >= 0; i--) {
      for (const tc of messages[i]?.tool_calls ?? []) {
        if (isRecord(tc) && tc.id === tool.tool_call_id && isRecord(tc.function)) {
          const name = tc.function.name;
          if (typeof name === 'string') return name;
        }
      }
    }
  }
  for (const n of notices) {
    const m = POST_TOOL_NOTICE_RE.exec(n.content ?? '');
    if (m?.[1]) return m[1];
  }
  return undefined;
}

export function parseBrainRequest(body: unknown): ParsedBrainRequest {
  const rawMessages = isRecord(body) && Array.isArray(body.messages) ? body.messages : [];
  const messages = rawMessages
    .map(normalizeMessage)
    .filter((m): m is ChatMessage => m !== undefined);
  if (messages.length === 0) return { lastRole: 'none', history: [] };

  // The call tag is only trusted in messages[0] (our stored system prompt). Anything the
  // other party says lands in later messages and must never be able to re-route a call.
  let callTag: ParsedBrainRequest['callTag'];
  let history = messages;
  const first = messages[0];
  if (first?.role === 'system') {
    const m = CALL_TAG_RE.exec(first.content ?? '');
    if (m?.[1]) callTag = { kind: 'call', callId: m[1] };
    history = messages.slice(1);
  }

  // The relay nonce is only read from the trailing run of system messages: reply.create
  // instructions exist for exactly one request and are never replayed later.
  let relayNonce: string | undefined;
  let end = history.length;
  while (end > 0 && history[end - 1]?.role === 'system') {
    const m = RELAY_NONCE_RE.exec(history[end - 1]?.content ?? '');
    if (m?.[1] && relayNonce === undefined) relayNonce = m[1];
    end--;
  }

  // Last turn: skip trailing AAI notices ("The function call X(...) has just completed",
  // "Do what is outstanding.") so a tool result or a barge-in reads as what it is.
  let lastIdx = history.length - 1;
  const notices: ChatMessage[] = [];
  while (lastIdx >= 0) {
    const m = history[lastIdx];
    if (!m || !isAaiNotice(m)) break;
    notices.push(m);
    lastIdx--;
  }
  const last = history[lastIdx];
  const lastRole: ParsedBrainRequest['lastRole'] = last ? last.role : 'none';
  const lastToolName = lastRole === 'tool' ? toolNameFor(history, lastIdx, notices) : undefined;

  let lastUserText: string | undefined;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m?.role === 'user' && typeof m.content === 'string') {
      lastUserText = m.content;
      break;
    }
  }

  const out: ParsedBrainRequest = { lastRole, history };
  if (callTag) out.callTag = callTag;
  if (relayNonce) out.relayNonce = relayNonce;
  if (lastToolName) out.lastToolName = lastToolName;
  if (lastUserText !== undefined) out.lastUserText = lastUserText;
  return out;
}
