import type { Env } from './env.js';
import { jsonSchema, TOOLS } from './agent/tools.js';
import { productName } from '../../api/src/brand.js';
import { log } from './log.js';

// Prototype, dev only: the support tools as an MCP server (Streamable HTTP, stateless, JSON responses) for a Console
// agent (agent/console.ts). Console's MCP gateway is the only caller: it sends the workspace credential an admin gave
// the server (CONSOLE_MCP_KEY) and names the agent session a call comes from in `_meta["ai.opencode/sessionID"]`, which
// the agent runtime sets and the model can't. The session finds its conversation (D1 `console_sessions`, written when
// the conversation opened it); the conversation runs the tool over its own grant, and only while one of its turns runs.
// Nothing in a call's arguments names a customer, and the grant never leaves the conversation's Durable Object.

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SESSION_ID = /^ses_[A-Za-z0-9]{8,64}$/;
const INSTRUCTIONS = `${productName} support's tools. Each call acts for the customer of the conversation this session answers, read-only, with the access ${productName} granted it; no argument names a customer.`;

type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, any> };
const reply = (id: Rpc['id'], body: { result: unknown } | { error: { code: number; message: string } }) =>
  Response.json({ jsonrpc: '2.0', id: id ?? null, ...body }, { headers: { 'cache-control': 'no-store' } });

async function sameKey(given: string, expected: string) {
  const encoder = new TextEncoder(), [a, b] = await Promise.all([given, expected].map(v => crypto.subtle.digest('SHA-256', encoder.encode(v))));
  return crypto.subtle.timingSafeEqual(a!, b!);
}

const known = new Map<string, string>();
/** The conversation a Console session answers, once it opened the session; a call can race the first turn's write. */
async function conversationOf(env: Env, sessionID: string) {
  const cached = known.get(sessionID);
  if (cached) return cached;
  for (let attempt = 1; attempt <= 5; attempt++) {
    const row = await env.DB.prepare('SELECT conversation_id FROM console_sessions WHERE session_id = ?').bind(sessionID).first<{ conversation_id: string }>();
    if (row) { if (known.size > 1000) known.clear(); known.set(sessionID, row.conversation_id); return row.conversation_id; }
    await new Promise(resolve => setTimeout(resolve, 100 * attempt));
  }
  return null;
}

export async function mcp(request: Request, env: Env): Promise<Response> {
  if (!env.CONSOLE_MCP_KEY || !env.CONSOLE_AGENT_SLUG) return new Response(null, { status: 404 });
  const given = request.headers.get('authorization')?.match(/^Bearer (\S+)$/)?.[1];
  if (!given || !(await sameKey(given, env.CONSOLE_MCP_KEY))) return new Response(null, { status: 401 });
  // No server-to-client stream and no session to end: Streamable HTTP lets a stateless server refuse both.
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } });
  let message: Rpc;
  try { message = await request.json<Rpc>(); } catch { return reply(null, { error: { code: -32700, message: 'Parse error' } }); }
  if (Array.isArray(message) || typeof message !== 'object' || message === null) return reply(null, { error: { code: -32600, message: 'One JSON-RPC message per request.' } });
  if (message.id === undefined) return new Response(null, { status: 202 }); // notifications, e.g. notifications/initialized
  switch (message.method) {
    case 'initialize': {
      const asked = String(message.params?.protocolVersion ?? '');
      return reply(message.id, { result: { protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0], capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'nightmail-support', version: '0.1.0' }, instructions: INSTRUCTIONS } });
    }
    case 'ping': return reply(message.id, { result: {} });
    case 'tools/list':
      return reply(message.id, { result: { tools: TOOLS.map(t => ({ name: t.name, description: t.description, inputSchema: jsonSchema(t.params), annotations: { readOnlyHint: !['file_ticket', 'request_content_access', 'choose_workspace'].includes(t.name), openWorldHint: false } })) } });
    case 'tools/call': {
      const name = String(message.params?.name ?? ''), args = (message.params?.arguments ?? {}) as Record<string, unknown>;
      const sessionID = message.params?._meta?.['ai.opencode/sessionID'];
      const fail = (text: string) => reply(message.id, { result: { content: [{ type: 'text', text }], isError: true } });
      if (!TOOLS.some(t => t.name === name)) return reply(message.id, { error: { code: -32602, message: `Unknown tool ${name.slice(0, 60)}.` } });
      if (typeof sessionID !== 'string' || !SESSION_ID.test(sessionID)) return fail('This call names no agent session, so it acts for no one.');
      const conversationId = await conversationOf(env, sessionID);
      if (!conversationId) return fail('This session answers no support conversation.');
      const started = Date.now();
      const result = await env.CONVERSATION.get(env.CONVERSATION.idFromName(conversationId)).consoleTool({ sessionID, name, args });
      // How long a tool takes here, to set against the call's time in Console's log (the gateway's share is the rest).
      log('info', { event: 'mcp', code: result.ok ? 'TOOL_OK' : 'TOOL_REFUSED', tool: name, ms: Date.now() - started });
      return reply(message.id, { result: { content: [{ type: 'text', text: result.text }], ...(result.ok ? {} : { isError: true }) } });
    }
    default: return reply(message.id, { error: { code: -32601, message: 'Method not found' } });
  }
}
