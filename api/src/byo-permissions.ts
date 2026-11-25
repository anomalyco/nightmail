import { ApiError } from './core.js';
import { setupResources } from './ses-setup.js';

/** Why a connected account's role is assumed: the session's name is nightmail-<purpose>. */
export type ByoPurpose = 'scan' | 'provision' | 'cleanup' | 'send' | 'template' | 'quota' | 'verify' | 'read' | 'delete' | 'mailfrom' | 'stack' | 'account' | 'update';
export type ByoScope = { region: string; account: string; connectionId: string; domain?: string; template?: string; stack?: string; templateUrl?: string; changeSet?: string };
/** The published role templates (api/byo-templates/<version>.yaml) a connected account may run. */
export const BYO_TEMPLATE_VERSIONS = ['6.0'] as const;
export const BYO_TEMPLATE_BUCKET = (platformAccount: string) => `nightmail-byo-templates-${platformAccount}`;
export const byoTemplateUrl = (platformAccount: string, version: string = BYO_TEMPLATE_VERSIONS.at(-1)!) => `https://${BYO_TEMPLATE_BUCKET(platformAccount)}.s3.us-east-2.amazonaws.com/byo/${version}.yaml`;
/** What each feature needs from a connected account's stack: the first published template version that grants it. A feature an
 * older stack lacks is offered with an update instead, and nothing else changes. */
export const BYO_FEATURES = { 'production-access': '6.0', 'stack-update': '6.0' } as const;
export function versionAtLeast(version: string | null | undefined, minimum: string) {
  const parse = (v: string) => v.split('.').map(Number) as [number, number];
  if (!version || !/^\d+\.\d+$/.test(version)) return false;
  const [a, b] = parse(version), [c, d] = parse(minimum);
  return a > c || (a === c && b >= d);
}
export const byoFeatures = (version: string | null | undefined) => (Object.keys(BYO_FEATURES) as (keyof typeof BYO_FEATURES)[]).filter(feature => versionAtLeast(version, BYO_FEATURES[feature]));
type Statement = { Effect: 'Allow'; Action: string[]; Resource: string | string[]; Condition?: { StringEquals: Record<string, string> } };
const domainName = /^(?:[a-z0-9-]+\.)+[a-z]{2,63}$/;

/**
 * The only place a connected account's session policies are written. Each session is narrowed to one purpose, so
 * the role's broader namespace grants are never handed out whole. The acceptance test "BYO contract" checks every
 * statement here against every published role template (api/byo-templates/).
 */
export function byoSessionStatements(purpose: ByoPurpose, s: ByoScope): Statement[] {
  const names = setupResources(s.connectionId, 'byo'), ses = `arn:aws:ses:${s.region}:${s.account}:`;
  const sets = [names.transactional, names.marketing].map(n => ses + 'configuration-set/' + n), topic = `arn:aws:sns:${s.region}:${s.account}:${names.topicName}`;
  const allow = (Action: string[], Resource: string | string[], extra: Record<string, string> = {}): Statement => ({ Effect: 'Allow', Action, Resource, Condition: { StringEquals: { 'aws:RequestedRegion': s.region, ...extra } } });
  const domain = () => {
    if (!s.domain || !domainName.test(s.domain)) throw new ApiError(409, 'BYO_SESSION_SCOPE_REQUIRED', 'A purpose-scoped regional AWS session is required.');
    return ses + 'identity/' + s.domain;
  };
  // Domain sessions name one identity and no region condition, as before this module.
  const identity = (actions: string[]): Statement[] => [{ Effect: 'Allow', Action: ['ses:GetEmailIdentity', ...actions], Resource: domain() }];
  switch (purpose) {
    case 'scan': return [allow(['ses:GetAccount', 'ses:ListEmailIdentities', 'ses:ListConfigurationSets', 'ses:DescribeActiveReceiptRuleSet'], '*'), allow(['ses:GetEmailIdentity'], ses + 'identity/?*.??*'),
      allow(['ses:GetConfigurationSet'], [...sets, ses + 'configuration-set/bane-*', ses + 'configuration-set/nightmail-*'])];
    case 'provision': return [allow(['ses:GetAccount'], '*'),
      allow(['ses:GetConfigurationSet', 'ses:CreateConfigurationSet', 'ses:TagResource', 'ses:PutConfigurationSetSuppressionOptions', 'ses:GetConfigurationSetEventDestinations', 'ses:CreateConfigurationSetEventDestination'], sets),
      allow(['sns:CreateTopic', 'sns:TagResource', 'sns:GetTopicAttributes', 'sns:ListTagsForResource', 'sns:SetTopicAttributes', 'sns:ListSubscriptionsByTopic', 'sns:GetSubscriptionAttributes', 'sns:Subscribe'], topic)];
    case 'cleanup': return [allow(['ses:GetConfigurationSet', 'ses:GetConfigurationSetEventDestinations', 'ses:DeleteConfigurationSet'], sets),
      allow(['sns:GetTopicAttributes', 'sns:ListTagsForResource', 'sns:ListSubscriptionsByTopic', 'sns:GetSubscriptionAttributes', 'sns:DeleteTopic'], topic)];
    case 'send': return [allow(['ses:SendEmail'], [domain(), ...sets], { 'ses:ApiVersion': '2' }), allow(['ses:ApplyTrackingConfigurationOverrides'], '*', { 'ses:OpenTrackingEnabled': '${ses:ClickTrackingEnabled}' })];
    case 'template':
      if (!s.template || !/^bane-[A-Za-z0-9_-]+$/.test(s.template)) throw new ApiError(422, 'TEMPLATE_SCOPE_REQUIRED', 'Regional BYO may render only bane- templates.');
      return [allow(['ses:GetEmailTemplate', 'ses:TestRenderEmailTemplate'], ses + 'template/' + s.template)];
    case 'quota': return [allow(['ses:GetAccount'], '*')];
    // Requesting production access: read the account's state, then ask once (requestProductionAccess).
    case 'account': return [allow(['ses:GetAccount', 'ses:PutAccountDetails'], '*')];
    case 'read': return identity([]);
    case 'verify': return identity(['ses:CreateEmailIdentity', 'ses:TagResource', 'ses:PutEmailIdentityFeedbackAttributes']);
    case 'delete': return identity(['ses:DeleteEmailIdentity']);
    case 'mailfrom': return identity(['ses:PutEmailIdentityMailFromAttributes']);
    // The stack is always in us-east-2 (the template asserts it); Nightmail reads its status and outputs.
    // Preparing an update of the stack from Nightmail's published template; only the customer can run it.
    case 'update':
      if (!s.stack || !/^Nightmail-[0-9a-f]{20}$/.test(s.stack) || !s.templateUrl || !s.changeSet || !/^nightmail-update-[a-z0-9-]{1,80}$/.test(s.changeSet)) throw new ApiError(409, 'BYO_SESSION_SCOPE_REQUIRED', 'A purpose-scoped regional AWS session is required.');
      return [{ Effect: 'Allow', Action: ['cloudformation:DescribeStacks'], Resource: `arn:aws:cloudformation:us-east-2:${s.account}:stack/${s.stack}/*`, Condition: { StringEquals: { 'aws:RequestedRegion': 'us-east-2' } } },
        { Effect: 'Allow', Action: ['cloudformation:CreateChangeSet'], Resource: `arn:aws:cloudformation:us-east-2:${s.account}:stack/${s.stack}/*`, Condition: { StringEquals: { 'aws:RequestedRegion': 'us-east-2', 'cloudformation:TemplateUrl': s.templateUrl, 'cloudformation:ChangeSetName': s.changeSet } } }];
    case 'stack':
      if (!s.stack || !/^Nightmail-[0-9a-f]{20}$/.test(s.stack)) throw new ApiError(409, 'BYO_SESSION_SCOPE_REQUIRED', 'A purpose-scoped regional AWS session is required.');
      return [{ Effect: 'Allow', Action: ['cloudformation:DescribeStacks', 'cloudformation:DescribeStackResource'], Resource: `arn:aws:cloudformation:us-east-2:${s.account}:stack/${s.stack}/*`, Condition: { StringEquals: { 'aws:RequestedRegion': 'us-east-2' } } }];
  }
}
export const byoSessionPolicy = (purpose: ByoPurpose, scope: ByoScope) => JSON.stringify({ Version: '2012-10-17', Statement: byoSessionStatements(purpose, scope) });
