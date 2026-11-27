import { dashboardReference } from './dashboard-reference.js';
import { webhookSignatureGuide } from './webhook-signature-guide.js';
import { builtinDomainGuide } from './builtin-limits.js';
import { agentSetupGuide } from './agent-setup-guide.js';
import type { App } from './core.js';
import { apiKeyEnv, productName, publicOrigin, sdkPackage } from './brand.js';
import { permissionExtension, permissionOf } from './operation-permissions.js';
import { describeBody, responseRows, schemaType, type Field } from './schema-fields.js';

type Json = Record<string, any>;
const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

function resolve(document: Json, schema: Json | undefined, seen = new Set<string>()): Json {
  if (!schema) return {};
  if (typeof schema.$ref !== 'string') return schema;
  if (seen.has(schema.$ref)) return {};
  seen.add(schema.$ref);
  const [, , section, name] = schema.$ref.split('/');
  return resolve(document, document.components?.[section]?.[name], seen);
}

function sampleString(name: string, schema: Json): string {
  if (schema.const !== undefined) return String(schema.const);
  if (Array.isArray(schema.enum) && schema.enum.length) return String(schema.enum[0]);
  if (typeof schema.default === 'string') return schema.default;
  if (typeof schema.example === 'string') return schema.example;
  if (/^from$/i.test(name)) return 'sender@example.com';
  if (schema.format === 'email' || /^(?:to|email|replyTo)$/i.test(name)) return 'recipient@example.com';
  if (schema.format === 'date-time' || /(?:At|Date)$/i.test(name)) return '2026-09-18T19:00:00Z';
  if (schema.format === 'uri' || /url$/i.test(name)) return 'https://example.com/webhook';
  if (/region/i.test(name)) return 'us-east-1';
  if (/subject/i.test(name)) return `Hello from ${productName}`;
  if (/html/i.test(name)) return '<h1>Hello</h1><p>Your message is ready.</p>';
  if (/text|markdown|description|purpose/i.test(name)) return 'Your message is ready.';
  if (/name/i.test(name)) return 'Example';
  if (/filename/i.test(name)) return 'document.pdf';
  if (/contentType/i.test(name)) return 'application/pdf';
  if (/contentId/i.test(name)) return 'asset';
  if (/idempotency/i.test(name)) return 'request-123';
  if (/id$/i.test(name)) return `${name.replace(/Id$/i, '').toLowerCase() || 'resource'}_123`;
  if (schema.pattern?.includes('^[a-z0-9-]')) return 'example';
  return 'example';
}

function sample(document: Json, input: Json | undefined, name = 'value', depth = 0): any {
  if (depth > 8) return undefined;
  const schema = resolve(document, input);
  const union = schema.oneOf ?? schema.anyOf;
  if (Array.isArray(union) && union.length) return sample(document, union[0], name, depth + 1);
  if (Array.isArray(schema.type)) {
    const type = schema.type.find((value: string) => value !== 'null');
    return sample(document, { ...schema, type }, name, depth + 1);
  }
  if (schema.const !== undefined) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  if (schema.default !== undefined) return schema.default;
  // A body whose fields are all optional documents one that does something.
  if (schema.example !== null && typeof schema.example === 'object') return schema.example;
  if (schema.type === 'string' || schema.format || schema.pattern) return sampleString(name, schema);
  if (schema.type === 'integer' || schema.type === 'number') return schema.minimum ?? (schema.exclusiveMinimum !== undefined ? Number(schema.exclusiveMinimum) + 1 : 1);
  if (schema.type === 'boolean') return false;
  if (schema.type === 'array') return [sample(document, schema.items, name.replace(/s$/, ''), depth + 1)].filter(value => value !== undefined);
  if (schema.type === 'object' || schema.properties) {
    const required = new Set<string>(schema.required ?? []);
    return Object.fromEntries(Object.entries<Json>(schema.properties ?? {}).filter(([key, value]) => required.has(key) || value.default !== undefined).map(([key, value]) => [key, sample(document, value, key, depth + 1)]).filter(([, value]) => value !== undefined));
  }
  return undefined;
}

function parameters(document: Json, pathItem: Json, operation: Json, location: string) {
  return [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])].map(parameter => resolve(document, parameter)).filter(parameter => parameter.in === location);
}

// Choose a working credential for the example; a workspace operation may also admit a personal
// MCP sign-in. This is not a test for excluding an operation from publication.
function usesSessionExample(operation: Json): boolean {
  const sec: Json[] = operation.security ?? [];
  const hasSession = sec.some(s => 'dashboardSession' in s || 'secureDashboardSession' in s);
  const hasBearer = sec.some(s => 'bearerAuth' in s);
  return (hasSession && !hasBearer) || Boolean(operation.tags?.includes('Workspaces'));
}

function sdkSample(document: Json, path: string, method: string, pathItem: Json, operation: Json): string {
  const options: Json = {};
  const pathParameters = parameters(document, pathItem, operation, 'path');
  const queryParameters = parameters(document, pathItem, operation, 'query').filter(parameter => parameter.required);
  const headerParameters = parameters(document, pathItem, operation, 'header').filter(parameter => parameter.required && parameter.name.toLowerCase() !== 'authorization');
  if (pathParameters.length) options.path = Object.fromEntries(pathParameters.map(parameter => [parameter.name, sample(document, parameter.schema, parameter.name)]));
  if (queryParameters.length) options.query = Object.fromEntries(queryParameters.map(parameter => [parameter.name, sample(document, parameter.schema, parameter.name)]));
  if (headerParameters.length) options.headers = Object.fromEntries(headerParameters.map(parameter => [parameter.name, sample(document, parameter.schema, parameter.name)]));
  const bodySchema = operation.requestBody?.content?.['application/json']?.schema;
  if (bodySchema) {
    options.body = sample(document, bodySchema, 'body');
    const completeEmail = (email: Json) => ({ ...email, subject: email.subject ?? `Hello from ${productName}`, text: email.text ?? 'Your message is ready.' });
    if (operation.operationId === 'sendEmail') options.body = completeEmail(options.body);
    if (operation.operationId === 'sendEmailBatch') options.body.emails = options.body.emails.map(completeEmail);
  }
  const renderedOptions = Object.entries(options).map(([key, value]) => `  ${key}: ${JSON.stringify(value, null, 2).replaceAll('\n', '\n  ')},`).join('\n');
  if (usesSessionExample(operation)) return `import { createClient } from '${sdkPackage}/client';\nimport { ${operation.operationId} } from '${sdkPackage}';\n\n// Run in the signed-in dashboard, on its own origin.\nconst client = createClient({ baseUrl: window.location.origin, credentials: 'same-origin' });\nconst result = await ${operation.operationId}({\n  client,\n${renderedOptions ? `${renderedOptions}\n` : ''}  throwOnError: true,\n});\nconsole.log(result.data);`;
  return `import { createClient } from '${sdkPackage}/client';\nimport { ${operation.operationId} } from '${sdkPackage}';\n\nconst client = createClient({\n  baseUrl: '${publicOrigin}',\n  auth: scheme => scheme.scheme === 'bearer'\n    ? process.env.${apiKeyEnv}\n    : undefined,\n});\n\nconst result = await ${operation.operationId}({\n  client,\n${renderedOptions ? `${renderedOptions}\n` : ''}  throwOnError: true,\n});\n\nconsole.log(result.data);`;
}

function curlSample(document: Json, path: string, method: string, pathItem: Json, operation: Json): string {
  let target = path;
  for (const parameter of parameters(document, pathItem, operation, 'path')) target = target.replace(`{${parameter.name}}`, encodeURIComponent(String(sample(document, parameter.schema, parameter.name))));
  const query = parameters(document, pathItem, operation, 'query').filter(parameter => parameter.required).map(parameter => `${encodeURIComponent(parameter.name)}=${encodeURIComponent(String(sample(document, parameter.schema, parameter.name)))}`);
  if (query.length) target += `?${query.join('&')}`;
  const bodySchema = operation.requestBody?.content?.['application/json']?.schema;
  let body = bodySchema ? sample(document, bodySchema, 'body') : undefined;
  const completeEmail = (email: Json) => ({ ...email, subject: email.subject ?? `Hello from ${productName}`, text: email.text ?? 'Your message is ready.' });
  if (operation.operationId === 'sendEmail') body = completeEmail(body);
  if (operation.operationId === 'sendEmailBatch') body.emails = body.emails.map(completeEmail);
  const lines = [`curl --request ${method.toUpperCase()} \\`, `  --url '${publicOrigin}${target}' \\`, `  --header "Authorization: Bearer $${apiKeyEnv}"`];
  if (usesSessionExample(operation)) {
    lines[1] = `  --url "\${NIGHTMAIL_ORIGIN}${target}" \\`;
    lines[2] = `  --header "Origin: $NIGHTMAIL_ORIGIN" \\\n  --cookie "$NIGHTMAIL_COOKIE_JAR"`;
  }
  if (bodySchema) { lines[lines.length - 1] += ' \\'; lines.push(`  --header 'Content-Type: application/json' \\`, `  --data '${JSON.stringify(body, null, 2)}'`); }
  return lines.join('\n');
}

// The first five minutes, shared by /docs (x-quickstart), /docs.md and /llms.txt.
const quickstartCurl = `curl --request POST \\
  --url '${publicOrigin}/v1/emails/send' \\
  --header "Authorization: Bearer $${apiKeyEnv}" \\
  --header 'Content-Type: application/json' \\
  --header "Idempotency-Key: $(uuidgen)" \\
  --data '{"from":"hello@acme.com","to":"you@acme.com","subject":"Hello from ${productName}","text":"It works."}'`;
export const quickstart: { title: string; text: string; code?: string }[] = [
  { title: 'Add and verify your domain', text: 'In the dashboard, open Domains and add it, or call POST /v1/domains with {"name":"acme.com"}. Publish the DNS records it returns at your DNS provider. Sending works once GET /v1/domains/{id} reports sending: "verified", usually within minutes of the records resolving. A domain whose records are still unproven after 72 hours is released.' },
  { title: 'Create an API key', text: `In the dashboard, open API keys in the sidebar and choose Create key. A Send only key restricted to your domain is enough to send; it can’t read logs, so add Read permission if your code should look up outcomes. Store it as ${apiKeyEnv} on your server and never ship it to a browser.` },
  { title: 'Send', text: '202 means queued, not delivered. Follow the outcome in the dashboard’s Logs, or with GET /v1/emails/{id} and a key that has Read permission (a Send only key gets 403). Leave out region: the sender domain decides it. To test without reaching a real inbox, send to success@simulator.amazonses.com (or bounce@, complaint@, ooto@ and suppressionlist@ the same domain). Simulator sends use your daily sending limit like any other send, but never count towards your sender score.', code: quickstartCurl },
  { title: 'Receive (optional)', text: `Publish the receiving MX record from the domain page. Hosted ${productName} receives on a free subdomain such as reply.<your domain>, so the domain’s existing mailboxes keep working; it uses the domain itself only when its MX already points to ${productName}, or when you choose it. Create an inbox with POST /v1/inboxes and read mail with GET /v1/inboxes/{id}/messages (or subscribe to message.received with POST /v1/inbound/webhooks).` },
  { title: 'Reply', text: 'POST /v1/inbound/threads/{threadId}/reply answers the newest message from its receiving address and sets In-Reply-To and References.' },
];
// Guides beyond the first five minutes, for /docs.md and /llms.txt; the dashboard shows the same text as a Docs guide.
export const guides: { id: string; title: string; text: string; code?: string; language?: string }[] = [agentSetupGuide, builtinDomainGuide, webhookSignatureGuide];
// Core sending and receiving first; campaigns and rules next; dashboard, self-hosted, webhooks and deprecated last.
const CORE_TAGS = ['Emails', 'Domains', 'Agent inboxes', 'Inbound domains', 'Inbound threads', 'Inbound events', 'Inbound webhooks', 'Webhooks', 'Attachments', 'Metrics', 'ApiKeys', 'Settings'] as const;
const ADVANCED_TAGS = ['Campaigns', 'Templates', 'Audience', 'Consent', 'Newsletters', 'Routing', 'Rules', 'Endpoints', 'Billing', 'Feedback'] as const;
const PLUMBING_TAGS = ['Inbound addresses', 'Regions', 'Workspaces', 'Auth', 'Events'] as const;
const tagOrder: readonly string[] = [...CORE_TAGS, ...ADVANCED_TAGS, ...PLUMBING_TAGS];
const tagRank = (tag: string) => { const index = tagOrder.indexOf(tag); return index === -1 ? tagOrder.length : index; };
const TAG_TIERS: readonly { heading: string; note: string; tags: ReadonlySet<string> }[] = [
  { heading: 'Core API', note: 'Sending, domains, inboxes, receiving, webhooks, attachments, metrics and credentials.', tags: new Set(CORE_TAGS) },
  { heading: 'Campaigns, audience & automation', note: 'Bulk campaigns, templates, contacts/lists/segments, newsletters, routing, rules, endpoints and billing.', tags: new Set(ADVANCED_TAGS) },
  { heading: 'Dashboard, self-hosted, webhooks & deprecated', note: 'Mostly dashboard-session administration, Amazon SNS receivers, self-hosted SES region setup and deprecated /v1/inbound/addresses aliases.', tags: new Set(PLUMBING_TAGS) },
];
const START_HERE_OPS = [
  { id: 'createDomain', role: 'Add a domain and get its DNS records' },
  { id: 'getDomain', role: 'Check domain verification status' },
  { id: 'verifyDomain', role: 'Trigger a fresh DNS verification check' },
  { id: 'sendEmail', role: 'Queue an email (202 = queued)' },
  { id: 'getEmail', role: 'Check delivery status of a sent email' },
  { id: 'enableInboundDomain', role: 'Turn on receiving for a verified domain' },
  { id: 'createInbox', role: 'Create a receiving inbox/address' },
  { id: 'listInboxMessages', role: 'Read messages received by an inbox' },
  { id: 'getInboxMessage', role: 'Read one received message and its extracted codes/links' },
] as const;
const SNS_WEBHOOK_OPS = new Set(['receiveSesSnsEvent', 'receiveCloudFormationSnsEvent']);
const SELF_HOSTED_OPS = new Set(['configureRegion', 'provisionRegion', 'configureRegionAutoValidation']);
function operationMarker(operation: Json): string {
  const labels: string[] = [];
  if (operation.deprecated) labels.push('deprecated');
  if (SNS_WEBHOOK_OPS.has(operation.operationId)) labels.push('SNS webhook');
  if (SELF_HOSTED_OPS.has(operation.operationId)) labels.push('self-hosted');
  return labels.length ? ` [${labels.join(', ')}]` : '';
}

export function createRegisteredDocument(app: App) {
  const document = app.getOpenAPI31Document({ openapi: '3.1.0', info: { title: `${productName} API`, version: '0.1.0', description: 'Send, receive and reply to email on your own domains. 202 means queued, not delivered.' } }) as Json;
  document.info['x-quickstart'] = quickstart;
  const used = [...new Set(operationEntries(document).map(entry => entry.operation.tags?.[0] ?? 'API'))];
  document.tags = used.sort((a, b) => tagRank(a) - tagRank(b)).map(name => ({ name }));
  for (const [path, pathItem] of Object.entries<Json>(document.paths ?? {})) for (const method of METHODS) {
    const operation = pathItem[method];
    if (!operation?.operationId) continue;
    // What it needs (operation-permissions.ts). An operation without a row has none, and check-premerge.ts fails on it.
    const permission = permissionOf(operation.operationId);
    if (permission) operation[permissionExtension] = permission;
    operation['x-codeSamples'] = [
      { lang: 'TypeScript', label: 'TypeScript SDK', source: sdkSample(document, path, method, pathItem, operation) },
      { lang: 'Shell', label: 'cURL', source: curlSample(document, path, method, pathItem, operation) },
    ];
  }
  return document;
}

// Project from the enriched contract so a retained operation (including its examples) is identical
// in both documents. Leave the original path items intact for SDK generation and route coverage.
export function publicDocument(registered: Json): Json {
  const paths: Json = {};
  const omitted = new Set<string>();
  for (const [path, item] of Object.entries<Json>(registered.paths)) {
    const published = { ...item };
    for (const method of METHODS) {
      const operation = item[method];
      if (!operation || !dashboardReference.has(operation.operationId)) continue;
      if (operation[permissionExtension]?.credential !== 'dashboard' || omitted.has(operation.operationId))
        throw new Error(`Review the dashboard guard for ${operation.operationId}.`);
      omitted.add(operation.operationId);
      delete published[method];
    }
    if (METHODS.some(method => published[method])) paths[path] = published;
  }
  for (const id of dashboardReference.keys()) if (!omitted.has(id)) throw new Error(`Unknown dashboard operation: ${id}`);
  return { ...registered, paths };
}

export function createOpenApiDocument(app: App) {
  return publicDocument(createRegisteredDocument(app));
}

function title(value: string) { return value.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(' ').map((word, index) => /^mcp$/i.test(word) ? 'MCP' : index === 0 ? word[0].toUpperCase() + word.slice(1).toLowerCase() : word.toLowerCase()).join(' '); }
function markdownText(value: unknown) { return String(value ?? '').replaceAll('|', '\\|').replace(/\s+/g, ' ').trim(); }
const fieldTable = (fields: Field[]) => `| Field | Type | Required | Description |\n| --- | --- | --- | --- |\n${fields.map(field => `| \`${field.path}\` | ${markdownText(field.type)} | ${field.required ? 'yes' : 'no'} | ${markdownText(field.description)} |`).join('\n')}\n`
/** A body as its reference page lists it (schema-fields.ts): its fields, each variant's, "No fields" or its type. */
function bodyMarkdown(document: Json, input: Json | undefined, heading: string, level = '###'): string {
  if (!input) return '';
  const body = describeBody(document, input);
  const head = `${level} ${heading}\n${body.description ? `\n${body.description}\n` : ''}\n`;
  if (body.kind === 'fields') return `${head}${fieldTable(body.fields)}`;
  if (body.kind === 'variants') return `${head}One of ${body.variants.length}:\n\n${body.variants.map(variant => `${level}# ${variant.title}\n\n${variant.description ? `${variant.description}\n\n` : ''}${variant.fields.length ? fieldTable(variant.fields) : 'No fields.\n'}`).join('\n')}`;
  if (body.kind === 'empty') return `${head}No fields.\n`;
  return `${head}Type: \`${body.type}\`\n`;
}
function operationEntries(document: Json) {
  const result: Array<{ path: string; method: string; pathItem: Json; operation: Json }> = [];
  for (const [path, pathItem] of Object.entries<Json>(document.paths ?? {})) for (const method of METHODS) if (pathItem[method]?.operationId) result.push({ path, method, pathItem, operation: pathItem[method] });
  return result;
}
// A tag's reference lists many operations, many answering with the same body (the error body on nearly every one, a
// Campaign on nine): there, a named body two or more of them use is listed once, at the top (sharedMarkdown), and each
// operation names it. An operation's own copy lists every body in full, as its page does.
const nameOf = (schema: Json | undefined) => typeof schema?.$ref === 'string' ? schema.$ref.split('/').at(-1) as string : null;
function sharedBodies(entries: ReturnType<typeof operationEntries>): Map<string, Json> {
  const uses = new Map<string, { schema: Json; count: number }>();
  for (const { operation } of entries) for (const schema of [operation.requestBody?.content?.['application/json']?.schema, ...responseRows(operation.responses ?? {}).map(row => row.schema)]) {
    const name = nameOf(schema);
    if (name) uses.set(name, { schema: schema!, count: (uses.get(name)?.count ?? 0) + 1 });
  }
  return new Map([...uses].filter(([, use]) => use.count > 1).map(([name, use]) => [name, use.schema]));
}
const sharedMarkdown = (document: Json, shared: Map<string, Json>) => shared.size ? `## Bodies used by several operations\n\n${[...shared].map(([name, schema]) => bodyMarkdown(document, schema, name, '###')).join('\n')}\n---\n\n` : '';
function operationMarkdown(document: Json, entry: ReturnType<typeof operationEntries>[number], shared = new Map<string, Json>()) {
  const { path, method, pathItem, operation } = entry;
  const params = [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])].map((parameter: Json) => resolve(document, parameter));
  const parameterRows = params.length ? `### Parameters\n\n| Name | In | Type | Required | Description |\n| --- | --- | --- | --- | --- |\n${params.map((parameter: Json) => `| \`${parameter.name}\` | ${parameter.in} | ${schemaType(document, parameter.schema)} | ${parameter.required ? 'yes' : 'no'} | ${markdownText(parameter.description)} |`).join('\n')}\n` : '';
  const body = operation.requestBody?.content?.['application/json']?.schema;
  const rows = responseRows(operation.responses ?? {});
  const responseTable = rows.map(row => `| ${row.statuses.map(status => `\`${status}\``).join(', ')} | ${markdownText(row.description)} | ${row.schema ? markdownText(schemaType(document, row.schema)) : '—'} |`).join('\n');
  const responseBodies = rows.flatMap(row => {
    if (!row.schema) return [];
    const heading = `${row.statuses.join(', ')}: ${markdownText(row.description)}`, name = nameOf(row.schema);
    return [name && shared.has(name) ? `#### ${heading}\n\nBody: \`${name}\`, listed under Bodies used by several operations at the top.\n` : bodyMarkdown(document, row.schema, heading, '####')];
  }).join('\n');
  const samples = Object.fromEntries((operation['x-codeSamples'] ?? []).map((item: Json) => [item.lang, item.source]));
  const permission = operation[permissionExtension]?.text;
  return `## ${title(operation.operationId)}\n\n\`${method.toUpperCase()} ${path}\`\n\n${operation.description ?? ''}\n\nOperation ID: \`${operation.operationId}\`\n\n${permission ? `Permission: ${permission}\n\n` : ''}${parameterRows}\n${nameOf(body) && shared.has(nameOf(body)!) ? `### Request body\n\nBody: \`${nameOf(body)}\`, listed under Bodies used by several operations at the top.\n` : bodyMarkdown(document, body, 'Request body')}\n### TypeScript SDK\n\n\`\`\`ts\n${samples.TypeScript ?? ''}\n\`\`\`\n\n### cURL\n\n\`\`\`sh\n${samples.Shell ?? ''}\n\`\`\`\n\n### Responses\n\n| Status | Description | Schema |\n| --- | --- | --- |\n${responseTable}\n${responseBodies ? `\n${responseBodies}` : ''}`;
}

// Tag groups in the document's tag order, operations in path order within each.
function grouped(document: Json, entries: ReturnType<typeof operationEntries>) {
  const tagOf = (entry: ReturnType<typeof operationEntries>[number]) => entry.operation.tags?.[0] ?? 'API';
  const order: string[] = (document.tags ?? []).map((tag: Json) => tag.name);
  const rank = (tag: string) => { const index = order.indexOf(tag); return index === -1 ? order.length : index; };
  const tags = [...new Set(entries.map(tagOf))].sort((a, b) => rank(a) - rank(b));
  return tags.map(tag => ({ tag, entries: entries.filter(entry => tagOf(entry) === tag) }));
}
function quickstartMarkdown() {
  return `## Quickstart\n\n${quickstart.map((step, index) => `${index + 1}. **${step.title}.** ${step.text}${step.code ? `\n\n   \`\`\`sh\n${step.code.split('\n').map(line => `   ${line}`).join('\n')}\n   \`\`\`` : ''}`).join('\n')}\n\n${guidesMarkdown()}`;
}
function guidesMarkdown() {
  return guides.map(guide => `## ${guide.title}\n\n${guide.text}\n\n${guide.code ? `\`\`\`${guide.language ?? 'sh'}\n${guide.code}\n\`\`\`\n\n` : ''}`).join('');
}

// /docs.md is the index (quickstart, guides, every operation by tag). Each tag's full reference lives at
// /docs/tags/<slug>.md and each operation at /docs/operations/<id>.md, so an agent loads only the part it needs
// and no single file outgrows an agent's context as operations are added (scripts/check-agent-docs.ts caps each).
export const tagSlug = (tag: string) => tag.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const intro = (document: Json) => `# ${productName} API\n\n${document.info?.description ?? ''}\n\n- [Interactive documentation](/docs)\n- [OpenAPI 3.1 JSON](/openapi.json)\n- [Agent index](/llms.txt)\n- TypeScript package: \`${sdkPackage}\`\n\n`;

function startHereMarkdown(entries: ReturnType<typeof operationEntries>, link: (id: string, method: string, path: string, role: string) => string) {
  const byId = new Map(entries.map(entry => [entry.operation.operationId as string, entry]));
  const rows = START_HERE_OPS.flatMap(({ id, role }) => {
    const entry = byId.get(id);
    return entry ? [link(id, entry.method.toUpperCase(), entry.path, role)] : [];
  });
  return `## Start here (core operations)\n\nMost integrations only need these ${rows.length} operations to verify a domain, send mail and receive replies:\n\n${rows.join('\n')}\n\n`;
}

function tieredGroups(groups: ReturnType<typeof grouped>) {
  const assigned = new Set<string>();
  const tiers = TAG_TIERS.map(tier => {
    const matched = groups.filter(({ tag }) => tier.tags.has(tag));
    for (const { tag } of matched) assigned.add(tag);
    return { ...tier, groups: matched };
  }).filter(tier => tier.groups.length);
  const other = groups.filter(({ tag }) => !assigned.has(tag));
  if (other.length) tiers.push({ heading: 'Other', note: '', tags: new Set(other.map(g => g.tag)), groups: other });
  return tiers;
}

export function createMarkdownDocs(document: Json, operationId?: string): string | null {
  const entries = operationEntries(document);
  if (operationId) {
    const entry = entries.find(entry => entry.operation.operationId === operationId);
    if (!entry) return null;
    const tag = entry.operation.tags?.[0] ?? 'API';
    return `${intro(document)}[API index](/docs.md) · [${tag} reference](/docs/tags/${tagSlug(tag)}.md)\n\n${operationMarkdown(document, entry)}`;
  }
  const startHere = startHereMarkdown(entries, (id, method, path, role) => `- [${title(id)}](/docs/operations/${id}.md) — \`${method} ${path}\` — ${role}`);
  const index = tieredGroups(grouped(document, entries)).map(tier => `### ${tier.heading}\n\n${tier.note ? `${tier.note}\n\n` : ''}${tier.groups.map(({ tag, entries }) => `#### ${tag}\n\nFull reference: [${tag}](/docs/tags/${tagSlug(tag)}.md)\n\n${entries.map(entry => `- [${title(entry.operation.operationId)}](/docs/operations/${entry.operation.operationId}.md) — \`${entry.method.toUpperCase()} ${entry.path}\`${operationMarker(entry.operation)}`).join('\n')}`).join('\n\n')}`).join('\n\n');
  return `${intro(document)}${quickstartMarkdown()}${startHere}## API reference by tag\n\nEach tag below links to its complete reference (every operation with parameters, request body, SDK and cURL examples, and responses). Each operation also has its own page. Operations marked \`[dashboard-only]\`, \`[SNS webhook]\`, \`[self-hosted]\` or \`[deprecated]\` are not needed for ordinary API-key integrations.\n\n${index}\n`;
}

export function createTagMarkdownDocs(document: Json, slug: string): string | null {
  const group = grouped(document, operationEntries(document)).find(({ tag }) => tagSlug(tag) === slug);
  if (!group) return null;
  const shared = sharedBodies(group.entries);
  return `${intro(document)}[API index](/docs.md)\n\n# ${group.tag}\n\n${sharedMarkdown(document, shared)}${group.entries.map(entry => operationMarkdown(document, entry, shared)).join('\n---\n\n')}`;
}

export function createLlmsText(document: Json): string {
  const entries = operationEntries(document);
  const groups = grouped(document, entries);
  const startHere = startHereMarkdown(entries, (id, method, path, role) => `- ${title(id)} (${method} ${path}): /docs/operations/${id}.md — ${role}`);
  const byTier = tieredGroups(groups).map(tier => `### ${tier.heading}\n\n${tier.groups.map(({ tag }) => `- ${tag}: /docs/tags/${tagSlug(tag)}.md`).join('\n')}`).join('\n\n');
  return `# ${productName}\n\n> ${productName} is an email API on Amazon SES: send, receive and reply on your own domains.\n\n${quickstartMarkdown()}${startHere}## Canonical documentation\n\n- Markdown API reference index: /docs.md\n- Interactive API reference: /docs\n- OpenAPI 3.1 definition: /openapi.json\n- TypeScript SDK: https://www.npmjs.com/package/${sdkPackage}\n- MCP endpoint: /mcp\n\n## Markdown API reference by tag\n\n${byTier}\n\n## Focused operation documentation\n\n${groups.flatMap(group => group.entries).map(entry => `- ${title(entry.operation.operationId)}${operationMarker(entry.operation)}: /docs/operations/${entry.operation.operationId}.md`).join('\n')}\n`;
}
