import { DurableObject } from 'cloudflare:workers';
import { AGENT_PRESENCE_MS, ROOM_PEER_HEADER, ROOM_READMIT, type RoomAgent, type RoomPerson } from './campaign-room-protocol.js';

// One room per campaign (roomName): who has its Write or Review page open, and which agents worked on it in the last two
// minutes. The API admits a person (GET /v1/campaigns/{id}/room in campaigns/routes.ts: a dashboard session that can read the
// campaign, from the dashboard's Origin) and forwards the upgrade with them in ROOM_PEER_HEADER; nothing else reaches
// the object. People live on their sockets (serializeAttachment), so the room hibernates between events and costs
// nothing while nobody joins or leaves. Agents, who hold no socket, are reported only while someone is here (visit),
// and kept in storage only until the room is empty.
//
// An admission lasts ADMISSION_MS. Before the room sends anything to a socket past it, it closes that socket
// (ROOM_READMIT) and the tab joins again through the API, so a person whose session ended or who left the workspace
// receives nothing more.
//
// Room → browser, JSON text frames (unknown types and fields are ignored, so the room can add them):
//   { v: 1, type: 'hello', you, self, peers }  on connect: this socket's slot, this person's key, and everyone else
//                                              (an agent's ago: milliseconds since it was seen, so no clocks compare)
//   { v: 1, type: 'join', peer }          a person opened the campaign (peer: their key, name, view and slot)
//   { v: 1, type: 'leave', slot }         that tab closed or went away
//   { v: 1, type: 'agent', peer }         an agent read or saved the campaign (saved: the revision it saved, when it
//                                         saved)
// What a person sees of others: names, never user IDs (keys are per room), and an agent's name only if they may see
// API keys and MCP clients in Settings (owners and admins); everyone else sees "An agent".
// Browser → room: 'ping' about every 30 s, answered 'pong' by the runtime without waking the room, and while anyone else
// is here, binary frames of 1 to 15 bytes, at most 60 a second (more are dropped): [kind][big-endian u16 …]. The room
// sends each one on to everyone else at once, after the sender's slot: [slot][kind][…]. Kinds (presence-overlay.tsx):
//   1 pointer at x, y: x in 1/16384 of the sheet's width from its left edge, y in px from its top, both + 32768
//   4 pointer gone
//   2 selection: block, from, to (0xffff: none)   3 field (0xffff: none)
//   5 saved: this tab saved the draft at a revision (two u16: high, low), so the others read it now
// Any other frame closes the socket.
type Slotted = RoomPerson & { slot: number };
type Visit = { id: string; name: string };
const MAX_SOCKETS = 50, MAX_PER_PERSON = 5, AGENT = 'An agent', MAX_FRAME = 15, FRAMES_PER_SECOND = 60;

export class CampaignRoom extends DurableObject<Env> {
  // Frames each socket sent in the current second; reset when the room hibernates, which is when nobody is sending.
  private rate = new Map<WebSocket, { second: number; frames: number }>();
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  // The sockets still admitted. One past its admission is closed now, so it is sent nothing more.
  private sockets(now = Date.now()) {
    return this.ctx.getWebSockets().flatMap(ws => {
      const peer = ws.deserializeAttachment() as Slotted | null;
      if (!peer) return [];
      if (peer.until <= now) { try { ws.close(ROOM_READMIT, 'Join again'); } catch { /* closing */ } return []; }
      return [{ ws, peer }];
    });
  }
  private agents(now = Date.now()) {
    return (this.ctx.storage.kv.get<RoomAgent[]>('agents') ?? []).filter(agent => now - agent.at < AGENT_PRESENCE_MS);
  }
  private shown = (agent: RoomAgent, to: Slotted) => to.names ? agent : { ...agent, name: AGENT };
  private send(ws: WebSocket, message: object) { try { ws.send(JSON.stringify({ v: 1, ...message })); } catch { /* closing */ } }
  private person = ({ kind, id, name, view, slot }: Slotted) => ({ kind, id, name, view, slot });

  override async fetch(request: Request): Promise<Response> {
    const raw = request.headers.get(ROOM_PEER_HEADER);
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket' || !raw) return new Response(null, { status: 400 });
    const person = JSON.parse(decodeURIComponent(raw)) as RoomPerson;
    const now = Date.now(), here = this.sockets(now);
    if (here.length >= MAX_SOCKETS || here.filter(item => item.peer.id === person.id).length >= MAX_PER_PERSON) return new Response(null, { status: 429 });
    const taken = new Set(here.map(item => item.peer.slot));
    let slot = 1; while (taken.has(slot)) slot++;
    const peer: Slotted = { ...person, slot };
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(peer);
    const agents = this.agents(now).map(agent => ({ ...this.shown(agent, peer), ago: now - agent.at }));
    this.send(server, { type: 'hello', you: slot, self: peer.id, peers: [...here.map(item => this.person(item.peer)), ...agents] });
    for (const item of here) this.send(item.ws, { type: 'join', peer: this.person(peer) });
    return new Response(null, { status: 101, webSocket: client });
  }

  /** An agent read or saved the campaign (campaigns/views.ts, after its response); saved is the revision its save made. With
   *  nobody here it does nothing and says so (false), so the API can stop asking for a while; name is only looked up
   *  once someone is (resolve). */
  async visit(agent: Visit | { id: string; name?: undefined }, saved?: number): Promise<boolean> {
    const now = Date.now(), here = this.sockets(now);
    if (!here.length) return false;
    if (agent.name === undefined) return true;
    const seen: RoomAgent = { kind: 'agent', id: agent.id, name: agent.name, at: now };
    this.ctx.storage.kv.put('agents', [...this.agents(now).filter(item => item.id !== agent.id), seen]);
    for (const item of here) { const peer = this.shown(seen, item.peer); this.send(item.ws, { type: 'agent', peer: saved === undefined ? peer : { ...peer, saved } }); }
    return true;
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const peer = ws.deserializeAttachment() as Slotted | null;
    const bytes = typeof message === 'string' ? null : new Uint8Array(message);
    if (!peer || !bytes || !bytes.length || bytes.length > MAX_FRAME || bytes[0]! < 1 || bytes[0]! > 5) { ws.close(1003, 'Unsupported message'); return; }
    // A sender past its admission joins again before anyone hears from it.
    const now = Date.now();
    if (peer.until <= now) { ws.close(ROOM_READMIT, 'Join again'); return; }
    const second = Math.floor(now / 1000), rate = this.rate.get(ws);
    if (rate?.second === second) { if (++rate.frames > FRAMES_PER_SECOND) return; } else this.rate.set(ws, { second, frames: 1 });
    const framed = new Uint8Array(bytes.length + 1);
    framed[0] = peer.slot; framed.set(bytes, 1);
    for (const item of this.sockets(now)) if (item.ws !== ws) try { item.ws.send(framed); } catch { /* closing */ }
  }
  override async webSocketClose(ws: WebSocket) { this.left(ws); }
  override async webSocketError(ws: WebSocket) { this.left(ws); }
  private left(ws: WebSocket) {
    this.rate.delete(ws);
    const peer = ws.deserializeAttachment() as Slotted | null;
    const rest = this.sockets().filter(item => item.ws !== ws);
    if (peer) for (const item of rest) this.send(item.ws, { type: 'leave', slot: peer.slot });
    // The last one out: nothing is kept for an empty room.
    if (!rest.length) this.ctx.storage.kv.delete('agents');
  }
}
