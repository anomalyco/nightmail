import type { Env } from '../env.js';
import { MissingSecret, newId } from '../tokens.js';
import { log } from '../log.js';
import type { Harness, HarnessEvent, TurnInput, TurnResult, Usage } from './harness.js';
import { baseToolName } from './tools.js';

// Prototype, dev only: the same Harness seam as opencode.ts, with the agent loop on a Console agent instead of the
// embedded OpenCode. One Console cloud session per conversation, reached through Console's `/v1` API: a turn is one input
// (routing key = this conversation), and its events come from the session's log, followed over server-sent events. The
// agent's tools are this Worker's MCP server (mcp.ts): Console's gateway names the calling session on each call, and the
// conversation answers only for its own session while one of its turns runs. The grant never leaves this Worker.
//
// Uses two Console additions when they're there, and works without them:
// - `POST /v1/agents/:slug/sessions` opens the session before the first message, so its host is built while the
//   customer types (warm). Without it (404), the first input opens the session.
// - `log?live=true` adds the ephemeral `session.text.delta` events, so text streams. Without it, each text part arrives
//   whole when it ends.
// Between turns a follow stays open for KEEP_MS, which keeps Console's session object, and the host it built, awake.

const TURN_LIMIT_MS = 10 * 60_000, KEEP_MS = 10 * 60_000;
const SESSION_KEY = 'support:console-session', CURSOR_KEY = 'support:console-cursor';

type LogEvent = { type?: string; durable?: { seq?: number }; data?: Record<string, any> };

export function createConsoleHarness(env: Env, storage: DurableObjectStorage, conversationId: string): Harness {
  const base = (env.CONSOLE_AGENT_URL ?? '').replace(/\/$/, ''), slug = env.CONSOLE_AGENT_SLUG ?? '';
  const routingKey = `nightmail-support:${conversationId}`;
  let canOpen = true, keeper: AbortController | null = null, keepUntil = 0;
  const send = (path: string, init: RequestInit = {}) => {
    const key = env.CONSOLE_AGENT_KEY;
    if (!key) throw new MissingSecret('CONSOLE_AGENT_KEY');
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${key}`);
    const request = new Request(`${base}/v1/agents/${encodeURIComponent(slug)}${path}`, { ...init, headers });
    return env.CONSOLE_FAKE ? env.CONSOLE_FAKE.fetch(request) : fetch(request);
  };
  /** The session this conversation uses, recorded so mcp.ts can find the conversation from a tool call's session. */
  const remember = async (sessionID: string) => {
    if ((await storage.get<string>(SESSION_KEY)) === sessionID) return;
    await storage.put(SESSION_KEY, sessionID);
    await env.DB.prepare('INSERT INTO console_sessions (session_id, conversation_id, created_at) VALUES (?, ?, ?) ON CONFLICT (session_id) DO NOTHING').bind(sessionID, conversationId, Date.now()).run();
  };
  /** Opens the session without an input, where Console supports it; undefined where it doesn't (yet). */
  const open = async () => {
    const known = await storage.get<string>(SESSION_KEY);
    if (known || !canOpen) return known;
    const started = Date.now();
    const response = await send('/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ routingKey }) });
    if (response.status === 404 || response.status === 405) { canOpen = false; return undefined; }
    if (!response.ok) throw new Error(`Console refused to open the session (${response.status}).`);
    const { sessionID } = await response.json<{ sessionID: string }>();
    await remember(sessionID);
    log('info', { event: 'console', code: 'SESSION_OPENED', ms: Date.now() - started });
    return sessionID;
  };
  /** Keeps a follow open on the session until KEEP_MS after the last call, so Console keeps its host built. */
  const keep = (sessionID: string) => {
    keepUntil = Date.now() + KEEP_MS;
    if (keeper) return;
    const stop = keeper = new AbortController();
    void (async () => {
      while (Date.now() < keepUntil && !stop.signal.aborted) {
        const cursor = await storage.get<number>(CURSOR_KEY);
        const response = await send(`/sessions/${sessionID}/log?follow=true${cursor === undefined ? '' : `&after=${cursor}`}`, { signal: stop.signal }).catch(() => null);
        if (!response?.ok || !response.body) break;
        await response.body.pipeTo(new WritableStream(), { signal: stop.signal }).catch(() => {});
      }
    })().finally(() => { if (keeper === stop) keeper = null; });
  };

  return {
    async warm() {
      const sessionID = await open();
      if (sessionID) keep(sessionID);
    },
    async turn(input: TurnInput, _tools, onEvent: (event: HarnessEvent) => void, signal: AbortSignal): Promise<TurnResult> {
      const started = Date.now(), usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 };
      const warmed = !!(await storage.get<string>(SESSION_KEY));
      const texts: string[] = [], names = new Map<string, string>(), streamed = new Map<string, string>(), ended = new Set<string>();
      let outcome: 'succeeded' | 'failed' | 'interrupted' | null = null, error: string | undefined;
      let firstTool: number | undefined, firstText: number | undefined, deltas = 0;
      // Console has no per-turn system prompt: the harness's trusted context leads the input, apart from the customer's words.
      const text = input.context.trim() ? `[Harness context for this turn, from the support Worker: trusted]\n${input.context.trim()}\n\n${input.text}` : input.text;
      const sent = await send('/inputs', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ routingKey, inputId: newId('msg'), text, delivery: 'queue', ...(input.images?.length ? { files: input.images.map(i => ({ name: i.name, uri: i.uri })) } : {}) }),
      });
      if (sent.status !== 200 && sent.status !== 202) throw new Error(`Console refused the input (${sent.status}).`);
      const { sessionID } = await sent.json<{ sessionID: string }>();
      await remember(sessionID);
      const accepted = Date.now() - started;
      const stop = () => { void send(`/sessions/${sessionID}/interrupt`, { method: 'POST' }).catch(() => {}); };
      signal.addEventListener('abort', stop, { once: true });
      let cursor = await storage.get<number>(CURSOR_KEY);
      const emit = (part: string, delta: string) => {
        if (!delta) return;
        firstText ??= Date.now() - started;
        // A new part after earlier text starts a new paragraph.
        const opening = !streamed.has(part) && (texts.length > 0 || streamed.size > 0);
        streamed.set(part, (streamed.get(part) ?? '') + delta);
        onEvent({ type: 'text.delta', delta: opening ? `\n\n${delta}` : delta });
      };
      try {
        // A follow ends after five minutes; reconnect from the exclusive cursor until the turn settles.
        while (outcome === null && Date.now() - started < TURN_LIMIT_MS && !signal.aborted) {
          const response = await send(`/sessions/${sessionID}/log?follow=true&live=true${cursor === undefined ? '' : `&after=${cursor}`}`, { headers: { accept: 'text/event-stream' }, signal });
          if (response.status !== 200 || !response.body) throw new Error(`Console's session log answered ${response.status}.`);
          const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
          let buffer = '';
          read: for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += value;
            let end: number;
            while ((end = buffer.indexOf('\n')) >= 0) {
              const line = buffer.slice(0, end).trim();
              buffer = buffer.slice(end + 1);
              if (!line.startsWith('data:')) continue;
              let event: LogEvent;
              try { event = JSON.parse(line.slice(5)); } catch { continue; }
              if (typeof event.durable?.seq === 'number') cursor = event.durable.seq;
              const data = event.data ?? {};
              const part = `${data.assistantMessageID}:${data.ordinal}`;
              switch (event.type) {
                // Deltas ride a separate subscription, so one can arrive after its part ended: the ended text already covered it.
                case 'session.text.delta': if ((data.sessionID === undefined || data.sessionID === sessionID) && !ended.has(part)) { deltas++; emit(part, String(data.delta ?? '')); } break;
                case 'session.text.ended': {
                  const whole = typeof data.text === 'string' ? data.text.trim() : '';
                  ended.add(part);
                  if (!whole) break;
                  // Live text already sent what it saw of this part; send only what it missed.
                  const seen = streamed.get(part) ?? '';
                  if (!seen) emit(part, whole);
                  else if (whole.startsWith(seen)) emit(part, whole.slice(seen.length));
                  else if (whole.startsWith(seen.trim())) emit(part, whole.slice(seen.trim().length).trimStart());
                  texts.push(whole);
                  break;
                }
                case 'session.tool.input.started': names.set(String(data.id), baseToolName(String(data.name))); break;
                case 'session.tool.called': firstTool ??= Date.now() - started; onEvent({ type: 'tool.start', callId: String(data.id), tool: names.get(String(data.id)) ?? 'tool', args: (data.input ?? {}) as Record<string, unknown> }); break;
                case 'session.tool.success': onEvent({ type: 'tool.end', callId: String(data.id), tool: names.get(String(data.id)) ?? 'tool', ok: true }); break;
                case 'session.tool.failed': onEvent({ type: 'tool.end', callId: String(data.id), tool: names.get(String(data.id)) ?? 'tool', ok: false }); break;
                case 'session.step.ended': {
                  const t = data.tokens ?? {};
                  usage.inputTokens += Number(t.input ?? 0) + Number(t.cache?.write ?? 0);
                  usage.outputTokens += Number(t.output ?? 0) + Number(t.reasoning ?? 0);
                  usage.cacheReadTokens += Number(t.cache?.read ?? 0);
                  usage.costUsd += Number(data.cost ?? 0);
                  break;
                }
                case 'session.execution.succeeded': outcome = 'succeeded'; break read;
                case 'session.execution.interrupted': outcome = 'interrupted'; break read;
                case 'session.execution.failed': outcome = 'failed'; error = String(data.error?.message ?? 'failed').slice(0, 300); break read;
              }
            }
          }
          await reader.cancel().catch(() => {});
        }
      } finally {
        signal.removeEventListener('abort', stop);
        if (cursor !== undefined) await storage.put(CURSOR_KEY, cursor);
      }
      if (outcome === null) { outcome = signal.aborted ? 'interrupted' : 'failed'; error ??= 'The Console turn did not settle in time.'; if (!signal.aborted) stop(); }
      keep(sessionID);
      log(outcome === 'failed' ? 'error' : 'info', { event: 'turn', runtime: 'console', outcome, code: outcome === 'failed' ? 'TURN_FAILED' : undefined, durationMs: Date.now() - started, acceptedMs: accepted,
        firstToolMs: firstTool, firstTextMs: firstText, deltas, warmed, ...usage, tools: names.size, images: input.images?.length ?? 0 });
      return { text: texts.join('\n\n'), usage, aborted: outcome === 'interrupted', ...(outcome === 'failed' ? { error: error ?? 'failed' } : {}) };
    },
  };
}
