// Shared support platform RPC & operator support inbox contract (zero external dependencies).
// Imported directly by api/, support/ (which builds without api/node_modules), and app/.
// api/src/support-inbox.ts and api/src/support-platform.ts assert compile-time lockstep with the Zod schemas and RPC implementation.

/** The ticket types the support platform files. */
export const TICKET_TYPES = ['billing', 'bug', 'deliverability', 'account', 'abuse_report', 'privacy', 'legal', 'feature_request', 'other'] as const;
export type TicketType = (typeof TICKET_TYPES)[number];

export const HELD_REASONS = ['paused', 'gate', 'access', 'closed', 'earlier'] as const;
export type HeldReason = (typeof HELD_REASONS)[number];

export const EVENT_KINDS = ['opened', 'ticket', 'priority', 'paused', 'resumed', 'resolved', 'done', 'undone', 'closed', 'approved', 'declined', 'action', 'proposed'] as const;
export type SupportEventKind = (typeof EVENT_KINDS)[number];

export const TRIAGE_REASONS = ['ticket', 'blocked', 'failed', 'paused', 'no_reply'] as const;
export type TriageReason = (typeof TRIAGE_REASONS)[number];

export type SupportAuthor = 'customer' | 'agent' | 'staff' | 'system';
export type SupportDelivery = 'queued' | 'sent' | 'failed' | 'held';
/** agent_feedback: a report an agent filed with sendFeedback (api/src/feedback.ts); nobody to reply to. */
export type SupportChannel = 'chat' | 'email' | 'agent_feedback';
export type SupportMode = 'member' | 'non_member' | 'pending_signin' | 'unverified';
export type SupportVerification = 'handoff' | 'dmarc' | 'signin' | 'none' | 'agent';
export type SupportInboxVerification = SupportVerification | 'credential';
export type SupportStatus = 'open' | 'ticketed' | 'closed';

/** The ticket brief the agent filed: its summary of the conversation and what it checked. */
export type Brief = {
  title: string;
  summary: string;
  ask: string;
  recommendation: string;
  tried?: { tool: string; finding: string }[];
};

export type SupportTicket = { id: string; type: string | null; severity: string | null; resolvedAt: string | null };

// ---------- SupportPlatform service-binding RPC DTOs ----------

export type PlatformReply<T = unknown> = { status: number; body: T; requestId: string | null; retryAfter: string | null };

export type HandoffClaims = {
  id: string; kind: string; userId: string; email: string; role: string; workspace: { id: string; name: string };
  page: string | null; requestIds: string[]; shareContent: boolean; issuedAt: string; expiresAt: string;
};
export type Handoff = HandoffClaims & { usedAt: string | null; message: string | null };
export type HandoffCheck =
  | { ok: true; handoff: Handoff }
  | { ok: false; code: 'HANDOFF_INVALID' | 'HANDOFF_EXPIRED' | 'HANDOFF_NOT_FOUND' | 'SUPPORT_NOT_CONFIGURED' };

/** How the support platform knows who a conversation is for: Nightmail checks each itself. */
export type ConversationEvidence = { kind: 'handoff'; token: string } | { kind: 'email'; messageId: string };
/** A registration's answer (POST /v1/operator/support/conversations): Nightmail's decision about the conversation. */
export type RegisteredConversation = {
  id: string; channel: 'chat' | 'email'; mode: SupportMode; verification: SupportVerification;
  status: SupportStatus; workspaceId: string | null; contentShared: boolean; created: boolean;
  /** Email only: the message passed the sender checks a general answer needs (api/src/support-conversations.ts emailEvidence). */
  generalAnswer?: boolean;
};

/** A transcript entry the support platform mirrors into the inbox (api/src/support-inbox.ts). Staff replies come from the inbox. */
export type MirroredMessage = {
  id: string; author: 'customer' | 'agent' | 'system'; kind?: string | null; text: string;
  tools?: { label: string; ok: boolean }[]; attachments?: string[];
  files?: { id: string; name: string; type: string; size: number }[];
  source?: string; delivery?: 'sent' | 'failed' | 'held'; reason?: HeldReason; at?: string;
};

/** What the support platform mirrors about a conversation; each field is optional. */
export type MirroredState = {
  subject?: string;
  ticket?: { id: string; type: TicketType; severity: 'P1' | 'P2' | 'P3'; brief?: Brief };
  turns?: number; costUsd?: number; blockedWork?: number; pauseForTicket?: true;
};

/** A conversation's inbox state as the support platform needs it: check agentState before every turn and every send. */
export type InboxState = {
  id: string; status: SupportStatus; agentState: 'active' | 'paused';
  pausedBy: 'staff' | 'ticket' | null; pausedAt: string | null;
  ticket: SupportTicket | null; queuedReplies: number;
};

/** A staff reply waiting for delivery. */
export type OutboxReply = { id: string; conversationId: string; channel: 'chat' | 'email'; text: string; staffName: string | null; createdAt: string };

/** An email whose sender asked, from its sign-in link, to be answered by email instead (api/src/support-conversations.ts releaseGeneralAnswer). */
export type GeneralAnswerDue = { conversationId: string; messageId: string; requestedAt: string };

/**
 * A chat as Nightmail holds it (GET /v1/operator/support/conversations/{id}/filed): `filed` when Nightmail opened it from
 * a filed message and the support platform never registered it; `messages` the customer's filed messages, oldest first.
 */
export type FiledConversation = {
  id: string; status: SupportStatus; filed: boolean; user: { id: string; name: string | null; email: string | null };
  workspace: { id: string; name: string; role: 'owner' | 'admin' | 'member' } | null;
  page: string | null; requestIds: string[]; messages: { id: string; text: string; at: string }[];
};

/** A staff email the support platform sends (api/src/support-staff-mail.ts): a new thread, or a reply in threadId under replyToMessageId. */
export type StaffEmail = { key: string; threadId: string | null; replyToMessageId: string | null; subject: string; text: string; html: string };

/** Why a reply to a staff email became no note (api/src/support-staff-mail.ts). */
export type StaffReplyIgnored = 'unverified' | 'not_staff' | 'no_conversation' | 'empty' | 'automated' | 'limited';
/** What Nightmail made of a reply to a staff email (api/src/support-staff-mail.ts staffReply). */
export type StaffReply = { reply: false } | { reply: true; notes: number; ignored: StaffReplyIgnored | null };

/** An agent feedback report the triage agent reads (api/src/feedback-triage.ts): text is untrusted, as its filer wrote it. */
export type FeedbackReport = { conversationId: string; ticketId: string; filedAt: string; operation: string | null; requestId: string | null; text: string };
/** The triage agent's note on a report: its words, a suggested classification, and earlier reports from the same workspace. */
export type TriageNoteInput = { summary: string; cause: string; classification: 'bug' | 'docs_gap' | 'neither' | 'question'; duplicates: string[] };
/** An agent's report that asks something, to answer by email: the person's own conversation, its first message the report (untrusted). */
export type AgentAnswer = {
  conversationId: string; messageId: string; reportConversationId: string; filedAt: string;
  credential: 'apiKey' | 'agentToken' | 'mcp' | 'dashboard'; credentialEnd: string | null;
  subject: string | null; text: string;
  person: { userId: string; email: string; name: string | null }; workspace: { id: string; name: string };
};

/** The methods of Nightmail's SupportPlatform WorkerEntrypoint, shared between api/src/worker.ts and support/src/nightmail.ts. */
export interface SupportPlatformRpc {
  verifyWake(token: string, conversationId: string): Promise<boolean>;
  verifyFile(token: string, conversationId: string, attachmentId: string): Promise<boolean>;
  verifyHandoff(token: string): Promise<HandoffCheck>;
  registerConversation(body: { conversationId: string; evidence: ConversationEvidence }): Promise<PlatformReply<RegisteredConversation>>;
  closeConversation(conversationId: string): Promise<PlatformReply<{ id: string; status: 'closed'; closedAt: string }>>;
  request<T = unknown>(conversationId: string, method: string, path: string, body?: unknown): Promise<PlatformReply<T>>;
  mirrorMessages(conversationId: string, messages: MirroredMessage[]): Promise<PlatformReply<{ data: { id: string; seq: number; created: boolean }[] }>>;
  mirrorState(conversationId: string, state: MirroredState): Promise<PlatformReply<InboxState>>;
  inboxState(conversationId: string): Promise<PlatformReply<InboxState>>;
  pullOutbox(conversationId?: string): Promise<PlatformReply<{ data: OutboxReply[] }>>;
  generalAnswers(conversationId?: string): Promise<PlatformReply<{ data: GeneralAnswerDue[] }>>;
  filedConversation(conversationId: string): Promise<PlatformReply<FiledConversation>>;
  markDelivery(conversationId: string, messageId: string, status: 'sent' | 'failed'): Promise<PlatformReply<{ id: string; delivery: 'sent' | 'failed'; deliveredAt: string | null }>>;
  staffMail(): Promise<PlatformReply<{ data: StaffEmail[] }>>;
  staffMailSent(key: string, sent: { threadId: string; messageId: string }): Promise<PlatformReply<{ key: string; sentAt: string }>>;
  staffMailFailed(key: string, failed: { code: string }): Promise<PlatformReply<{ key: string; attempts: number; failed: boolean; sent: boolean }>>;
  staffMailReply(messageId: string, team: string | null): Promise<PlatformReply<StaffReply>>;
  feedbackDue(limit: number): Promise<PlatformReply<{ data: FeedbackReport[] }>>;
  feedbackRequest(conversationId: string, requestId: string): Promise<PlatformReply>;
  feedbackRelated(conversationId: string): Promise<PlatformReply>;
  feedbackTriage(conversationId: string, note: TriageNoteInput): Promise<PlatformReply<{ conversationId: string; ticketId: string | null; messageId: string; classification: string; createdAt: string }>>;
  feedbackUsage(conversationId: string, usage: { turns: number; costUsd: number }): Promise<PlatformReply<{ conversationId: string; turns: number; costUsd: number }>>;
  agentAnswersDue(limit: number): Promise<PlatformReply<{ data: AgentAnswer[] }>>;
}

// ---------- Operator Support Inbox DTOs (/v1/operator/support-inbox) ----------

export type SupportEmail = {
  id: string; subject: string;
  from: { name: string | null; address: string };
  to: { name: string | null; address: string }[];
  cc: { name: string | null; address: string }[];
  receivedAt: string; text: string; replyText: string; textTruncated: boolean; hiddenContent: boolean; hasHtml: boolean;
  attachments: { id: string; filename: string; contentType: string; size: number; inline: boolean; available: boolean }[];
};

export type SupportEmailFull = {
  id: string; text: string; replyText: string; html: string | null; htmlTooComplex: boolean; bodyTruncated: boolean; hiddenContent: boolean;
};

export type SupportMessage = {
  id: string; seq: number; author: SupportAuthor; kind: string | null; text: string;
  tools: { label: string; ok: boolean }[]; attachments: string[];
  /** viaAgent: their own agent wrote it for them (api/src/support-agents.ts); the customer never sees this. */
  staff: { userId: string; name: string | null; viaAgent: boolean } | null;
  /** A note that came by email (a staff member's reply to a staff email): the verified address it came from. */
  emailFrom: string | null; delivery: SupportDelivery | null; heldReason: HeldReason | null;
  files: { id: string; name: string | null; type: string | null; size: number | null }[];
  email: SupportEmail | null; deliveredAt: string | null; at: string;
  draft: { outcome: 'sent' | 'edited' | 'replaced' | 'discarded'; by: { userId: string; name: string | null }; at: string; replyId: string | null } | null;
};

export type SupportEvent = {
  id: string; kind: SupportEventKind; by: { userId: string; name: string | null } | null; details: Record<string, unknown>; at: string;
};

/** A one-click decision a staff email linked to (api/src/support-approvals.ts): only a signed-in operator's confirm runs it. */
export type SupportApproval = {
  id: string; conversationId: string; kind: string; label: string; effect: string; risky: boolean;
  /** An agent's risky proposal: its exact target in Nightmail's words, with its numbers. */
  summary: string | null; reason: string; proposedBy: 'nightmail' | 'agent';
  state: 'proposed' | 'approved' | 'declined' | 'failed' | 'expired';
  createdAt: string; expiresAt: string; decidedAt: string | null;
  decidedBy: { userId: string; name: string | null } | null;
  result: Record<string, unknown> | null;
  /** A limit or balance it changes: its value now (read when opened) and after approving. */
  change: { now: string; after: string } | null;
  /** Send the held answer: exactly what would go, and why it can't, when it can't. */
  preview: { text: string | null; held: string | null; blocked: string | null } | null;
};

export type SupportWorkspace = {
  id: string; name: string; role: string; joinedAt: string; createdAt: string; members: number;
  inScope: boolean; contentShared: boolean;
  sending: { kind: string; region: string | null; paused: boolean } | null;
  standing: string | null;
};

export type SupportConversation = {
  id: string; channel: SupportChannel; mode: SupportMode; verification: SupportInboxVerification;
  status: SupportStatus; subject: string | null;
  customer: { userId: string; name: string | null; email: string | null } | null;
  sender: string | null;
  workspace: { id: string; name: string } | null;
  filedBy: string | null;
  ticket: SupportTicket | null;
  agentState: 'active' | 'paused';
  pausedBy: { kind: 'staff' | 'ticket'; userId: string | null; name: string | null } | null;
  pausedAt: string | null;
  lastAuthor: SupportAuthor | null; needsReply: boolean;
  preview: { author: SupportAuthor; text: string; held: boolean } | null;
  messageCount: number; queuedReplies: number; turns: number; costUsd: number; blockedWork: number;
  firstLine: string | null;
  needsYou: { reasons: TriageReason[]; urgent: boolean; since: string } | null;
  done: { at: string; userId: string; name: string | null } | null;
  unread: boolean; createdAt: string; lastMessageAt: string | null; closedAt: string | null;
};

export type SupportDetail = {
  conversation: SupportConversation & {
    threadId: string | null; page: string | null; contentWorkspaceId: string | null;
    evidence: {
      handoff: string | null; message: string | null; dmarc: string | null; dkimAligned: boolean | null; claimedAt: string | null;
      /** Agent feedback: the key, sign-in or token that filed it (api/src/feedback.ts), and its ID. */
      filedBy: string | null; credentialId: string | null;
    };
  };
  messages: SupportMessage[]; earlierMessages: number; events: SupportEvent[]; brief: Brief | null;
  replyTarget: { address: string | null; verified: boolean };
  customer: {
    user: { id: string; name: string | null; email: string | null; emailVerified: boolean; createdAt: string } | null;
    workspaces: SupportWorkspace[];
    conversations: { id: string; channel: string; mode: string; verification: string; status: string; subject: string | null; ticket: SupportTicket | null; createdAt: string; lastMessageAt: string | null }[];
    activity: { id: string; at: string; action: string; workspaceId: string | null; actorType: string; via: string; internal: boolean; summary: Record<string, unknown> }[];
    notes: { id: string; text: string; author: 'agent' | 'staff'; workspaceId: string | null; conversationId: string; createdAt: string }[];
  };
  replyAvailable: boolean;
};

export type InboxCounts = { needsYou: number; agent: number; waiting: number };
export type SupportInboxPage = { data: SupportConversation[]; nextCursor: string | null; replyAvailable: boolean; counts: InboxCounts };
