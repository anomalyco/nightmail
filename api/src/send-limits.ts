import { Buffer } from 'node:buffer';
import { BUILTIN_CAPS } from './builtin-limits.js';
import { ATTACHMENT_CAPS } from './attachment-limits.js';

/**
 * Every limit a send is admitted against, defined once. The admission decision (send_admission, migration 323)
 * receives them as parameters, so SQL repeats none of these numbers; the dispatcher and the advisory sendability
 * score read the same values.
 */
export const SEND_LIMITS = {
  /** Outstanding (queued or attempting) direct mail per workspace: a day of what it may send within these bounds. That
   * is the account's own SES quota (BYO), or a Hosted workspace's pace in good standing (a quarter of its pool's SES
   * rate a minute, at least 500); during the evaluation, the growth pace or under a daily limit Hosted gets the floor,
   * exempt the ceiling, unless an operator overrides it. Not a volume cap: it bounds the dispatch queue (queued rows are
   * the queue) so one workspace's backlog drains within a day and never fills the database. */
  pendingFloor: 10_000,
  pendingCeiling: 200_000,
  /** Recipients in a rolling 24 hours from which Hosted transactional mail needs aligned DMARC, as marketing always does. */
  bulkVolume: 5_000,
  /** DMARC facts older than this are not evidence. */
  dmarcMaxAgeHours: 48,
  /** SES's limit on an attachment's MIME type and content ID, in printable ASCII characters. */
  mimeFieldChars: ATTACHMENT_CAPS.mimeFieldChars,
  /** Decoded attachments per message (so also per attachment). SES v2 takes messages up to 40 MB after base64
   * encoding (https://docs.aws.amazon.com/ses/latest/dg/quotas.html); base64 with MIME line breaks grows a file by
   * 4/3 × 78/76 (about 37%), so 25 MiB of files is about 36 MB on the wire and leaves room for the body and headers. */
  attachmentBytes: ATTACHMENT_CAPS.attachmentBytes,
  /** A file sent as base64 inside a JSON request (uploadAttachment's JSON body, inbox mail's inline content, MCP): the
   * request text, the parsed string and the decoded bytes are all held at once, so these stay at 8 MiB decoded.
   * Larger files upload as raw bytes (POST /v1/attachments/upload). */
  jsonAttachmentBytes: ATTACHMENT_CAPS.jsonAttachmentBytes,
  /** Uploaded attachment bytes one workspace keeps at once (sending_asset_usage). */
  storedAttachmentBytes: ATTACHMENT_CAPS.storedAttachmentBytes,
  /** Files per message: sends, batch items, campaigns and templates, inbox mail, the SMTP relay and forwards. The bytes are
   * bounded by attachmentBytes together; the dispatcher reads each file from storage once (cached), one subrequest each,
   * far inside a Worker invocation's 10,000, and inbound mail parses as many (mailbox-ingest.ts MAX_ATTACHMENTS). */
  attachments: ATTACHMENT_CAPS.attachments,
  /** The html and text of one batch's messages together, in characters. The request itself stays bounded at 12 MiB
   * (request-body.ts), so this is what lets a batch of 100 ordinary 30-100 KB HTML emails through. */
  batchContentChars: 10 * 1024 * 1024,
  /** What the content screen reads (screen.ts): the default screened-text limits in UTF-8 bytes per message and per
   * campaign copy (JEV_MESSAGE_LIMIT_BYTES and JEV_CAMPAIGN_LIMIT_BYTES override them), and the link hosts every
   * classifier request repeats, by count and by bytes. */
  screen: { messageBytes: 64 * 1024, campaignBytes: 128 * 1024, linkHosts: 150, linkHostBytes: 3000 },
  /** The estimated encoded message (estimatedMimeBytes) may not pass SES's own maximum: 40 MB after encoding. */
  encodedBytes: 40_000_000,
  /** Attachment and body bytes one dispatcher lane prepares at once; a larger message is a page of its own. */
  laneBytes: 8 * 1024 * 1024,
  /** What every large-attachment path in one isolate may hold at once (isolate-memory.ts): with the loaded app's
   * ~25 MB this keeps a Worker isolate under ~90 MB of its 128 MB. */
  isolateWorkingBytes: 64 * 1024 * 1024,
  /** Verified attachment bytes an isolate keeps for the next message that sends them (sending/mime.ts verifiedAttachment). Part
   * of isolateWorkingBytes, not beside it: a reservation that needs their room drops them first. */
  attachmentCacheBytes: 32 * 1024 * 1024,
  /** How the encoded size is estimated: body parts grow by bodyFactor, each attachment is base64 grown by lineFactor
   * plus perAttachment of headers, and the message adds envelope. */
  mime: { bodyFactor: 1.4, lineFactor: 1.04, perAttachment: 2048, envelope: 16384 },
  /** Outstanding campaign recipients per workspace and per sender key. */
  campaignPendingWorkspace: 4_000_000,
  campaignPendingKey: 2_000_000,
  /** Scheduled single sends (sendEmail scheduledAt): at most 30 days ahead, as long as the email's log and events are
   * kept, so a scheduled email is visible for its whole wait (longer plans are campaigns, up to a year); up to a minute
   * in the past for a sender's clock (it then sends at once); and how many may wait per workspace. */
  schedule: { horizonSeconds: 30 * 86_400, skewSeconds: 60, workspace: 100_000 },
  /** A built-in domain's recipients in a minute and in a rolling 24 hours (builtin-domain.ts), for each send scope
   * (NIGHTMAIL_BUILTIN_SEND_SCOPE): anyone, or only the workspace members' own verified addresses. */
  builtin: BUILTIN_CAPS,
} as const;

/** UTF-8 bytes of the parts a message's MIME carries, counted without copying them. A message sent as written (mime)
 *  carries its own bytes; its html and text are what it shows, counted too, as an upper bound. */
export const contentBytes = (parts: { raw?: string; mime?: string; html?: string; text?: string; subject?: string }) =>
  [parts.raw, parts.mime, parts.html, parts.text, parts.subject].reduce<number>((n, part) => n + (part ? Buffer.byteLength(part) : 0), 0);
/** A conservative estimate of the encoded message: base64/MIME expansion, line folding and headers. */
export function estimatedMimeBytes(parts: { raw?: string; mime?: string; html?: string; text?: string; subject?: string }, rows: { size: number }[]) {
  const { bodyFactor, lineFactor, perAttachment, envelope } = SEND_LIMITS.mime;
  return Math.ceil(Math.ceil(contentBytes(parts) * bodyFactor) + rows.reduce((sum, r) => sum + Math.ceil(r.size / 3) * 4 * lineFactor + perAttachment, 0) + envelope);
}
