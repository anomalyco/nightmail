// Test doubles for the support Worker's integration tests: a fake Nightmail (the SupportPlatform entrypoint over RPC and the
// public API it calls with the inbox key) and a scripted Anthropic Messages API standing in for Console's gateway.
// No network, no real model: the model's moves are decided from the request body, so retries and replays stay stable.

import { pngWithMetadata } from './images.js';

export const GRANT_TOKEN = `bane_support_${'5'.repeat(64)}`;
const EMAIL_PNG = Buffer.from(pngWithMetadata(80, 40)).toString('base64');

/** The fake Nightmail, as a Worker module (it must export a real WorkerEntrypoint for RPC). */
export const FAKE_BANE = `
import { WorkerEntrypoint } from 'cloudflare:workers';
const calls = [];
const used = new Map(); // handoff id → the conversation it registered (or '' when a grant used it)
const shared = new Set();
let grants = 0;
// The staff inbox (api/src/support-inbox.ts), in memory: a conversation exists once a test registers it (/__inbox), like
// Nightmail's 404 for one it never registered; down makes every inbox call answer 503.
const inbox = new Map();
let inboxDown = false;
const missing = () => ok({ error: { code: 'NOT_FOUND' } }, 404), unavailable = () => ok({ error: { code: 'UNAVAILABLE' } }, 503);
const inboxState = (id, c) => ({ id, status: c.status, agentState: c.paused ? 'paused' : 'active', pausedBy: c.paused || null, pausedAt: c.paused ? new Date().toISOString() : null, queuedReplies: c.outbox.filter(r => !r.delivery).length });
const ok = (body, status = 200) => ({ status, body, requestId: 'req_' + '0'.repeat(32), retryAfter: null });
const refuse = (status, code) => ok({ error: { code, message: code } }, status);
// People and workspaces, as Nightmail keeps them: a handoff's user belongs to its workspace, and every @acme.test address
// is a user in Acme Prod (Ada, plus the cases' rita@, dora@, victim@ …). Removing a membership is a test hook.
const WORKSPACES = { ws_acme: 'Acme Prod', ws_other: 'Other' };
const members = new Map(); // userId → Map(workspaceId → role)
const people = new Map([['usr_ada', { name: 'Ada Lovelace', email: 'ada@acme.test' }]]);
const person = userId => people.get(userId) ?? { name: null, email: null };
const known = (userId, email) => { if (!people.has(userId)) people.set(userId, { name: userId[4].toUpperCase() + userId.slice(5), email }); };
const join = (userId, workspaceId) => { if (!members.has(userId)) members.set(userId, new Map()); if (!members.get(userId).has(workspaceId) && !members.get(userId).has('!' + workspaceId)) members.get(userId).set(workspaceId, 'owner'); };
const memberships = userId => [...(members.get(userId) ?? new Map())].filter(([id]) => !id.startsWith('!')).map(([id, role]) => ({ id, name: WORKSPACES[id] ?? id, role }));
const handoff = token => {
  // Test handoffs are "handoff:<id>:<userId>:<workspaceId>:<share>".
  const [kind, id, userId, workspaceId, share] = token.split(':');
  if (kind !== 'handoff') return null;
  known(userId, userId.slice(4) + '@other.test');
  return { id, kind: 'support', userId, email: person(userId).email, role: 'owner', workspace: { id: workspaceId, name: WORKSPACES[workspaceId] ?? workspaceId },
    page: '/campaigns', requestIds: [], shareContent: share === 'share', issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600000).toISOString(), usedAt: used.has(id) ? new Date().toISOString() : null, grantId: null, message: null };
};
// Registered conversations (api/src/support-conversations.ts): Nightmail decides whom each is for, and every stamped
// request answers for that person only, whatever the request says.
const conversations = new Map();
const view = (c, created) => ({ id: c.id, channel: c.channel, mode: c.mode, verification: c.verification, status: c.closed ? 'closed' : 'open', workspaceId: c.workspaceId, contentShared: !!c.content, created });
const inScope = c => memberships(c.userId).filter(w => !c.workspaceId || w.id === c.workspaceId);
function scopeOf(c) {
  const all = memberships(c.userId), workspace = c.workspaceId ? all.find(w => w.id === c.workspaceId) ?? null : null;
  return { conversation: { id: c.id, channel: c.channel, mode: c.mode, verification: c.verification }, user: person(c.userId),
    workspace, workspaces: c.channel === 'email' || !c.workspaceId ? all : all.filter(w => w.id === c.workspaceId),
    contentWorkspaceId: all.some(w => w.id === c.content) ? c.content : null, page: c.page, shrunk: [...c.read].some(id => !all.some(w => w.id === id)) };
}
/** An email's evidence as Nightmail reads it from the message it stored: its From and DMARC verdict. */
function emailEvidence(messageId) {
  const { from, dmarc } = message(messageId), sender = from.toLowerCase(), local = sender.endsWith('@acme.test') ? sender.split('@')[0] : null;
  const userId = local ? (local === 'ada' ? 'usr_ada' : 'usr_' + local) : null, verified = dmarc === 'PASS';
  if (userId) { known(userId, sender); join(userId, 'ws_acme'); }
  return { sender, userId: verified ? userId : null, verification: verified ? 'dmarc' : 'none',
    mode: verified ? (userId && memberships(userId).length ? 'member' : 'non_member') : userId ? 'pending_signin' : 'unverified' };
}
// Per-person reads (the subject is the conversation's person, never anything in the request) and fixed ones.
const contextOf = c => ({ grant: { id: 'sgr_x', ticketRef: 'conv' }, user: { id: c.userId, ...person(c.userId) },
  workspaces: inScope(c).map(w => ({ ...w, sending: { kind: 'shared', region: 'us-east-2', paused: false }, counts: { domains: 1, campaigns: 3 } })),
  domains: inScope(c).map(w => ({ workspaceId: w.id, id: 'dom_' + w.id, name: 'news.' + w.id.slice(3) + '.test', sending: 'verified', dmarc: 'missing' })), recentFailures: { sends: [], bounces: [], webhookDeliveries: [] },
  standing: [], recentActivity: [], openEnforcement: [], handoff: null, links: { requestIds: [] } });
const READS = {
  '/v1/support/campaigns': { data: [{ id: 'cmp_1', name: 'Early access', state: 'sent', launchedAt: new Date(Date.now() - 86400000).toISOString(), tracking: true, audience: { size: 2160 }, pauseReason: null,
    stats: { counts: { total: 2160, byStatus: { delivered: 2140 } }, totals: { accepted: 2152, delivered: 2140, opened: 899, clicked: 64, bounced: 12, complained: 0 }, rates: {} } }] },
  '/v1/support/standing': { data: [{ workspaceId: 'ws_acme', standing: { step: 'normal', score: 93, dailyLimit: 10000 }, last24h: { delivered: 1980, bounced: 20 } }] },
  '/v1/support/requests': { available: true, retention: '3 days', groups: [{ route: '/v1/webhooks/:id/test', method: 'POST', status: 500, code: 'INTERNAL_ERROR', principal: 'apiKey', count: 14,
    firstSeen: new Date(Date.now() - 7200000).toISOString(), lastSeen: new Date().toISOString(), sampleRequestIds: ['req_' + 'a'.repeat(32), 'req_' + 'b'.repeat(32)] }], totals: { errors: 14 } },
  '/v1/support/deliverability/bounces': { data: [{ provider: 'gmail', type: 'bounce', count: 61, diagnostic: 'smtp; 550 5.1.1 user unknown at someone@gmail.com from 203.0.113.9' }], findings: [{ severity: 'serious', code: 'HARD_BOUNCES', message: '6.1% hard bounces at Gmail' }], grant: { token: 'never-shown' }, operatorId: 'op_secret' },
};
export class SupportPlatform extends WorkerEntrypoint {
  async registerConversation({ conversationId, evidence }) {
    calls.push(['registerConversation', conversationId, evidence]);
    const existing = conversations.get(conversationId);
    if (evidence.kind === 'handoff') {
      const h = handoff(evidence.token);
      if (!h) return refuse(422, 'HANDOFF_INVALID');
      if (used.has(h.id)) return used.get(h.id) === conversationId ? ok(view(existing, false)) : refuse(409, 'SUPPORT_HANDOFF_USED');
      if (existing) return refuse(409, 'SUPPORT_CONVERSATION_EXISTS');
      used.set(h.id, conversationId);
      join(h.userId, h.workspace.id);
      const c = { id: conversationId, channel: 'chat', userId: h.userId, sender: null, mode: 'member', verification: 'handoff', workspaceId: h.workspace.id, content: h.shareContent ? h.workspace.id : null, closed: false, read: new Set(), page: h.page };
      conversations.set(conversationId, c);
      return ok(view(c, true), 201);
    }
    const found = emailEvidence(evidence.messageId);
    if (!existing) {
      const c = { id: conversationId, channel: 'email', userId: found.userId, sender: found.sender, mode: found.mode, verification: found.verification, workspaceId: null, content: null, closed: false, read: new Set(), page: null };
      conversations.set(conversationId, c);
      return ok(view(c, true), 201);
    }
    if (existing.channel !== 'email') return refuse(409, 'SUPPORT_CONVERSATION_EXISTS');
    if (existing.closed) return refuse(409, 'SUPPORT_CONVERSATION_CLOSED');
    if (existing.sender !== found.sender) return refuse(409, 'SUPPORT_CONVERSATION_SENDER');
    if (existing.userId) return found.userId === existing.userId ? ok(view(existing, false)) : refuse(409, 'SUPPORT_CONVERSATION_MISMATCH');
    Object.assign(existing, { userId: found.userId, mode: found.mode, verification: found.verification });
    return ok(view(existing, false));
  }
  async closeConversation(id) {
    calls.push(['closeConversation', id]);
    const c = conversations.get(id);
    if (!c) return refuse(404, 'NOT_FOUND');
    c.closed = true;
    return ok({ id, status: 'closed', closedAt: new Date().toISOString() });
  }
  /** A stamped request: [1] the path, [2] the conversation, as the log records it. */
  async request(conversationId, method, path, body) {
    calls.push(['request', path, conversationId, method, body ?? null]);
    const c = conversations.get(conversationId);
    if (!c || c.closed || !c.userId) return refuse(403, 'SUPPORT_GRANT_REQUIRED');
    const url = new URL(path, 'https://internal.invalid');
    if (url.pathname === '/v1/support/scope') {
      if (method === 'POST') {
        if (c.channel === 'chat' && body?.workspaceId !== c.workspaceId) return refuse(409, 'SUPPORT_SCOPE_FIXED');
        if (!memberships(c.userId).some(w => w.id === body?.workspaceId)) return refuse(404, 'NOT_FOUND');
        c.workspaceId = body.workspaceId;
      }
      return ok(scopeOf(c));
    }
    if (method !== 'GET') return refuse(403, 'SUPPORT_READ_ONLY');
    const filter = url.searchParams.get('workspaceId'), scope = inScope(c);
    if (filter && !scope.some(w => w.id === filter)) return refuse(404, 'NOT_FOUND');
    for (const w of scope) if (!filter || w.id === filter) c.read.add(w.id);
    const answer = url.pathname === '/v1/support/context' ? contextOf(c) : READS[url.pathname];
    return answer ? ok(answer) : refuse(404, 'NOT_FOUND');
  }
  async verifyHandoff(token) { calls.push(['verifyHandoff', token]); const h = handoff(token); if (h?.shareContent) shared.add(h.id); return h ? { ok: true, handoff: h } : { ok: false, code: 'HANDOFF_INVALID' }; }
  async verifyEmail(body) {
    calls.push(['verifyEmail', body]);
    // Every @acme.test address is a Nightmail user (Ada, plus the review PoCs' victim@ and vera@).
    const local = body.email.endsWith('@acme.test') ? body.email.split('@')[0] : null;
    return local ? ok({ verified: true, user: { id: local === 'ada' ? 'usr_ada' : 'usr_' + local, name: local === 'ada' ? 'Ada Lovelace' : local[0].toUpperCase() + local.slice(1) }, workspaces: [{ id: 'ws_acme', name: 'Acme Prod', role: 'owner' }] }) : ok({ verified: false, user: null, workspaces: [] });
  }
  async mintGrant(body) {
    calls.push(['mintGrant', body]);
    if (body.handoffId) { if (used.has(body.handoffId)) return ok({ error: { code: 'SUPPORT_HANDOFF_USED' } }, 409); used.set(body.handoffId, ''); }
    grants += 1;
    return ok({ id: 'sgr_' + String(grants).padStart(32, '0'), token: '${GRANT_TOKEN}', userId: body.userId, workspaceIds: body.workspaceIds ?? ['ws_acme'], ticketRef: body.ticketRef,
      contentShared: shared.has(body.handoffId), contentWorkspaceId: shared.has(body.handoffId) ? 'ws_acme' : null, expiresAt: new Date(Date.now() + 7200000).toISOString() }, 201);
  }
  async verifyStaff(token) {
    calls.push(['verifyStaff', token]);
    // Test staff tokens are "staff:<jti>:<userId>:<ok|demoted|expired>".
    const [kind, jti, userId, state] = token.split(':');
    if (kind !== 'staff') return { ok: false, code: 'STAFF_INVALID' };
    if (state === 'demoted') return { ok: false, code: 'NOT_OPERATOR' };
    if (state === 'expired') return { ok: false, code: 'STAFF_EXPIRED' };
    return { ok: true, staff: { userId, email: userId + '@anoma.ly', role: 'operator:read' }, jti, expiresAt: new Date(Date.now() + 120000).toISOString() };
  }
  async revokeGrant(id) { calls.push(['revokeGrant', id]); return ok({ id, revoked: true }); }
  async mirrorMessages(id, messages) {
    calls.push(['mirrorMessages', id, messages.map(m => m.id)]);
    const c = inbox.get(id);
    if (inboxDown) return unavailable();
    if (!c) return missing();
    return ok({ data: messages.map(m => { const known = c.messages.find(x => x.id === m.id); if (!known) c.messages.push(m); return { id: m.id, seq: c.messages.findIndex(x => x.id === m.id) + 1, created: !known }; }) });
  }
  async mirrorState(id, state) {
    calls.push(['mirrorState', id, state]);
    const c = inbox.get(id);
    if (inboxDown) return unavailable();
    if (!c) return missing();
    c.state = { ...c.state, ...state };
    if (state.ticket && c.status === 'open') c.status = 'ticketed';
    if (state.pauseForTicket && !c.paused) c.paused = 'ticket';
    return ok(inboxState(id, c));
  }
  async inboxState(id) {
    calls.push(['inboxState', id]);
    const c = inbox.get(id);
    if (inboxDown) return unavailable();
    return c ? ok(inboxState(id, c)) : missing();
  }
  async pullOutbox(id) {
    calls.push(['pullOutbox', id ?? null]);
    if (inboxDown) return unavailable();
    return ok({ data: [...inbox].filter(([cid]) => id === undefined || cid === id).flatMap(([cid, c]) => c.outbox.filter(r => !r.delivery).map(r => ({ id: r.id, conversationId: cid, channel: c.channel, text: r.text, staffName: r.staffName, createdAt: r.createdAt }))) });
  }
  async markDelivery(id, messageId, status) {
    calls.push(['markDelivery', id, messageId, status]);
    const reply = inbox.get(id)?.outbox.find(r => r.id === messageId);
    if (!reply) return missing();
    if (reply.delivery === 'sent' && status !== 'sent') return ok({ error: { code: 'SUPPORT_REPLY_DELIVERED' } }, 409);
    reply.delivery = status;
    return ok({ id: messageId, delivery: status, deliveredAt: status === 'sent' ? new Date().toISOString() : null });
  }
  async read(path, grant) {
    calls.push(['read', path, grant === '${GRANT_TOKEN}' ? 'GRANT' : grant]);
    if (grant !== '${GRANT_TOKEN}') return ok({ error: { code: 'SUPPORT_GRANT_REQUIRED' } }, 403);
    const body = READS[path.split('?')[0]];
    return body ? ok(body) : ok({ error: { code: 'NOT_FOUND', message: 'nope' } }, 404);
  }
}
// Idempotency-Key as Nightmail applies it (api/src/idempotency.ts): scoped to the API key and the path; the same key with
// the same body replays the stored result, with a different body it is 409 IDEMPOTENCY_CONFLICT; a refusal stores nothing.
const keys = new Map();
const outages = new Map();
const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
  : value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}' : JSON.stringify(value) ?? 'null';
const failure = outage => Response.json({ error: { code: outage.code } }, { status: outage.status, headers: outage.retryAfter ? { 'retry-after': outage.retryAfter } : {} });
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/__calls') return Response.json(calls);
    // The staff inbox: register a conversation, pause or resume its agent, queue a staff reply, take Nightmail down; and read it.
    if (url.pathname === '/__inbox') {
      if (request.method === 'GET') { const c = inbox.get(url.searchParams.get('id')); return Response.json(c ?? null); }
      const { id, channel, paused, reply, down } = await request.json();
      if (down !== undefined) inboxDown = down;
      if (id && !inbox.has(id)) inbox.set(id, { channel: channel ?? 'chat', status: 'open', paused: null, messages: [], state: {}, outbox: [] });
      const c = id ? inbox.get(id) : null;
      if (c && paused !== undefined) c.paused = paused ? 'staff' : null;
      if (c && reply) { c.outbox.push({ ...reply, createdAt: new Date().toISOString(), delivery: null }); c.paused = 'staff'; }
      return new Response(null, { status: 204 });
    }
    // Test hooks: the person signs in and claims an email conversation; a membership ends; content access is allowed.
    if (url.pathname === '/__claim') {
      const c = conversations.get((await request.json()).conversationId), userId = 'usr_' + c.sender.split('@')[0];
      Object.assign(c, { userId, mode: memberships(userId).length ? 'member' : 'non_member', verification: 'signin' });
      return Response.json(view(c, false));
    }
    if (url.pathname === '/__remove') { const { userId, workspaceId } = await request.json(); members.get(userId)?.delete(workspaceId); members.get(userId)?.set('!' + workspaceId, 'gone'); return new Response(null, { status: 204 }); }
    if (url.pathname === '/__content') { const c = conversations.get((await request.json()).conversationId); c.content = c.workspaceId; return new Response(null, { status: 204 }); }
    if (url.pathname === '/__conversation') { const c = conversations.get(url.searchParams.get('id')); return Response.json(c ? { ...c, read: [...c.read] } : null); }
    // An outage refuses the request; a lost one (lost: true) carries it out, then the answer never arrives (the Worker
    // sees the error status, as when a connection drops after Nightmail committed).
    if (url.pathname === '/__outage') {
      const { path, status, code, retryAfter, lost } = await request.json();
      if (status) outages.set(path, { status, code, retryAfter, lost }); else outages.delete(path);
      return new Response(null, { status: 204 });
    }
    // Test setup: a key already used for another body (a send that committed but whose response never arrived).
    if (url.pathname === '/__used') { const { authorization, path, key, body } = await request.json(); keys.set(authorization + ' ' + path + ' ' + key, { hash: canonical(body), status: 202, result: { id: 'msg_earlier', threadId: path.split('/')[4] } }); return new Response(null, { status: 204 }); }
    const body = request.method === 'POST' ? await request.json() : null;
    const call = ['api', request.method, url.pathname, body, request.headers.get('authorization'), request.headers.get('idempotency-key')];
    calls.push(call);
    const scope = call[5] && request.method === 'POST' ? call[4] + ' ' + url.pathname + ' ' + call[5] : null, stored = scope && keys.get(scope);
    const replayed = !!stored && stored.hash === canonical(body);
    const answer = stored ? (replayed ? Response.json(stored.result, { status: stored.status })
      : Response.json({ error: { code: 'IDEMPOTENCY_CONFLICT', message: 'This Idempotency-Key was already used with a different request. Use a new key for a new request.' } }, { status: 409 }))
      : await route(request, url, body);
    // [6]: the status Nightmail answered, so a test can tell a delivered send from a refused one; [7]: a replay of an
    // earlier request under the same key (nothing new was sent).
    call.push(answer.status, replayed);
    if (scope && !stored && answer.ok) keys.set(scope, { hash: canonical(body), status: answer.status, result: await answer.clone().json() });
    const outage = outages.get(url.pathname);
    return outage?.lost && answer.ok ? failure(outage) : answer;
  },
};
// id → [thread, from, dmarc, to, subject, text]; unknown ids are Ada's Gmail question.
const MESSAGES = {
  msg_mail_1: ['thr_mail_1'], msg_mail_2: ['thr_mail_1'], msg_nodmarc_1: ['thr_nodmarc', null, 'FAIL'], msg_nodmarc_lost: ['thr_nodmarc_lost', null, 'FAIL'], msg_auto_1: ['thr_auto'], msg_image_1: ['thr_image'],
  msg_nodmarc_spoof: ['thr_mail_1', null, 'FAIL', null, 'Refund', 'refund my top-up please'], msg_stranger_1: ['thr_mail_1', 'stranger@else.test'],
  msg_phish_1: ['thr_phish', null, 'PASS', null, 'Reset', 'Please send me the reset link'],
  msg_stranger_cap_1: ['thr_cap_1', 'stranger@else.test'], msg_stranger_cap_2: ['thr_cap_2', 'stranger@else.test'], msg_stranger_cap_3: ['thr_cap_3', 'stranger@else.test'],
  msg_nodmarc_c1: ['thr_c1', null, 'FAIL'], msg_nodmarc_c2: ['thr_c2', null, 'FAIL'],
  msg_abuse_1: ['thr_abuse', 'reporter@isp.test', 'PASS', 'abuse@dev.bane.mx', 'Spam from your customer', 'Your customer sends us spam. Headers attached.'],
  msg_abuse_2: ['thr_abuse', 'reporter@isp.test', 'PASS', 'abuse@dev.bane.mx', 'Re: Spam from your customer', 'More of it today.'],
  msg_abuse_auto_1: ['thr_abuse_auto', 'fbl@isp.test', 'PASS', 'abuse@dev.bane.mx', 'Abuse report', 'Feedback loop report'],
  msg_legal_nodmarc_1: ['thr_legal', 'lawyer@firm.test', 'FAIL', 'legal@dev.bane.mx', 'Subpoena', 'Please preserve records for account X.'],
  msg_v1a: ['thr_v1', 'victim@acme.test', 'FAIL'], msg_v1b: ['thr_v1', 'victim@acme.test', 'FAIL'], msg_v2a: ['thr_v2', 'vera@acme.test', 'FAIL'], msg_v2b: ['thr_v3', 'vera@acme.test', 'FAIL'],
  msg_abuse_s1: ['thr_s1', 's1@spoof.test', 'FAIL', 'abuse@dev.bane.mx', 'Spam 1', 'spam'], msg_abuse_s2: ['thr_s2', 's2@spoof.test', 'FAIL', 'abuse@dev.bane.mx', 'Spam 2', 'spam'],
  msg_abuse_s3: ['thr_s3', 's3@spoof.test', 'FAIL', 'abuse@dev.bane.mx', 'Spam 3', 'spam'], msg_legal_pass_1: ['thr_legal_pass', 'counsel@firm.test', 'PASS', 'legal@dev.bane.mx', 'Subpoena 2', 'Preserve records.'],
  msg_privacy_bcc_1: ['thr_privacy', 'dpo@corp.test', 'PASS', 'someone@corp.test', 'Data request', 'Please export my data.'],
  msg_legal_legacy_1: ['thr_legal_legacy', 'counsel@old.test', 'PASS', 'legal@dev.bane.mx', 'Old request', 'Queued before the address was kept.'],
  msg_image_missing: ['thr_image_missing', 'missing@example.test'], msg_image_unavailable: ['thr_image_unavailable', 'unavailable@example.test'],
  // The conversation work queue's cases.
  msg_stale_1: ['thr_stale'], msg_busy_1: ['thr_busy', 'rita@acme.test'], msg_resend_1: ['thr_resend'], msg_d2: ['thr_d2', 'dora@acme.test', 'FAIL'],
  msg_d3_a: ['thr_d3'], msg_d3_b: ['thr_d3', 'stranger@else.test'], msg_d5: ['thr_d5', null, 'PASS', 'old-support@dev.bane.mx'],
  msg_legacy_answered: ['thr_legacy_a'], msg_legacy_new: ['thr_legacy_a'], msg_legacy_confirmed: ['thr_legacy_a'],
  msg_legacy_waiting: ['thr_legacy_b', 'pat@acme.test', 'FAIL'], msg_legacy_gave_up: ['thr_legacy_c'],
  msg_ticket_throw: ['thr_ticket_throw', null, 'PASS', null, 'Webhook test', 'My webhook test fails with a 500 every time.'],
  msg_ticket_abort: ['thr_ticket_abort', null, 'PASS', null, 'Webhook test', 'My webhook test fails with a 500 every time.'],
  // The staff inbox's cases.
  msg_held_1: ['thr_held'], msg_held_2: ['thr_held'],
  // The work ledger's cases.
  msg_rate_1: ['thr_rate_1', 'rate@else.test'], msg_rate_2: ['thr_rate_2', 'rate@else.test'],
  msg_legal_late_1: ['thr_legal_late', 'counsel@late.test', 'PASS', 'legal@dev.bane.mx', 'Preservation', 'Please preserve the records.'],
  // The stamp's cases: a member who loses the workspace, a DMARC failure that waits for a sign-in, conversations from before.
  msg_shrink_1: ['thr_shrink', 'dee@acme.test'], msg_shrink_2: ['thr_shrink', 'dee@acme.test'], msg_claim_1: ['thr_claim', 'sam@acme.test', 'FAIL'],
  msg_legacy_grant: ['thr_legacy_d'], msg_legacy_lapsed: ['thr_legacy_e'],
};
function message(id) {
  const [threadId = 'thr_other', from = 'ada@acme.test', dmarc = 'PASS', to = 'support@dev.bane.mx', subject = 'Bounces from Gmail?', body = 'Why are Gmail bounces up this week?'] = (MESSAGES[id] ?? []).map(v => v ?? undefined);
  // The receiving address the message is linked to (the one before a move, for old-support@).
  const addressId = to === 'old-support@dev.bane.mx' ? 'adr_old' : to.endsWith('@dev.bane.mx') ? 'adr_' + to.split('@')[0] : 'adr_other';
  return { threadId, from, dmarc, to, subject, body, addressId };
}
async function route(request, url, body) {
  {
    const outage = outages.get(url.pathname);
    if (outage && !outage.lost) return failure(outage);
    // Like Nightmail: inbox keys get an attachment as a short-lived signed link (on Nightmail's origin for R2-stored mail), and
    // never the admin-only parts route.
    if (request.method === 'GET' && /^\\/v1\\/inbound\\/messages\\/[^/]+\\/attachments\\/part_png$/.test(url.pathname)) return Response.json({ url: url.origin + '/v1/objects/fixture-png.sig', expiresAt: new Date(Date.now() + 300_000).toISOString() });
    if (request.method === 'GET' && url.pathname === '/v1/objects/fixture-png.sig') return new Response(Uint8Array.from(atob('${EMAIL_PNG}'), c => c.charCodeAt(0)), { headers: { 'content-type': 'image/png' } });
    if (request.method === 'GET' && /^\\/v1\\/inbound\\/messages\\/[^/]+\\/parts\\//.test(url.pathname)) return Response.json({ error: { code: 'ADMIN_REQUIRED' } }, { status: 403 });
    if (request.method === 'GET' && url.pathname.startsWith('/v1/inbound/messages/') && url.searchParams.get('includeDelivery') === 'true') return Response.json({ error: { code: 'ADMIN_REQUIRED' } }, { status: 403 });
    if (request.method === 'GET' && url.pathname.startsWith('/v1/inbound/messages/')) {
      const id = url.pathname.split('/').pop();
      const { threadId, from, dmarc, to, subject, body, addressId } = message(id);
      const auto = id.includes('auto');
      const attachments = id.startsWith('msg_image_') || id === 'msg_abuse_1' ? [{ id: 'part_png', filename: 'bounce screenshot.png', contentType: 'image/png', size: 300, disposition: 'attachment' }, { id: 'part_pdf', filename: 'invoice.pdf', contentType: 'application/pdf', size: 900, disposition: 'attachment' }] : [];
      const authentication = url.searchParams.get('includeAuthentication') === 'true' ? { authentication: { spf: 'PASS', dkim: null, dmarc }, automated: auto } : {};
      return Response.json({ id, threadId, addressIds: [addressId], direction: 'inbound', subject, from: { name: null, address: from }, to: [to], text: body, replyText: body, messageId: '<' + id + '@mail.test>', ...authentication, attachments });
    }
    if (request.method === 'POST' && url.pathname === '/v1/inbound/threads') return Response.json({ id: 'msg_new', threadId: 'thr_new_' + calls.length }, { status: 202 });
    if (request.method === 'POST' && /^\\/v1\\/inbound\\/threads\\/[^/]+\\/reply$/.test(url.pathname)) {
      // Like Nightmail: an addressId the replied message isn't linked to has no reply target there.
      if (body.addressId && body.addressId !== message(body.replyToMessageId).addressId) return Response.json({ error: { code: 'NOT_FOUND', message: 'There is no visible reply target in this conversation.' } }, { status: 404 });
      return Response.json({ id: 'msg_reply', threadId: url.pathname.split('/')[4] }, { status: 202 });
    }
    return Response.json({ error: { code: 'NOT_FOUND' } }, { status: 404 });
  }
}
`;

// ---------- the scripted model ----------

export type Recorded = { url: string; headers: Record<string, string>; body: any };
export const recorded: Recorded[] = [];
export const control = { failStatus: 0 };

const sse = (events: Array<[string, unknown]>) => new Response(events.map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify({ type, ...(data as object) })}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
const start = (id: string): [string, unknown] => ['message_start', { message: { id, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, usage: { input_tokens: 1200, output_tokens: 1 } } }];
const toolUse = (id: string, name: string, input: object) => sse([
  start('msg_tool'), ['content_block_start', { index: 0, content_block: { type: 'tool_use', id, name, input: {} } }],
  ['content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }], ['content_block_stop', { index: 0 }],
  ['message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 30 } }], ['message_stop', {}],
]);
const text = (chunks: string[]) => sse([
  start('msg_text'), ['content_block_start', { index: 0, content_block: { type: 'text', text: '' } }],
  ...chunks.map(chunk => ['content_block_delta', { index: 0, delta: { type: 'text_delta', text: chunk } }] as [string, unknown]),
  ['content_block_stop', { index: 0 }], ['message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 60 } }], ['message_stop', {}],
]);

const blocks = (message: any): any[] => Array.isArray(message?.content) ? message.content : [{ type: 'text', text: String(message?.content ?? '') }];
/** The latest thing the customer (or the harness) said, ignoring tool results. */
function lastUserText(body: any): string {
  for (const message of [...(body?.messages ?? [])].reverse()) {
    if (message.role !== 'user') continue;
    const said = blocks(message).filter(b => b.type === 'text').map(b => b.text).join('\n');
    if (said) return said;
  }
  return '';
}

export async function fakeGateway(request: Request): Promise<Response> {
  const body = request.method === 'POST' ? await request.json().catch(() => undefined) as any : undefined;
  recorded.push({ url: request.url, headers: Object.fromEntries(request.headers), body });
  if (!new URL(request.url).pathname.endsWith('/messages')) return new Response('not found', { status: 404 });
  // Like a key allowed only the pinned model: anything else is refused.
  if (body?.model !== 'claude-opus-5-5' || body?.output_config?.effort !== 'medium') return Response.json({ type: 'error', error: { type: 'permission_error', message: 'Model access is disabled' } }, { status: 403 });
  if (control.failStatus) return Response.json({ type: 'error', error: { type: 'overloaded_error', message: 'fake failure' } }, { status: control.failStatus });
  const said = lastUserText(body), answered = blocks(body?.messages?.at(-1)).some(b => b.type === 'tool_result');
  const lastUser = [...(body?.messages ?? [])].reverse().find((m: any) => m.role === 'user' && blocks(m).some(b => b.type === 'text'));
  const sawImage = blocks(lastUser).some(b => b.type === 'image');
  if (said.includes('A support email arrived') && said.includes('reset link')) return text(['Hi Ada,\n\nReset it here: https://bane-mx-security.example/reset\n\nNightmail support (AI)']);
  if (said.includes('A support email arrived') && sawImage) return text(['Hi Ada,\n\nI can see your screenshot: it shows a Gmail bounce.\n\nNightmail support (AI)']);
  if (said.includes('screenshot')) return text([sawImage ? 'I can see your screenshot.' : 'I can’t see a screenshot.']);
  if (said.includes('webhook test fails')) {
    // api_errors, then a bug ticket without its reproduction (refused), then the full one, then the answer.
    const used = (body?.messages ?? []).slice((body?.messages ?? []).indexOf(lastUser) + 1).flatMap((m: any) => blocks(m)).filter((b: any) => b.type === 'tool_use').map((b: any) => b.name);
    const lastResult = JSON.stringify(blocks(body?.messages?.at(-1)).filter(b => b.type === 'tool_result'));
    if (!used.length) return toolUse('toolu_e1', 'api_errors', { hours: 24 });
    if (used.length === 1) return toolUse('toolu_e2', 'file_ticket', { type: 'bug', title: 'Webhook test returns 500 for every endpoint', severity: 'P2', summary: 'Webhook tests fail with 500.', ask: 'My webhook test fails', tried: ['api_errors: 14 × 500 INTERNAL_ERROR'], recommendation: 'Look at the webhook test handler.' });
    if (used.length === 2 && lastResult.includes('needs reproSteps')) return toolUse('toolu_e3', 'file_ticket', { type: 'bug', title: 'Webhook test returns 500 for every endpoint', severity: 'P2',
      summary: 'Every POST /v1/webhooks/{id}/test returns 500 since this morning. 14 failures in 2 hours, all INTERNAL_ERROR. The customer wants their webhooks tested.', ask: 'My webhook test fails',
      tried: ['api_errors: 14 × 500 INTERNAL_ERROR on POST /v1/webhooks/:id/test'], recommendation: 'Check the webhook test handler against req_' + 'a'.repeat(32) + '.',
      reproSteps: ['Open Webhooks', 'Press Send test on any endpoint'], affected: 'POST /v1/webhooks/{id}/test', requestIds: ['req_' + 'a'.repeat(32), 'req_' + 'b'.repeat(32)], errorCodes: ['500 INTERNAL_ERROR'],
      expected: 'A test delivery', actual: 'HTTP 500' });
    return text(['That’s a Nightmail bug: I’ve passed it to the Nightmail team.']);
  }
  if (said.includes('someone else')) {
    // Arguments a tool never declares (another user, conversation, grant), then another customer's workspace.
    const used = (body?.messages ?? []).slice((body?.messages ?? []).indexOf(lastUser) + 1).flatMap((m: any) => blocks(m)).filter((b: any) => b.type === 'tool_use').length;
    if (used === 0) return toolUse('toolu_o1', 'bounce_reasons', { provider: 'gmail', userId: 'usr_bo', conversationId: 'conv_' + 'b'.repeat(26), grant: 'nm_support_' + '9'.repeat(64), token: 'tok_other' });
    if (used === 1) return toolUse('toolu_o2', 'list_domains', { workspaceId: 'ws_other' });
    return text(['I can only look at your own account.']);
  }
  if (said.includes('A support email arrived')) return answered ? text(['Hi Ada,\n\nGmail hard-bounced 61 of 1,000 sends this week.\n\nNightmail support (AI)']) : toolUse('toolu_e', 'bounce_reasons', { provider: 'gmail' });
  if (said.includes('Gmail bounces')) return answered ? text(['Gmail hard-bounced 61 of 1,000 sends (6.1%). Here’s what I’d do:\n\n1. Remove the import from Oct 25.']) : toolUse('toolu_b', 'bounce_reasons', { provider: 'gmail', days: 7 });
  if (said.includes('refund')) return answered ? text(['I’ve passed this to the Nightmail team. Someone will reply by email.']) : toolUse('toolu_t', 'file_ticket', {
    type: 'billing', topic: 'refund', title: 'Duplicate $25 top-up', severity: 'P3', summary: 'Ada asks for a refund of a duplicate top-up. The ledger shows two identical top-ups. She wants one refunded.', ask: 'Please refund my duplicate top-up',
    tried: ['get_billing: two $25 top-ups 40 s apart'], recommendation: 'Refund the second $25 top-up (billing error).', evidence: ['req_1'] });
  if (said.includes('look at the content')) return answered ? text(['I’ve asked for access to read that email.']) : toolUse('toolu_c', 'request_content_access', { why: 'To check why the screen rejected your promo, I need to read its HTML.' });
  if (said.includes('leak please')) return text([`Sure: bane_ops_${'a'.repeat(64)}`]);
  return text(['OK.']);
}
