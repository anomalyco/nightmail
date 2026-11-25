import { PERMISSIONS, type PermissionName } from './core.js';
import { productName, productSlug } from './brand.js';

/**
 * What every operation needs, as data: the permission error.required names (core.ts PERMISSIONS), its level, the scope
 * a credential's limits must cover, and who may call it. The OpenAPI document carries each row as
 * x-nightmail-permission (openapi-docs.ts), the docs show its sentence and MCP describe_tool returns it.
 *
 * A row states what today's guards enforce, not what they should: the acceptance test "permission table" calls every
 * operation with keys, address keys, people, an MCP sign-in and agent tokens, and fails when a row admits or refuses a
 * credential that REST does not. A change to a guard changes its row in the same commit. check-premerge.ts fails on an
 * operation without a row.
 */
export const permissionExtension = `x-${productSlug}-permission`;
export type PermissionLevel = 'on' | 'read' | 'write';
export type OperationPermission = {
  /** The permission and its level (on for sendEmail). Absent: the operation takes no permission (see person and access). */
  permission?: PermissionName; level?: PermissionLevel;
  /**
   * What the credential's limits must cover. workspace: the whole workspace, so a key limited to sender domains or to
   * addresses is refused. domain: the sender domain the request names or the resource has (a domain-limited key sees
   * its own). address: the receiving address or inbox, for a key limited to addresses or a workspace-wide one.
   * recipient: received mail, for a key limited to the address it reached, a key limited to sender domains with read
   * (mail addressed to those domains: core.ts domainMailAccess) or a workspace-wide one.
   */
  scope?: 'workspace' | 'domain' | 'address' | 'recipient';
  /**
   * With a permission: the role a signed-in person needs, so a workspace member is refused (keys are judged by the
   * permission). Alone: the operation is a person's, never a key's or an agent token's. any: every member. A level beside
   * it is what the person's MCP sign-in must be approved for: read, or write (manage).
   */
  person?: 'any' | 'admin' | 'owner';
  /**
   * dashboard: a signed-in dashboard session only. signIn: a person's MCP sign-in only. lasting: anything but a temporary
   * agent token. notDelegated: a dashboard session or an API key no MCP approval made.
   */
  credential?: 'dashboard' | 'signIn' | 'lasting' | 'notDelegated';
  /** The level an MCP sign-in or an agent token needs here, where it is higher than an API key's. */
  delegatedLevel?: 'write';
  /**
   * The request also names access it gives (an agent token's permissions and domains, an inbox's sending and its key's
   * mail permissions), and each request is checked to give no more than the caller has. The row states the least a
   * caller needs; what a given request needs depends on what it asks for.
   */
  withinCaller?: true;
  /** public: no credential (a signed link or notification, or public data). staff: support and operator tooling only. any: any credential for the workspace. */
  access?: 'public' | 'staff' | 'any';
};

type Scope = OperationPermission['scope'];
type More = Pick<OperationPermission, 'person' | 'credential' | 'delegatedLevel' | 'withinCaller'>;
const needs = (permission: PermissionName, level: PermissionLevel, scope?: Scope, more: More = {}): OperationPermission => ({ permission, level, ...(scope ? { scope } : {}), ...more });
const people = (person: 'any' | 'admin' | 'owner', credential?: 'dashboard' | 'signIn'): OperationPermission => ({ person, ...(credential ? { credential } : {}) });
// People only, and also over their own MCP sign-in approved for this level.
const signedIn = (person: 'any' | 'admin' | 'owner', level: 'read' | 'write', more: Pick<OperationPermission, 'credential' | 'withinCaller'> = {}): OperationPermission => ({ person, level, ...more });
const admin = { person: 'admin' } as const, adminLasting = { person: 'admin', credential: 'lasting' } as const;
const PUBLIC: OperationPermission = { access: 'public' };
// Repeated rows: key administration, and receiving configuration (routing, rules, endpoints, inbox connections).
const keyAdmin = needs('configuration', 'write', 'workspace', adminLasting);
const rulesRead = needs('receivingRules', 'read', 'workspace', admin), rulesChange = needs('receivingRules', 'write', 'workspace', adminLasting);
// Receiving hosts, domains and scan policy answer only an unrestricted manage credential, reads included.
const hostsRead = needs('receivingRules', 'write', 'workspace', admin), hostsChange = rulesChange;
const mailRead = needs('receivedMail', 'read', 'address'), mailChange = needs('receivedMail', 'write', 'address', admin);
// The received mail a key limited to sender domains also reads, when addressed to them (core.ts domainMailAccess).
const recipientRead = needs('receivedMail', 'read', 'recipient');

export const OPERATION_PERMISSIONS: Record<string, OperationPermission> = {
  // MCP connections and agents: the person's own, in the dashboard.
  bindMcpConnection: people('any', 'dashboard'),
  listAgents: people('any', 'dashboard'), revokeAgent: people('any', 'dashboard'),
  getCurrentIdentity: { access: 'any' },
  createAgentToken: signedIn('admin', 'read', { credential: 'signIn', withinCaller: true }), listAgentTokens: keyAdmin, revokeAgentToken: keyAdmin,
  // Agent setup (agent-setup.ts): an owner or admin mints a setup token or approves a device code in the dashboard; the
  // agent exchanges its secret, which is its only credential there.
  createAgentSetupToken: people('admin', 'dashboard'), getAgentSetupToken: people('admin', 'dashboard'),
  exchangeAgentSetupToken: PUBLIC, startAgentDeviceAuthorization: PUBLIC, pollAgentDeviceToken: PUBLIC,
  lookUpAgentDevice: people('any', 'dashboard'), approveAgentDevice: people('admin', 'dashboard'), denyAgentDevice: people('any', 'dashboard'),
  createApiKey: keyAdmin, listApiKeys: keyAdmin, revokeApiKey: keyAdmin, updateApiKey: keyAdmin, listApiKeyChanges: keyAdmin,
  // Audience. Contacts, imports and templates are content a member edits; lists and segments are not.
  listContacts: needs('audience', 'read', 'workspace'), createContact: needs('audience', 'write', 'workspace'), getContact: needs('audience', 'read', 'workspace'),
  updateContact: needs('audience', 'write', 'workspace'), deleteContact: needs('audience', 'write', 'workspace'),
  updateContactConsent: needs('audience', 'write', 'workspace'), listContactConsentEvents: needs('audience', 'read', 'workspace'),
  listContactLists: needs('audience', 'read', 'workspace'), createContactList: needs('audience', 'write', 'workspace', admin), getContactList: needs('audience', 'read', 'workspace'),
  updateContactList: needs('audience', 'write', 'workspace', admin), deleteContactList: needs('audience', 'write', 'workspace', admin),
  // Newsletters are lists with a sender: read like lists, changed like them by owners and admins.
  listNewsletters: needs('audience', 'read', 'workspace'), getNewsletter: needs('audience', 'read', 'workspace'), createNewsletter: needs('audience', 'write', 'workspace', admin),
  updateNewsletter: needs('audience', 'write', 'workspace', admin), deleteNewsletter: needs('audience', 'write', 'workspace', admin),
  listListMembers: needs('audience', 'read', 'workspace'), addListMembers: needs('audience', 'write', 'workspace', admin), removeListMember: needs('audience', 'write', 'workspace', admin),
  listSegments: needs('audience', 'read', 'workspace'), createSegment: needs('audience', 'write', 'workspace', admin), getSegment: needs('audience', 'read', 'workspace'),
  updateSegment: needs('audience', 'write', 'workspace', admin), deleteSegment: needs('audience', 'write', 'workspace', admin), previewSegment: needs('audience', 'read', 'workspace'),
  previewContactImport: needs('audience', 'write', 'workspace'), listContactImports: needs('audience', 'read', 'workspace'), getContactImport: needs('audience', 'read', 'workspace'),
  commitContactImport: needs('audience', 'write', 'workspace'),
  queryAudience: needs('audience', 'read', 'workspace'), planAudienceMutation: needs('audience', 'write', 'workspace', admin), applyAudiencePlan: needs('audience', 'write', 'workspace', admin),
  // Templates and their assets. Any key reads them, one limited to sender domains included; changing them takes the whole workspace.
  listCampaignTemplates: needs('audience', 'read'), createCampaignTemplate: needs('audience', 'write', 'workspace'), getCampaignTemplate: needs('audience', 'read'),
  updateCampaignTemplate: needs('audience', 'write', 'workspace'), deleteCampaignTemplate: needs('audience', 'write', 'workspace'), publishCampaignTemplate: needs('audience', 'write', 'workspace'),
  previewCampaignTemplate: needs('audience', 'read'), renderCampaignTemplatePreviewImage: needs('sendEmail', 'on'),
  setCampaignTemplateArchived: needs('audience', 'write', 'workspace'),
  uploadTemplateAsset: needs('audience', 'write', 'workspace'), importTemplateImage: needs('audience', 'write', 'workspace'), getTemplateAsset: needs('audience', 'read'),
  deleteTemplateAsset: needs('audience', 'write', 'workspace'), getTemplateAssetContent: needs('audience', 'read'),
  // Sending and sent mail.
  checkEmail: needs('sentMail', 'read', 'domain'), sendEmail: needs('sendEmail', 'on', 'domain'), sendEmailBatch: needs('sendEmail', 'on', 'domain'), previewEmail: needs('sentMail', 'read', 'domain'),
  listEmails: needs('sentMail', 'read', 'domain'), getEmail: needs('sentMail', 'read', 'domain'), getEmailDetail: needs('sentMail', 'read', 'domain'), getEmailContent: needs('sentMail', 'read', 'domain'),
  listEmailEvents: needs('sentMail', 'read', 'domain'), cancelEmail: needs('sendEmail', 'on', 'domain'), rescheduleEmail: needs('sendEmail', 'on', 'domain'),
  uploadAttachment: needs('sendEmail', 'on', 'domain'), getAttachment: needs('sentMail', 'read', 'domain'), deleteAttachment: needs('sendEmail', 'on', 'workspace'), getAttachmentContent: needs('sentMail', 'read', 'domain'),
  // Campaigns: drafts follow their From domain; audiences and delivery are the workspace's.
  createCampaign: needs('sendEmail', 'on', 'domain'), listCampaigns: needs('audience', 'read', 'domain'), getCampaign: needs('audience', 'read', 'domain'),
  updateCampaign: needs('sendEmail', 'on', 'domain'), deleteCampaign: needs('sendEmail', 'on', 'domain'), getCampaignStats: needs('sentMail', 'read', 'workspace'),
  getCampaignContentGuide: needs('audience', 'read'), previewCampaign: needs('audience', 'read', 'domain'), previewCampaignAudience: needs('audience', 'read', 'workspace'),
  renderCampaignPreviewImage: needs('sendEmail', 'on', 'domain'), getCampaignState: needs('audience', 'read', 'domain'), setCampaignArchived: needs('sendEmail', 'on', 'domain'),
  testCampaign: needs('sendEmail', 'on', 'workspace'), sendCampaign: needs('sendEmail', 'on', 'workspace', admin), scheduleCampaign: needs('sendEmail', 'on', 'workspace', admin),
  cancelCampaign: needs('sendEmail', 'on', 'workspace', admin), pauseCampaign: needs('sendEmail', 'on', 'workspace', admin), resumeCampaign: needs('sendEmail', 'on', 'workspace', admin),
  setCampaignPacing: needs('sendEmail', 'on', 'workspace', admin), unscheduleCampaign: needs('sendEmail', 'on', 'workspace', admin), rescheduleCampaign: needs('sendEmail', 'on', 'workspace', admin),
  // Settings, domains and sending webhooks.
  getWorkspaceSettings: needs('configuration', 'read', 'workspace'), updateWorkspaceSettings: needs('configuration', 'write', 'workspace', admin), getSesSettings: needs('configuration', 'read', 'workspace', admin),
  listDomains: needs('configuration', 'read', 'domain', admin), createDomain: needs('configuration', 'write', 'domain', admin),
  configureDomainMailFrom: needs('configuration', 'write', 'domain', admin), removeDomainMailFrom: needs('configuration', 'write', 'domain', admin), chooseReceivingHost: needs('receivingRules', 'write', 'domain', adminLasting),
  sendDomainTestEmail: people('admin', 'dashboard'), getDomainDnsSetup: people('admin', 'dashboard'), completeDomainDnsSetup: PUBLIC,
  getDomain: needs('configuration', 'read', 'domain', admin), deleteDomain: needs('configuration', 'write', 'domain', admin), verifyDomain: needs('configuration', 'write', 'domain', admin),
  listWebhooks: needs('configuration', 'read', 'workspace', admin), createWebhook: needs('configuration', 'write', 'workspace', adminLasting), getWebhook: needs('configuration', 'read', 'workspace', admin),
  updateWebhook: needs('configuration', 'write', 'workspace', adminLasting), deleteWebhook: needs('configuration', 'write', 'workspace', adminLasting),
  revealWebhookSecret: needs('configuration', 'write', 'workspace', { person: 'admin', credential: 'notDelegated' }), rotateWebhookSecret: needs('configuration', 'write', 'workspace', adminLasting),
  testWebhook: needs('configuration', 'write', 'workspace', admin), listWebhookDeliveries: needs('configuration', 'read', 'workspace', admin),
  getWebhookDelivery: needs('configuration', 'read', 'workspace', admin), retryWebhookDelivery: needs('configuration', 'write', 'workspace', admin),
  // Signed by Amazon SNS, and the recipient's own unsubscribe links.
  receiveSesSnsEvent: PUBLIC, receiveCloudFormationSnsEvent: PUBLIC, unsubscribeByLink: PUBLIC, unsubscribeOneClick: PUBLIC,
  // Metrics, standing and regions.
  getMetrics: needs('sentMail', 'read', 'workspace'), getSenderScore: needs('sentMail', 'read', 'workspace'), releaseSenderStanding: people('admin', 'dashboard'), getUsage: needs('sentMail', 'read', 'workspace'),
  listRegions: needs('configuration', 'read', 'workspace'), configureRegion: needs('configuration', 'write', 'workspace', admin), discoverRegion: needs('configuration', 'read', 'workspace', admin),
  provisionRegion: needs('configuration', 'write', 'workspace', admin), configureRegionAutoValidation: needs('configuration', 'write', 'workspace', admin),
  // Routing, rules, endpoints and inbox connections.
  getRouting: rulesRead, applyRouting: rulesChange, listRoutes: rulesRead, createRoute: rulesChange, getRoute: rulesRead, updateRoute: rulesChange, deleteRoute: rulesChange,
  getRoutingAudit: rulesRead, listRoutingVersions: rulesRead, getRoutingVersion: rulesRead, restoreRoutingVersion: rulesChange, testRouting: rulesRead,
  listRuleVersions: rulesRead, restoreRuleVersion: rulesChange, setDecisionOptIns: rulesChange,
  listEndpoints: rulesRead, createEndpoint: rulesChange, getEndpoint: rulesRead, updateEndpoint: rulesChange, deleteEndpoint: rulesChange, sendEndpointVerification: rulesChange, testEndpoint: rulesChange,
  createInboxConnection: rulesChange, getRuleVersion: rulesRead, checkRule: rulesRead, getRuleTypings: rulesRead,
  listRuleTemplates: rulesRead, listRuleRecipes: rulesRead, createRuleFromRecipe: rulesChange,
  updateRuleFromRecipe: rulesChange, updateRule: rulesChange, getRule: rulesRead, saveRule: rulesChange, deleteRule: rulesChange,
  attachRules: rulesChange, getRules: rulesRead, applyRules: rulesChange, testRules: rulesRead,
  // Agent inboxes: their mail and folders, mail client passwords, and the inboxes themselves.
  listInboxFolders: mailRead, createInboxFolder: mailChange, updateInboxFolder: mailChange, deleteInboxFolder: mailChange,
  updateInboxMessage: mailChange, deleteInboxMessage: mailChange, getInboxMessage: mailRead, moveInboxMessage: mailChange, copyInboxMessage: mailChange, expungeInboxFolder: mailChange,
  getInboxChanges: mailRead,
  createInboxAppPassword: needs('configuration', 'write', 'workspace', adminLasting), listInboxAppPasswords: needs('configuration', 'write', 'workspace', admin),
  listAppPasswords: needs('configuration', 'write', 'workspace', admin), revokeInboxAppPassword: needs('configuration', 'write', 'workspace', adminLasting),
  createInbox: needs('inboxes', 'write', 'address', { person: 'admin', withinCaller: true }), listInboxes: needs('inboxes', 'read', 'address'), getInbox: needs('inboxes', 'read', 'address'),
  updateInbox: mailChange, deleteInbox: mailChange, simulateInboxMessage: mailChange, listInboxMessages: mailRead, getInboxAttachment: mailRead,
  // Receiving: retired addresses, scan policy, receiving domains, hosts and subdomains.
  releaseRetiredAddress: needs('inboxes', 'write', 'workspace', admin), getInboundScanPolicy: hostsRead, updateInboundScanPolicy: hostsRead,
  listInboundDomains: hostsRead, getInboundDomain: hostsRead, updateInboundDomain: hostsChange, checkInboundDomain: hostsRead, enableInboundDomain: hostsChange, disableInboundDomain: hostsChange,
  listReceivingHosts: hostsRead, addReceivingHost: hostsChange, updateReceivingHost: hostsChange, removeReceivingHost: hostsChange,
  listInboundSubdomains: hostsRead, createInboundSubdomain: hostsChange, getInboundSubdomain: hostsRead, updateInboundSubdomain: hostsChange, removeInboundSubdomain: hostsChange,
  // Receiving addresses, conversations and received mail.
  listInboundAddresses: needs('inboxes', 'read', 'address'), createInboundAddress: needs('inboxes', 'write', 'workspace', admin), getInboundAddress: needs('inboxes', 'read', 'address'),
  updateInboundAddress: needs('inboxes', 'write', 'workspace', admin), deleteInboundAddress: needs('inboxes', 'write', 'workspace', admin), setInboundAddressFlow: rulesChange,
  listInboundThreads: recipientRead, createInboundThread: needs('sendEmail', 'on', 'address'), getInboundThread: recipientRead, updateInboundThread: mailChange,
  listInboundMessages: recipientRead, getInboundMessage: recipientRead, getInboundAttachment: recipientRead, downloadInboundAttachment: recipientRead,
  listLogs: needs('sentMail', 'read', 'domain'), getInboundOverview: needs('inboxes', 'read', 'address'), listInboundEndpoints: hostsRead,
  replyToInboundThread: needs('sendEmail', 'on', 'address'), listInboundEvents: recipientRead,
  // Inbound webhooks.
  createInboundWebhook: needs('configuration', 'write', 'workspace', adminLasting), listInboundWebhooks: needs('configuration', 'read', 'workspace', { person: 'admin', delegatedLevel: 'write' }),
  getInboundWebhook: needs('configuration', 'read', 'workspace', { person: 'admin', delegatedLevel: 'write' }), updateInboundWebhook: needs('configuration', 'write', 'workspace', adminLasting),
  deleteInboundWebhook: needs('configuration', 'write', 'workspace', adminLasting), testInboundWebhook: needs('configuration', 'write', 'workspace', admin),
  redeliverInboundMessage: needs('configuration', 'write', 'workspace', admin), rotateInboundWebhookSecret: needs('configuration', 'write', 'workspace', adminLasting),
  retryInboundWebhookDelivery: needs('configuration', 'write', 'workspace', admin), listInboundWebhookDeliveries: needs('configuration', 'write', 'workspace', admin),
  // Workspaces, members, invitations and bring-your-own AWS: a person's.
  createWorkspace: people('any', 'dashboard'), renameCurrentWorkspace: people('admin', 'dashboard'),
  listWorkspaceMembers: signedIn('admin', 'read'), inviteWorkspaceMember: signedIn('admin', 'write'), createWorkspaceInvitation: signedIn('admin', 'write'), listWorkspaceInvitations: signedIn('admin', 'read'),
  revokeWorkspaceInvitation: signedIn('admin', 'write'), updateWorkspaceMember: people('admin', 'dashboard'), removeWorkspaceMember: people('admin', 'dashboard'),
  getWorkspaceInvitation: people('any', 'dashboard'), acceptWorkspaceInvitation: people('any', 'dashboard'),
  getConnection: people('admin', 'dashboard'), createConnection: people('admin', 'dashboard'), deleteConnection: people('admin', 'dashboard'), listConnectionRegions: people('admin', 'dashboard'),
  refreshConnectionScan: people('admin', 'dashboard'), importConnectionDomains: people('admin', 'dashboard'), requestConnectionProductionAccess: people('admin', 'dashboard'), updateConnectionStack: people('admin', 'dashboard'), getConnectionRegionStatus: people('admin', 'dashboard'), verifyConnection: people('admin', 'dashboard'),
  getPublicStats: PUBLIC, getOverviewSetup: needs('sentMail', 'read', 'domain'), listActivity: signedIn('admin', 'write'), contactSupport: people('any', 'dashboard'),
  // Billing: balance and usage read like settings; charges, the card and auto-recharge are an owner's or admin's in the dashboard.
  getBilling: needs('configuration', 'read', 'workspace'), getBillingUsage: needs('configuration', 'read', 'workspace'),
  listBillingLedger: needs('configuration', 'write', 'workspace', admin), listBillingPayments: needs('configuration', 'write', 'workspace', admin), getBillingPayment: needs('configuration', 'write', 'workspace', admin),
  createBillingTopUp: people('admin', 'dashboard'), createBillingTopUpLink: needs('configuration', 'write', 'workspace', admin),
  updateBillingAutoRecharge: people('admin', 'dashboard'), createBillingCardSetup: people('admin', 'dashboard'), deleteBillingPaymentMethod: people('admin', 'dashboard'),
};

const WHERE = { workspace: ' on the whole workspace', domain: ' for the sender domain', address: ' for the address or inbox', recipient: ' for the address it reached, or a sender domain it was addressed to' } as const;
const WHO = { any: 'any member', admin: 'an owner or admin', owner: 'an owner' } as const;
/** The sentence the docs and describe_tool show for a row. */
export function permissionText(row: OperationPermission): string {
  if (row.access === 'public') return 'Needs no credential.';
  if (row.access === 'staff') return `${productName} staff only.`;
  if (row.access === 'any') return 'Needs any API key, person or agent token of the workspace.';
  const within = row.withinCaller ? ' A request gives no more than the caller has.' : '';
  if (!row.permission) {
    const who = WHO[row.person ?? 'any'], consent = row.level ? ` with ${row.level} access` : '';
    if (row.credential === 'signIn') return `Only ${who} signed in over MCP${consent}. Never an API key.${within}`;
    return `People only: ${who}${row.credential === 'dashboard' ? ' in a signed-in dashboard session' : `, in the dashboard or over their own MCP sign-in${consent}`}. Never an API key.${within}`;
  }
  const parts = [`Needs ${PERMISSIONS[row.permission]}${row.level && row.level !== 'on' ? `: ${row.level}` : ''}${row.scope ? WHERE[row.scope] : ''}.`];
  if (row.delegatedLevel) parts.push(`MCP sign-ins and agent tokens need ${row.delegatedLevel}.`);
  if (row.person) parts.push(`A person needs to be ${WHO[row.person]}.`);
  if (row.credential === 'lasting') parts.push('Not a temporary agent token.');
  if (row.credential === 'notDelegated') parts.push('Only a dashboard session or an API key no MCP approval made.');
  if (row.credential === 'dashboard') parts.push('Only in a signed-in dashboard session.');
  return parts.join(' ') + within;
}
/** The extension's value: the row and its sentence. */
export const permissionOf = (operationId: string) => {
  const row = OPERATION_PERMISSIONS[operationId];
  return row && { ...row, text: permissionText(row) };
};
