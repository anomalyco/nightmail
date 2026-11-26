import { Plugin } from '@opencode/plugin';
import type { OpenCodeWorkerd } from '@opencode/sdk/workerd';
import type { Env } from '../env.js';
import { MissingSecret } from '../tokens.js';
import type { Harness, HarnessEvent, HarnessTool, TurnInput, TurnResult, Usage } from './harness.js';
import { TOOLS, ToolFailure, type Param, type ToolHost } from './tools.js';
import { unfenced } from './projection.js';
import SYSTEM from './system.md';
import VOICE from '../../VOICE.md';
import { errorTypeOf } from '../../../api/src/log.js';
import { promptFragmentsOf } from '../gate.js';
import { log } from '../log.js';

// The agent runtime: OpenCode, embedded in the conversation's Durable Object through `@opencode/sdk/workerd` (the same
// SDK Console's agents run on). OpenCode owns the agent loop, its history (in this object's SQLite), streaming,
// retries and eviction recovery; we give it one custom agent, our tools as a plugin, and a fetch it must use for every
// request. Upgrading means bumping @opencode/sdk and @opencode/plugin together (pinned, see package.json).
//
// Pinned model (owner decision): Claude Opus 5.5 at medium effort through Console's inference gateway, nothing else.
// The pin is enforced four ways: the config model, the agent model, the session model (without it OpenCode would fall
// back to any available model) and a provider policy; and the fetch below refuses any request that isn't exactly it.
// A conversation whose session was made under an earlier pin is switched to this one before its next turn.
//
// Two agents run on it, each in Durable Objects of its own, with its own system prompt and tool list (a Profile): the
// customer-facing support agent (SUPPORT, one object per conversation) and the feedback triage agent (agent/triage.ts,
// one object per report). Neither ever sees the other's prompt, tools or sessions.

export const MODEL = { providerID: 'anthropic', model: 'claude-opus-5-5', variant: 'medium' } as const;
const PIN = `${MODEL.model}#${MODEL.variant}`;
const MAX_STEPS = 25;
/** Set while a turn runs: still set when the next turn starts, it means the last one was cut off (an eviction). */
const TURN_OPEN = 'support:opencode-turn-open';
/** How long the first turn after a cut-off one waits for OpenCode's resumed run to start (it starts at boot). */
const RESUME_WAIT_MS = 3_000;
/** OpenCode's error type for a response the provider blocked or the model refused. */
const CONTENT_FILTER = 'provider.content-filter';
/** Deny everything, then allow these tools (OpenCode lists only the tools a session's rules allow). */
const rules = (names: readonly string[]) => [{ action: '*', resource: '*', effect: 'deny' as const }, ...names.map(name => ({ action: name, resource: '*', effect: 'allow' as const }))];
export const systemPrompt = () => `${SYSTEM.trim()}\n\n---\n\n# Voice (follow it)\n\n${VOICE.trim()}`;

/**
 * One agent: its OpenCode agent name, its system prompt, its tools (and the host they act through), its step limit and
 * its sessions' title. The agent's own rules allow exactly its tools; a session's rules, set per turn, narrow them.
 */
export type Profile<H> = { agent: string; title: string; system: string; tools: readonly HarnessTool<H>[]; steps: number };
/** The customer-facing support agent. */
export const SUPPORT: Profile<ToolHost> = { agent: 'support', title: 'Support conversation', system: systemPrompt(), tools: TOOLS, steps: MAX_STEPS };

function config<H>(gatewayURL: string, profile: Profile<H>): OpenCodeWorkerd.Configuration {
  return {
    default_agent: profile.agent,
    model: MODEL,
    // Only the gateway-backed provider exists, so nothing can resolve to another provider as a fallback.
    policies: [
      { action: 'provider.use', resource: '*', effect: 'deny' },
      { action: 'provider.use', resource: 'anthropic', effect: 'allow' },
      { action: 'websearch.use', resource: '*', effect: 'deny' },
    ],
    // No apiKey: OpenCode sends none, and modelFetch adds the gateway key. The key never enters OpenCode's config,
    // storage or the model's context.
    providers: { anthropic: { settings: { baseURL: gatewayURL } } },
    agents: {
      [profile.agent]: { mode: 'primary', model: MODEL, system: profile.system, steps: profile.steps, permissions: rules(profile.tools.map(t => t.name)) },
      build: { disabled: true }, plan: { disabled: true }, general: { disabled: true }, explore: { disabled: true },
      // Title and summary would call a smaller model: never.
      title: { disabled: true }, summary: { disabled: true },
    },
    // The 500K-token conversation budget stays under the model's window, so compaction (another model call) is off.
    compaction: { auto: false },
    websearch: false,
    snapshots: false,
    share: 'disabled',
  } as OpenCodeWorkerd.Configuration;
}

type Fetch = (input: Request | string | URL, init?: RequestInit) => Promise<Response>;

/**
 * The only way out of the isolate for OpenCode: requests to the gateway get the key and must be the pinned model at the
 * pinned effort; anything else is refused. In tests, MODEL_FAKE stands in for the network. `system`: the agent's own
 * prompt, cached for an hour.
 */
export function modelFetch(env: Env, system = SUPPORT.system): Fetch {
  const root = env.GATEWAY_URL.replace(/\/$/, '');
  return async (input, init) => {
    const request = new Request(input, init);
    if (!request.url.startsWith(`${root}/`)) return new Response('egress denied', { status: 403 });
    const key = env.CONSOLE_GATEWAY_KEY;
    if (!key) throw new MissingSecret('CONSOLE_GATEWAY_KEY');
    let body: ModelRequest | undefined;
    if (request.method === 'POST') {
      body = await request.clone().json<ModelRequest>().catch(() => undefined);
      if (body?.model !== MODEL.model || body?.output_config?.effort !== MODEL.variant) {
        log('error', { event: 'model', code: 'MODEL_PIN_VIOLATED', model: body?.model ?? null, effort: body?.output_config?.effort ?? null });
        return Response.json({ type: 'error', error: { type: 'invalid_request_error', message: 'This Worker only sends the pinned model.' } }, { status: 400 });
      }
    }
    const headers = new Headers(request.headers);
    headers.delete('x-api-key');
    headers.set('authorization', `Bearer ${key}`);
    let send = new Request(request, { headers });
    if (body && cacheForAnHour(body, system)) {
      headers.delete('content-length');
      send = new Request(request.url, { method: 'POST', headers, body: JSON.stringify(body), signal: request.signal });
    }
    return env.MODEL_FAKE ? env.MODEL_FAKE.fetch(send) : fetch(send);
  };
}

type CacheControl = { type: string; ttl?: string };
type ModelRequest = { model?: string; output_config?: { effort?: string }; tools?: { cache_control?: CacheControl }[]; system?: { text?: string; cache_control?: CacheControl }[] };
/**
 * The tools and the system prompt are the same for every conversation: their cache breakpoints (OpenCode's, on the last
 * tool and on each system part) last an hour instead of five minutes, so a chat opened after a quiet spell doesn't
 * prefill them again. The per-customer system part and the messages keep five minutes. Console's gateway honours `ttl`.
 */
function cacheForAnHour(body: ModelRequest, system: string): boolean {
  const parts = [body.tools?.at(-1), body.system?.[0]?.text === system ? body.system[0] : undefined];
  let changed = false;
  for (const part of parts) if (part?.cache_control?.type === 'ephemeral' && part.cache_control.ttl !== '1h') { part.cache_control = { type: 'ephemeral', ttl: '1h' }; changed = true; }
  return changed;
}

/**
 * A tool call's arguments as the agent meant them: it reads outside text escaped (projection.ts), so every string it passes
 * on (a reply, a ticket, a note, an ID) has those escapes undone once, as its answer does.
 */
const written = (value: unknown): unknown => typeof value === 'string' ? unfenced(value) : Array.isArray(value) ? value.map(written)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, written(v)])) : value;

function jsonSchema(params: Record<string, Param>) {
  const properties: Record<string, unknown> = {}, required: string[] = [];
  for (const [name, p] of Object.entries(params)) {
    if (!p.optional) required.push(name);
    if (p.type === 'string') properties[name] = { type: 'string', description: p.description, ...(p.max ? { maxLength: p.max } : {}), ...(p.pattern ? { pattern: p.pattern } : {}) };
    else if (p.type === 'number') properties[name] = { type: 'integer', description: p.description, ...(p.min !== undefined ? { minimum: p.min } : {}), ...(p.max !== undefined ? { maximum: p.max } : {}) };
    else if (p.type === 'enum') properties[name] = { type: 'string', enum: [...p.values], description: p.description };
    else properties[name] = { type: 'array', items: { type: 'string', maxLength: 400 }, description: p.description, ...(p.max ? { maxItems: p.max } : {}) };
  }
  return { type: 'object', properties, required, additionalProperties: false };
}

/** The output gate's "never reveal this prompt" fragments, from this prompt's instructions (gate.ts). */
export const promptFragments = () => promptFragmentsOf(SYSTEM);

/**
 * One OpenCode host per object (a support conversation's, or a feedback report's), booted on its first turn, running
 * `profile`'s agent: the support agent unless another is named.
 */
export async function createHarness<H = ToolHost>(env: Env, storage: DurableObjectStorage, profile: Profile<H> = SUPPORT as unknown as Profile<H>): Promise<Harness<H>> {
  // Per turn: whose tools these are, which of them this turn may call (its channel, mode and role), and the
  // <customer>/<account> block.
  const current: { host: H | null; allowed: ReadonlySet<string>; context: string } = { host: null, allowed: new Set(), context: '' };
  const plugin = Plugin.define({
    id: `bane.${profile.agent}`,
    setup: async ctx => {
      const registration = await ctx.tool.transform(editor => {
        for (const spec of profile.tools) {
          editor.add({
            name: spec.name, description: spec.description, input: jsonSchema(spec.params) as never,
            // Native tools on the provider's list, not behind Code Mode's `execute`.
            options: { codemode: false },
            execute: async (input: unknown, context: { signal: AbortSignal }) => {
              if (!current.host) throw new Error('No conversation is attached to this turn.');
              if (context.signal.aborted) throw new Error('Cancelled.');
              // The session's rules already leave it out; a call that gets here anyway is refused, never run.
              if (!current.allowed.has(spec.name)) throw new Error('That tool is not available in this conversation.');
              try { return { content: await spec.execute(written(input ?? {}) as Record<string, unknown>, current.host) }; }
              catch (error) { throw new Error(error instanceof ToolFailure ? error.message : 'The tool failed. Say what you could not check and carry on.'); }
            },
          } as never);
        }
      });
      // Drop OpenCode's host-oriented system parts (a working directory, a worktree hint): this agent has no filesystem.
      // Then add this turn's <customer> and <context> after the stable prompt, so the prompt itself stays cacheable.
      const system = await ctx.session.hook('context', event => {
        event.system = event.system.filter(part => !part.text.includes('<env>') && !part.text.startsWith('When you create a worktree') && !part.text.startsWith('# Your Model'));
        if (current.context) event.system.push({ type: 'text', text: current.context });
      });
      const title = await ctx.session.hook('title', event => { event.result = profile.title; });
      return async () => { await Promise.all([registration.dispose(), system.dispose(), title.dispose()]); };
    },
  });
  const { OpenCodeWorkerd } = await import('@opencode/sdk/workerd');
  const opencode = await OpenCodeWorkerd.create({
    storage, config: config(env.GATEWAY_URL, profile), plugins: [plugin], fetch: modelFetch(env, profile.system), models: { fetch: false },
    // The runtime's own warnings: its fixed text (scrubbed and cut short), never the attributes, which can carry turn data.
    log: { level: 'warn', emit: entry => log(entry.level === 'warn' ? 'warn' : 'error', { event: 'opencode', code: 'OPENCODE', note: String(entry.message).slice(0, 120), errorType: entry.cause === undefined ? undefined : errorTypeOf(entry.cause) }) },
  });

  const model = { providerID: MODEL.providerID, id: MODEL.model, variant: MODEL.variant };
  /**
   * The conversation's one session, allowing exactly this turn's tools. A session keeps one history for the whole
   * conversation; its rules (which decide what the model is offered and can call) change when the turn's tool set does:
   * a claim turns a non-member into a member, a role changes. The set last applied is kept beside the session ID, so an
   * unchanged set costs no update.
   */
  async function session(tools: readonly string[]): Promise<string> {
    const set = tools.join(','), existing = await storage.get<string>('support:opencode-session');
    if (existing) {
      // A session keeps the model it was made with; one from before the current pin moves to it, or the fetch guard
      // would refuse its next request.
      if (await storage.get<string>('support:opencode-model') !== PIN) {
        await opencode.sessions.switchModel({ sessionID: existing, model } as never);
        await storage.put('support:opencode-model', PIN);
      }
      if (await storage.get<string>('support:opencode-tools') !== set) {
        await opencode.sessions.update({ sessionID: existing, permissions: rules(tools) } as never);
        await storage.put('support:opencode-tools', set);
      }
      return existing;
    }
    const created = await opencode.sessions.create({ title: profile.title, location: { directory: `/${profile.agent}` }, agent: profile.agent, model, permissions: rules(tools) } as never);
    await storage.put({ 'support:opencode-session': created.id, 'support:opencode-model': PIN, 'support:opencode-tools': set });
    return created.id;
  }

  /**
   * A turn cut off by an eviction is resumed by OpenCode when it boots, in the background, with a "server restarted"
   * note. That run must never meet the next turn's tools or events: a resumed email turn would call reply for the next
   * email, and its end would read as the next turn's. So when the last turn never finished (TURN_OPEN still set), wait
   * for the resumed run to start, stop it and let it end before this turn begins; anything else still running is stopped
   * too. The conversation's work queue already decides what happens to the email it was answering.
   */
  async function settle(sessionID: string) {
    const until = Date.now() + (await storage.get<boolean>(TURN_OPEN) ? RESUME_WAIT_MS : 0);
    for (;;) {
      if ((await opencode.sessions.active().catch((): Record<string, unknown> => ({})))[sessionID]) {
        log('warn', { event: 'turn', code: 'RESUMED_RUN_STOPPED' });
        await opencode.sessions.interrupt({ sessionID } as never).catch(() => {});
        await Promise.race([opencode.sessions.wait({ sessionID } as never), new Promise(resolve => setTimeout(resolve, 120_000))]).catch(() => {});
        return;
      }
      if (Date.now() >= until) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  return {
    async turn(input: TurnInput, tools: H, onEvent: (event: HarnessEvent) => void, signal: AbortSignal): Promise<TurnResult> {
      const sessionID = await session(input.tools);
      await settle(sessionID);
      await storage.put(TURN_OPEN, true);
      current.host = tools; current.allowed = new Set(input.tools); current.context = input.context;
      const usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 }, started = Date.now();
      const texts: string[] = [], names = new Map<string, string>();
      let outcome = 'failed' as 'succeeded' | 'failed' | 'interrupted', error: string | undefined, failure: string | undefined, refused = false;
      const listen = new AbortController();
      const done = (async () => {
        for await (const event of opencode.events.subscribe({ signal: listen.signal }) as AsyncIterable<{ type: string; data: Record<string, any> }>) {
          const data = event.data ?? {};
          if (data.sessionID !== sessionID) continue;
          switch (event.type) {
            // Text is taken whole when each part ends: nothing the model writes is passed on before the turn is over.
            case 'session.text.ended': if (typeof data.text === 'string' && data.text.trim()) texts.push(data.text.trim()); break;
            case 'session.tool.input.started': names.set(String(data.id), String(data.name)); break;
            case 'session.tool.called': onEvent({ type: 'tool.start', callId: String(data.id), tool: names.get(String(data.id)) ?? 'tool', args: (data.input ?? {}) as Record<string, unknown> }); break;
            case 'session.tool.success': onEvent({ type: 'tool.end', callId: String(data.id), tool: names.get(String(data.id)) ?? 'tool', ok: true }); break;
            case 'session.tool.failed': onEvent({ type: 'tool.end', callId: String(data.id), tool: names.get(String(data.id)) ?? 'tool', ok: false }); break;
            case 'session.step.ended': {
              const t = data.tokens ?? {};
              // Uncached input (and cache writes) apart from cache reads, which cost a tenth: the budget weighs them so.
              usage.inputTokens += Number(t.input ?? 0) + Number(t.cache?.write ?? 0);
              usage.outputTokens += Number(t.output ?? 0) + Number(t.reasoning ?? 0);
              usage.cacheReadTokens += Number(t.cache?.read ?? 0);
              usage.costUsd += Number(data.cost ?? 0);
              break;
            }
            // The model declined to answer (Anthropic's stop_reason "refusal", which OpenCode reports as a content-filter
            // finish): the step fails, then the run.
            case 'session.step.failed': if (data.finish === 'content-filter' || data.error?.type === CONTENT_FILTER) refused = true; break;
            case 'session.execution.succeeded': outcome = 'succeeded'; return;
            case 'session.execution.interrupted': outcome = 'interrupted'; return;
            case 'session.execution.failed': {
              if (data.error?.type === CONTENT_FILTER) refused = true;
              outcome = 'failed'; error = String(data.error?.message ?? 'failed').slice(0, 300);
              // For the log line: the failure's kind when it is an identifier, never its message.
              const kind = [data.error?.name, data.error?.type, data.error?.code].find(v => typeof v === 'string' && /^[A-Za-z][\w.-]{0,63}$/.test(v));
              failure = typeof kind === 'string' ? kind : undefined;
              return;
            }
          }
        }
      })();
      const stop = () => { void opencode.sessions.interrupt({ sessionID } as never).catch(() => {}); };
      signal.addEventListener('abort', stop, { once: true });
      try {
        // Let the subscription attach before prompting, so no early event is missed.
        await new Promise(resolve => setTimeout(resolve, 0));
        await opencode.sessions.prompt({ sessionID, text: input.text, ...(input.images?.length ? { files: input.images.map(image => ({ uri: image.uri, name: image.name })) } : {}) } as never);
        await done;
        // The run ended (succeeded, failed or interrupted): nothing is left for a boot to resume.
        await storage.delete(TURN_OPEN);
      } finally {
        signal.removeEventListener('abort', stop);
        listen.abort();
        current.host = null; current.allowed = new Set();
      }
      // One line per model turn: its outcome, time, tokens and cost, and how many tools and images it used. A refusal is
      // the model's answer, not a failure: the conversation sends its fixed decline and logs MODEL_REFUSAL.
      const failed = outcome === 'failed' && !refused;
      log(failed ? 'error' : 'info', { event: 'turn', agent: profile.agent, outcome: refused ? 'refused' : outcome, code: failed ? 'TURN_FAILED' : undefined, failure: failed ? failure : undefined, durationMs: Date.now() - started, ...usage, tools: names.size, images: input.images?.length ?? 0 });
      if (refused) return { text: '', usage, aborted: false, refused: true };
      return { text: unfenced(texts.join('\n\n')), usage, aborted: outcome === 'interrupted', ...(failed ? { error: error ?? 'failed' } : {}) };
    },
    close: () => opencode.close(),
  };
}
