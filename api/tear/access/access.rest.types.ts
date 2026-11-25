// Documented REST authorization table for every hosted MCP catalog operation,
// extracted from api/openapi.json (x-nightmail-permission) and kept pure (zero api/src imports).
// Checked independently against BOTH real /mcp listings (code & plain) and real REST GET probes (audit).

export interface OpPerm {
  permission?: "sendEmail" | "sentMail" | "receivedMail" | "inboxes" | "audience" | "receivingRules" | "configuration" | "administration";
  level?: "on" | "read" | "write";
  scope?: "workspace" | "domain" | "address" | "recipient";
  person?: "any" | "admin" | "owner";
  credential?: "dashboard" | "signIn" | "lasting" | "notDelegated";
  delegatedLevel?: "write";
  withinCaller?: true;
  access?: "public" | "staff" | "any";
}

export interface CatalogOp {
  readonly name: string;
  readonly method: string;
  readonly path: string;
  readonly perm: OpPerm | null;
  readonly inbox: "read" | "send" | "modify" | "create" | null;
}

export const CATALOG_OPS: readonly CatalogOp[] = [
  {
    "name": "addListMembers",
    "method": "post",
    "path": "/v1/lists/{id}/members",
    "perm": {
      "permission": "audience",
      "level": "write",
      "scope": "workspace",
      "person": "admin"
    },
    "inbox": null
  },
  {
    "name": "addReceivingHost",
    "method": "post",
    "path": "/v1/inbound/domains/{id}/hosts",
    "perm": {
      "permission": "receivingRules",
      "level": "write",
      "scope": "workspace",
      "person": "admin",
      "credential": "lasting"
    },
    "inbox": null
  },
  {
    "name": "applyAudiencePlan",
    "method": "post",
    "path": "/v1/audience-query/apply",
    "perm": {
      "permission": "audience",
      "level": "write",
      "scope": "workspace",
      "person": "admin"
    },
    "inbox": null
  },
  {
    "name": "applyRouting",
    "method": "put",
    "path": "/v1/routing",
    "perm": {
      "permission": "receivingRules",
      "level": "write",
      "scope": "workspace",
      "person": "admin",
      "credential": "lasting"
    },
    "inbox": null
  },
  {
    "name": "applyRules",
    "method": "put",
    "path": "/v1/rules",
    "perm": {
      "permission": "receivingRules",
      "level": "write",
      "scope": "workspace",
      "person": "admin",
      "credential": "lasting"
    },
    "inbox": null
  },
  {
    "name": "attachRules",
    "method": "put",
    "path": "/v1/rules/attachments",
    "perm": {
      "permission": "receivingRules",
      "level": "write",
      "scope": "workspace",
      "person": "admin",
      "credential": "lasting"
    },
    "inbox": null
  },
  {
    "name": "bindMcpConnection",
    "method": "post",
    "path": "/v1/mcp-connections/{id}/workspace",
    "perm": {
      "person": "any",
      "credential": "dashboard"
    },
    "inbox": null
  },
  {
    "name": "cancelCampaign",
    "method": "post",
    "path": "/v1/campaigns/{id}/cancel",
    "perm": {
      "permission": "sendEmail",
      "level": "on",
      "scope": "workspace",
      "person": "admin"
    },
    "inbox": null
  },
  {
    "name": "cancelEmail",
    "method": "post",
    "path": "/v1/emails/{id}/cancel",
    "perm": {
      "permission": "sendEmail",
      "level": "on",
      "scope": "domain"
    },
    "inbox": null
  },
  {
    "name": "checkEmail",
    "method": "post",
    "path": "/v1/emails/check",
    "perm": {
      "permission": "sentMail",
      "level": "read",
      "scope": "domain"
    },
    "inbox": null
  },
  {
    "name": "checkInboundDomain",
    "method": "post",
    "path": "/v1/inbound/domains/{id}/check",
    "perm": {
      "permission": "receivingRules",
      "level": "write",
      "scope": "workspace",
      "person": "admin"
    },
    "inbox": null
  },
  {
    "name": "checkRule",
    "method": "post",
    "path": "/v1/rules/check",
    "perm": {
      "permission": "receivingRules",
      "level": "read",
      "scope": "workspace",
      "person": "admin"
    },
    "inbox": null
  },
  {
    "name": "chooseReceivingHost",
    "method": "post",
    "path": "/v1/domains/{id}/receiving-host",
    "perm": {
      "permission": "receivingRules",
      "level": "write",
      "scope": "domain",
      "person": "admin",
      "credential": "lasting"
    },
    "inbox": null
  },
  {
    "name": "commitContactImport",
    "method": "post",
    "path": "/v1/contact-imports/{id}/commit",
    "perm": {
      "permission": "audience",
      "level": "write",
      "scope": "workspace"
    },
    "inbox": null
  },
  {
    "name": "configureDomainMailFrom",
    "method": "post",
    "path": "/v1/domains/{id}/mail-from",
    "perm": {
      "permission": "configuration",
      "level": "write",
      "scope": "domain",
      "person": "admin"
    },
    "inbox": null
  },
  {
    "name": "configureRegion",
    "method": "put",
    "path": "/v1/regions/{region}",
    "perm": {
      "permission": "configuration",
      "level": "write",
      "scope": "workspace",
      "person": "admin"
    },
    "inbox": null
  },
  {
    "name": "configureRegionAutoValidation",
    "method": "put",
    "path": "/v1/regions/{region}/auto-validation",
    "perm": {
      "permission": "configuration",
      "level": "write",
      "scope": "workspace",
      "person": "admin"
    },
    "inbox": null
  },
  {
    "name": "copyInboxMessage",
    "method": "post",
    "path": "/v1/inboxes/{id}/messages/{messageId}/copy",
    "perm": {
      "permission": "receivedMail",
      "level": "write",
      "scope": "address",
      "person": "admin"
    },
    "inbox": "modify"
  },
  {
    "name": "createAgentToken",
    "method": "post",
    "path": "/v1/agent-tokens",
    "perm": {
      "person": "admin",
      "level": "read",
      "credential": "signIn",
      "withinCaller": true
    },
    "inbox": null
  },
  {
    "name": "createApiKey",
    "method": "post",
    "path": "/v1/api-keys",
    "perm": {
      "permission": "configuration",
      "level": "write",
      "scope": "workspace",
      "person": "admin",
      "credential": "lasting"
    },
    "inbox": null
  },
  {
    "name": "createBillingTopUpLink",
    "method": "post",
    "path": "/v1/billing/top-up-links",
    "perm": {
      "permission": "configuration",
      "level": "write",
      "scope": "workspace",
      "person": "admin"
    },
    "inbox": null
  },
  {
    "name": "createCampaign",
    "method": "post",
    "path": "/v1/campaigns",
    "perm": {
      "permission": "sendEmail",
      "level": "on",
      "scope": "domain"
    },
    "inbox": null
  },
  {
    "name": "createCampaignTemplate",
    "method": "post",
    "path": "/v1/templates",
    "perm": {
      "permission": "audience",
      "level": "write",
      "scope": "workspace"
    },
    "inbox": null
  },
  {
    "name": "createContact",
    "method": "post",
    "path": "/v1/contacts",
    "perm": {
      "permission": "audience",
      "level": "write",
      "scope": "workspace"
    },
    "inbox": null
  },
  {
    "name": "createContactList",
    "method": "post",
    "path": "/v1/lists",
    "perm": {
      "permission": "audience",
      "level": "write",
      "scope": "workspace",
      "person": "admin"
    },
    "inbox": null
  },
  {
    "name": "createDomain",
    "method": "post",
    "path": "/v1/domains",
    "perm": {
      "permission": "configuration",
      "level": "write",
      "scope": "domain",
      "person": "admin"
    },
    "inbox": null
  },
  {
    "name": "createEndpoint",
    "method": "post",
    "path": "/v1/endpoints",
    "perm": {
      "permission": "receivingRules",
      "level": "write",
      "scope": "workspace",
      "person": "admin",
      "credential": "lasting"
    },
    "inbox": null
  },
  {
    "name": "createInboundAddress",
    "method": "post",
    "path": "/v1/inbound/addresses",
    "perm": {
      "permission": "inboxes",
      "level": "write",
      "scope": "workspace",
      "person": "admin"
    },
    "inbox": null
  },
  {
    "name": "createInboundSubdomain",
    "method": "post",
    "path": "/v1/inbound/domains/{id}/subdomains",
    "perm": {
      "permission": "receivingRules",
      "level": "write",
      "scope": "workspace",
      "person": "admin",
      "credential": "lasting"
    },
    "inbox": null
  },
  {
    "name": "createInboundThread",
    "method": "post",
    "path": "/v1/inbound/threads",
    "perm": {
      "permission": "sendEmail",
      "level": "on",
      "scope": "address"
    },
    "inbox": "send"
  },
  {
    "name": "createInboundWebhook",
    "method": "post",
    "path": "/v1/inbound/webhooks",
    "perm": {
      "permission": "configuration",
      "level": "write",
      "scope": "workspace",
      "person": "admin",
      "credential": "lasting"
    },
    "inbox": null
  },
  {
    "name": "createInbox",
    "method": "post",
    "path": "/v1/inboxes",
    "perm": {
      "permission": "inboxes",
      "level": "write",
      "scope": "address",
      "person": "admin",
      "withinCaller": true
    },
    "inbox": "create"
  },
  {
    "name": "createInboxAppPassword",
    "method": "post",
    "path": "/v1/inboxes/{id}/app-passwords",
    "perm": {
      "permission": "configuration",
      "level": "write",
      "scope": "workspace",
      "person": "admin",
      "credential": "lasting"
    },
    "inbox": null
  },
  {
    "name": "createInboxConnection",
    "method": "post",
    "path": "/v1/inbox-connections",
    "perm": {
      "permission": "receivingRules",
      "level": "write",
      "scope": "workspace",
      "person": "admin",
      "credential": "lasting"
    },
    "inbox": null
  },
  {
    "name": "createInboxFolder",
    "method": "post",
    "path": "/v1/inboxes/{id}/folders",
    "perm": {
      "permission": "receivedMail",
      "level": "write",
      "scope": "address",
      "person": "admin"
    },
    "inbox": "modify"
  },
  {
    "name": "createNewsletter",
    "method": "post",
    "path": "/v1/newsletters",
    "perm": {
      "permission": "audience",
      "level": "write",
      "scope": "workspace",
      "person": "admin"
    },
    "inbox": null
  },
  {
    "name": "createRoute",
    "method": "post",
    "path": "/v1/routing/routes",
    "perm": {
      "permission": "receivingRules",
      "level": "write",
      "scope": "workspace",
      "person": "admin",
      "credential": "lasting"
    },
    "inbox": null
  },
  {
    "name": "createRuleFromRecipe",
    "method": "post",
    "path": "/v1/rules/recipes",
    "perm": {
      "permission": "receivingRules",
      "level": "write",
      "scope": "workspace",
      "person": "admin",
      "credential": "lasting"
    },
    "inbox": null
  },
  {
    "name": "createSegment",
    "method": "post",
    "path": "/v1/segments",
    "perm": {
      "permission": "audience",
      "level": "write",
      "scope": "workspace",
      "person": "admin"
    },
    "inbox": null
  },
  {
    "name": "createWebhook",
    "method": "post",
    "path": "/v1/webhooks",
    "perm": {
      "permission": "configuration",
      "level": "write",
      "scope": "workspace",
      "person": "admin",
      "credential": "lasting"
    },
    "inbox": null
  },
  {
    "name": "createWorkspaceInvitation",
    "method": "post",
    "path": "/v1/workspaces/current/invitations",
    "perm": {
      "person": "admin",
      "level": "write"
    },
    "inbox": null
  },
  {
    "name": "deleteAttachment",
    "method": "delete",
    "path": "/v1/attachments/{id}",
    "perm": {
      "permission": "sendEmail",
      "level": "on",
      "scope": "workspace"
    },
    "inbox": null
  },
  {
    "name": "deleteCampaign",
    "method": "delete",
    "path": "/v1/campaigns/{id}",
    "perm": {
      "permission": "sendEmail",
      "level": "on",
      "scope": "domain"
    },
    "inbox": null
  },
  {
    "name": "deleteCampaignTemplate",
    "method": "delete",
    "path": "/v1/templates/{id}",
    "perm": {
      "permission": "audience",
      "level": "write",
      "scope": "workspace"
    },
    "inbox": null
  },
  {
    "name": "deleteContact",
    "method": "delete",
    "path": "/v1/contacts/{id}",
    "perm": {
      "permission": "audience",
      "level": "write",
      "scope": "workspace"
    },
    "inbox": null
  },
  {
    "name": "deleteContactList",
    "method": "delete",
    "path": "/v1/lists/{id}",
    "perm": {
      "permission": "audience",
      "level": "write",
      "scope": "workspace",
      "person": "admin"
    },
    "inbox": null
  },
  {
    "name": "deleteDomain",
    "method": "delete",
    "path": "/v1/domains/{id}",
    "perm": {
      "permission": "configuration",
      "level": "write",
      "scope": "domain",
      "person": "admin"
    },
    "inbox": null
  },
  {
    "name": "deleteEndpoint",
    "method": "delete",
    "path": "/v1/endpoints/{name}",
    "perm": {
      "permission": "receivingRules",
      "level": "write",
      "scope": "workspace",
      "person": "admin",
      "credential": "lasting"
    },
    "inbox": null
  },
  {
    "name": "deleteInboundAddress",
    "method": "delete",
    "path": "/v1/inbound/addresses/{addressId}",
    "perm": {
      "permission": "inboxes",
      "level": "write",
      "scope": "workspace",
      "person": "admin"
    },
    "inbox": null
  },
  {
    "name": "deleteInboundWebhook",
    "method": "delete",
    "path": "/v1/inbound/webhooks/{id}",
    "perm": {
      "permission": "configuration",
      "level": "write",
      "scope": "workspace",
      "person": "admin",
      "credential": "lasting"
    },
    "inbox": null
  },
  {
    "name": "deleteInbox",
    "method": "delete",
    "path": "/v1/inboxes/{id}",
    "perm": {
      "permission": "receivedMail",
      "level": "write",
      "scope": "address",
      "person": "admin"
    },
    "inbox": "modify"
  },
  {
    "name": "deleteInboxFolder",
    "method": "delete",
    "path": "/v1/inboxes/{id}/folders/{folder}",
    "perm": {
      "permission": "receivedMail",
      "level": "write",
      "scope": "address",
      "person": "admin"
    },
    "inbox": "modify"
  },
  {
    "name": "deleteInboxMessage",
    "method": "delete",
    "path": "/v1/inboxes/{id}/messages/{messageId}",
    "perm": {
      "permission": "receivedMail",
      "level": "write",
      "scope": "address",
      "person": "admin"
    },
    "inbox": "modify"
  },
  {
    "name": "deleteNewsletter",
    "method": "delete",
    "path": "/v1/newsletters/{id}",
    "perm": {
      "permission": "audience",
      "level": "write",
      "scope": "workspace",
      "person": "admin"
    },
    "inbox": null
  },
  {
    "name": "deleteRoute",
    "method": "delete",
    "path": "/v1/routing/routes/{id}",
    "perm": {
      "permission": "receivingRules",
      "level": "write",
      "scope": "workspace",
      "person": "admin",
      "credential": "lasting"
    },
    "inbox": null
  },
  {
    "name": "deleteRule",
    "method": "delete",
    "path": "/v1/rules/scripts/{key}",
    "perm": {
      "permission": "receivingRules",
      "level": "write",
      "scope": "workspace",
      "person": "admin",
      "credential": "lasting"
    },
    "inbox": null
  },
  {
    "name": "deleteSegment",
    "method": "delete",
    "path": "/v1/segments/{id}",
    "perm": {
      "permission": "audience",
      "level": "write",
      "scope": "workspace",
      "person": "admin"
    },
    "inbox": null
  },
  {
    "name": "deleteTemplateAsset",
    "method": "delete",
    "path": "/v1/template-assets/{id}",
    "perm": {
      "permission": "audience",
      "level": "write",
      "scope": "workspace"
    },
    "inbox": null
  },
  {
    "name": "deleteWebhook",
    "method": "delete",
    "path": "/v1/webhooks/{id}",
    "perm": {
      "permission": "configuration",
      "level": "write",
      "scope": "workspace",
      "person": "admin",
      "credential": "lasting"
    },
    "inbox": null
  },
  {
    "name": "disableInboundDomain",
    "method": "post",
    "path": "/v1/inbound/domains/{id}/disable",
    "perm": {
      "permission": "receivingRules",
      "level": "write",
      "scope": "workspace",
      "person": "admin",
      "credential": "lasting"
    },
    "inbox": null
  },
  {
    "name": "discoverRegion",
    "method": "get",
    "path": "/v1/regions/{region}/discovery",
    "perm": {
      "permission": "configuration",
      "level": "read",
      "scope": "workspace",
      "person": "admin"
    },
    "inbox": null
  },
  {
    "name": "enableInboundDomain",
    "method": "post",
    "path": "/v1/inbound/domains/{id}/enable",
    "perm": {
      "permission": "receivingRules",
      "level": "write",
      "scope": "workspace",
      "person": "admin",
      "credential": "lasting"
    },
    "inbox": null
  },
  {
    "name": "expungeInboxFolder",
    "method": "post",
    "path": "/v1/inboxes/{id}/folders/{folder}/expunge",
    "perm": {
      "permission": "receivedMail",
      "level": "write",
      "scope": "address",
      "person": "admin"
    },
    "inbox": "modify"
  },
  {
    "name": "getAttachment",
    "method": "get",
    "path": "/v1/attachments/{id}",
    "perm": {
      "permission": "sentMail",
      "level": "read",
      "scope": "domain"
    },
    "inbox": null
  },
  {
    "name": "getAttachmentContent",
    "method": "get",
    "path": "/v1/attachments/{id}/content",
    "perm": {
      "permission": "sentMail",
      "level": "read",
      "scope": "domain"
    },
    "inbox": null
  },
  {
    "name": "getBilling",
    "method": "get",
    "path": "/v1/billing",
    "perm": {
      "permission": "configuration",
      "level": "read",
      "scope": "workspace"
    },
    "inbox": null
  },
  {
    "name": "getBillingPayment",
    "method": "get",
    "path": "/v1/billing/payments/{id}",
    "perm": {
      "permission": "configuration",
      "level": "write",
      "scope": "workspace",
      "person": "admin"
    },
    "inbox": null
  },
  {
    "name": "getBillingUsage",
    "method": "get",
    "path": "/v1/billing/usage",
    "perm": {
      "permission": "configuration",
      "level": "read",
      "scope": "workspace"
    },
    "inbox": null
  },
  {
    "name": "getCampaign",
    "method": "get",
    "path": "/v1/campaigns/{id}",
    "perm": {
      "permission": "audience",
      "level": "read",
      "scope": "domain"
    },
    "inbox": null
  },
  {
    "name": "getCampaignContentGuide",
    "method": "get",
    "path": "/v1/campaign-content-guide",
    "perm": {
      "permission": "audience",
      "level": "read"
    },
    "inbox": null
  },
  {
    "name": "getCampaignState",
    "method": "get",
    "path": "/v1/campaigns/{id}/state",
    "perm": {
      "permission": "audience",
      "level": "read",
      "scope": "domain"
    },
    "inbox": null
  },
  {
    "name": "getCampaignStats",
    "method": "get",
    "path": "/v1/campaigns/{id}/stats",
    "perm": {
      "permission": "sentMail",
      "level": "read",
      "scope": "workspace"
    },
    "inbox": null
  },
  {
    "name": "getCampaignTemplate",
    "method": "get",
    "path": "/v1/templates/{id}",
    "perm": {
      "permission": "audience",
      "level": "read"
    },
    "inbox": null
  },
  {
    "name": "getContact",
    "method": "get",
    "path": "/v1/contacts/{id}",
    "perm": {
      "permission": "audience",
      "level": "read",
      "scope": "workspace"
    },
    "inbox": null
  },
  {
    "name": "getContactImport",
    "method": "get",
    "path": "/v1/contact-imports/{id}",
    "perm": {
      "permission": "audience",
      "level": "read",
      "scope": "workspace"
    },
    "inbox": null
  },
  {
    "name": "getContactList",
    "method": "get",
    "path": "/v1/lists/{id}",
    "perm": {
      "permission": "audience",
      "level": "read",
      "scope": "workspace"
    },
    "inbox": null
  },
  {
    "name": "getCurrentIdentity",
    "method": "get",
    "path": "/v1/me",
    "perm": {
      "access": "any"
    },
    "inbox": null
  },
  {
    "name": "getDomain",
    "method": "get",
    "path": "/v1/domains/{id}",
    "perm": {
      "permission": "configuration",
      "level": "read",
      "scope": "domain",
      "person": "admin"
    },
    "inbox": null
  },
  {
    "name": "getEmail",
    "method": "get",
    "path": "/v1/emails/{id}",
    "perm": {
      "permission": "sentMail",
      "level": "read",
      "scope": "domain"
    },
    "inbox": null
  },
  {
    "name": "getEmailContent",
    "method": "get",
    "path": "/v1/emails/{id}/content",
    "perm": {
      "permission": "sentMail",
      "level": "read",
      "scope": "domain"
    },
    "inbox": null
  },
  {
    "name": "getEmailDetail",
    "method": "get",
    "path": "/v1/emails/{id}/detail",
    "perm": {
      "permission": "sentMail",
      "level": "read",
      "scope": "domain"
    },
    "inbox": null
  },
  {
    "name": "getEndpoint",
    "method": "get",
    "path": "/v1/endpoints/{name}",
    "perm": {
      "permission": "receivingRules",
      "level": "read",
      "scope": "workspace",
      "person": "admin"
    },
    "inbox": null
  },
  {
    "name": "getInboundAddress",
    "method": "get",
    "path": "/v1/inbound/addresses/{addressId}",
    "perm": {
      "permission": "inboxes",
      "level": "read",
      "scope": "address"
    },
    "inbox": null
  },
  {
    "name": "getInboundAttachment",
    "method": "get",
    "path": "/v1/inbound/messages/{messageId}/attachments/{attachmentId}",
    "perm": {
      "permission": "receivedMail",
      "level": "read",
      "scope": "recipient"
    },
    "inbox": null
  },
  {
    "name": "getInboundDomain",
    "method": "get",
    "path": "/v1/inbound/domains/{id}",
    "perm": {
      "permission": "receivingRules",
      "level": "write",
      "scope": "workspace",
      "person": "admin"
    },
    "inbox": null
  },
  {
    "name": "getInboundMessage",
    "method": "get",
    "path": "/v1/inbound/messages/{messageId}",
    "perm": {
      "permission": "receivedMail",
      "level": "read",
      "scope": "recipient"
    },
    "inbox": null
  },
  {
    "name": "getInboundOverview",
    "method": "get",
    "path": "/v1/inbound/overview",
    "perm": {
      "permission": "inboxes",
      "level": "read",
      "scope": "address"
    },
    "inbox": null
  },
  {
    "name": "getInboundScanPolicy",
    "method": "get",
    "path": "/v1/inbound/policy",
    "perm": {
      "permission": "receivingRules",
      "level": "write",
      "scope": "workspace",
      "person": "admin"
    },
    "inbox": null
  },
  {
    "name": "getInboundSubdomain",
    "method": "get",
    "path": "/v1/inbound/domains/{id}/subdomains/{subdomainId}",
    "perm": {
      "permission": "receivingRules",
      "level": "write",
      "scope": "workspace",
      "person": "admin"
    },
    "inbox": null
  },
  {
    "name": "getInboundThread",
    "method": "get",
    "path": "/v1/inbound/threads/{threadId}",
    "perm": {
      "permission": "receivedMail",
      "level": "read",
      "scope": "recipient"
    },
    "inbox": null
  },
  {
    "name": "getInboundWebhook",
    "method": "get",
    "path": "/v1/inbound/webhooks/{id}",
    "perm": {
      "permission": "configuration",
      "level": "read",
      "scope": "workspace",
      "person": "admin",
      "delegatedLevel": "write"
    },
    "inbox": null
  },
  {
    "name": "getInbox",
    "method": "get",
    "path": "/v1/inboxes/{id}",
    "perm": {
      "permission": "inboxes",
      "level": "read",
      "scope": "address"
    },
    "inbox": "read"
  },
  {
    "name": "getInboxAttachment",
    "method": "get",
    "path": "/v1/inboxes/{id}/messages/{messageId}/attachments/{attachmentId}",
    "perm": {
      "permission": "receivedMail",
      "level": "read",
      "scope": "address"
    },
    "inbox": "read"
  },
  {
    "name": "getInboxChanges",
    "method": "get",
    "path": "/v1/inboxes/{id}/changes",
    "perm": {
      "permission": "receivedMail",
      "level": "read",
      "scope": "address"
    },
    "inbox": "read"
  },
  {
    "name": "getInboxMessage",
    "method": "get",
    "path": "/v1/inboxes/{id}/messages/{messageId}",
    "perm": {
      "permission": "receivedMail",
      "level": "read",
      "scope": "address"
    },
    "inbox": "read"
  },
  {
    "name": "getMetrics",
    "method": "get",
    "path": "/v1/metrics",
    "perm": {
      "permission": "sentMail",
      "level": "read",
      "scope": "workspace"
    },
    "inbox": null
  },
  {
    "name": "getNewsletter",
    "method": "get",
    "path": "/v1/newsletters/{id}",
    "perm": {
      "permission": "audience",
      "level": "read",
      "scope": "workspace"
    },
    "inbox": null
  },
  {
    "name": "getOverviewSetup",
    "method": "get",
    "path": "/v1/overview/setup",
    "perm": {
      "permission": "sentMail",
      "level": "read",
      "scope": "domain"
    },
    "inbox": null
  },
  {
    "name": "getRoute",
    "method": "get",
    "path": "/v1/routing/routes/{id}",
    "perm": {
      "permission": "receivingRules",
      "level": "read",
      "scope": "workspace",
      "person": "admin"
    },
    "inbox": null
  },
  {
    "name": "getRouting",
    "method": "get",
    "path": "/v1/routing",
    "perm": {
      "permission": "receivingRules",
      "level": "read",
      "scope": "workspace",
      "person": "admin"
    },
    "inbox": null
  },
  {
    "name": "getRoutingAudit",
    "method": "get",
    "path": "/v1/routing/audit",
    "perm": {
      "permission": "receivingRules",
      "level": "read",
      "scope": "workspace",
      "person": "admin"
    },
    "inbox": null
  },
  {
    "name": "getRoutingVersion",
    "method": "get",
    "path": "/v1/routing/versions/{v}",
    "perm": {
      "permission": "receivingRules",
      "level": "read",
      "scope": "workspace",
      "person": "admin"
    },
    "inbox": null
  },
  {
    "name": "getRule",
    "method": "get",
    "path": "/v1/rules/scripts/{key}",
    "perm": {
      "permission": "receivingRules",
      "level": "read",
      "scope": "workspace",
      "person": "admin"
    },
    "inbox": null
  },
  {
    "name": "getRules",
    "method": "get",
    "path": "/v1/rules",
    "perm": {
      "permission": "receivingRules",
      "level": "read",
      "scope": "workspace",
      "person": "admin"
    },
    "inbox": null
  },
  {
    "name": "getRuleTypings",
    "method": "get",
    "path": "/v1/rules/typings",
    "perm": {
      "permission": "receivingRules",
      "level": "read",
      "scope": "workspace",
      "person": "admin"
    },
    "inbox": null
  },
  {
    "name": "getSegment",
    "method": "get",
    "path": "/v1/segments/{id}",
    "perm": {
      "permission": "audience",
      "level": "read",
      "scope": "workspace"
    },
    "inbox": null
  },
  {
    "name": "getSenderScore",
    "method": "get",
    "path": "/v1/sender-score",
    "perm": {
      "permission": "sentMail",
      "level": "read",
      "scope": "workspace"
    },
    "inbox": null
  },
  {
    "name": "getSesSettings",
    "method": "get",
    "path": "/v1/settings/ses",
    "perm": {
      "permission": "configuration",
      "level": "read",
      "scope": "workspace",
      "person": "admin"
    },
    "inbox": null
  },
  {
    "name": "getTemplateAsset",
    "method": "get",
    "path": "/v1/template-assets/{id}",
    "perm": {
      "permission": "audience",
      "level": "read"
    },
    "inbox": null
  },
  {
    "name": "getTemplateAssetContent",
    "method": "get",
    "path": "/v1/template-assets/{id}/content",
    "perm": {
      "permission": "audience",
      "level": "read"
    },
    "inbox": null
  },
  {
    "name": "getUsage",
    "method": "get",
    "path": "/v1/usage",
    "perm": {
      "permission": "sentMail",
      "level": "read",
      "scope": "workspace"
    },
    "inbox": null
  },
  {
    "name": "getWebhook",
    "method": "get",
    "path": "/v1/webhooks/{id}",
    "perm": {
      "permission": "configuration",
      "level": "read",
      "scope": "workspace",
      "person": "admin"
    },
    "inbox": null
  },
  {
    "name": "getWebhookDelivery",
    "method": "get",
    "path": "/v1/webhooks/{id}/deliveries/{deliveryId}",
    "perm": {
      "permission": "configuration",
      "level": "read",
      "scope": "workspace",
      "person": "admin"
    },
    "inbox": null
  },
  {
    "name": "getWorkspaceSettings",
    "method": "get",
    "path": "/v1/settings/workspace",
    "perm": {
      "permission": "configuration",
      "level": "read",
      "scope": "workspace"
    },
    "inbox": null
  },
  {
    "name": "importTemplateImage",
    "method": "post",
    "path": "/v1/template-assets/import",
    "perm": {
      "permission": "audience",
      "level": "write",
      "scope": "workspace"
    },
    "inbox": null
  },
  {
    "name": "listActivity",
    "method": "get",
    "path": "/v1/activity",
    "perm": {
      "person": "admin",
      "level": "write"
    },
    "inbox": null
  },
  {
    "name": "listAgents",
    "method": "get",
    "path": "/v1/agents",
    "perm": {
      "person": "any",
      "credential": "dashboard"
    },
    "inbox": null
  },
  {
    "name": "listAgentTokens",
    "method": "get",
    "path": "/v1/agent-tokens",
    "perm": {
      "permission": "configuration",
      "level": "write",
      "scope": "workspace",
      "person": "admin",
      "credential": "lasting"
    },
    "inbox": null
  },
  {
    "name": "listApiKeyChanges",
    "method": "get",
    "path": "/v1/api-keys/{id}/changes",
    "perm": {
      "permission": "configuration",
      "level": "write",
      "scope": "workspace",
      "person": "admin",
      "credential": "lasting"
    },
    "inbox": null
  },
  {
    "name": "listApiKeys",
    "method": "get",
    "path": "/v1/api-keys",
    "perm": {
      "permission": "configuration",
      "level": "write",
      "scope": "workspace",
      "person": "admin",
      "credential": "lasting"
    },
    "inbox": null
  },
  {
    "name": "listAppPasswords",
    "method": "get",
    "path": "/v1/app-passwords",
    "perm": {
      "permission": "configuration",
      "level": "write",
      "scope": "workspace",
      "person": "admin"
    },
    "inbox": null
  },
  {
    "name": "listBillingLedger",
    "method": "get",
    "path": "/v1/billing/ledger",
    "perm": {
      "permission": "configuration",
      "level": "write",
      "scope": "workspace",
      "person": "admin"
    },
    "inbox": null
  },
  {
    "name": "listBillingPayments",
    "method": "get",
    "path": "/v1/billing/payments",
    "perm": {
      "permission": "configuration",
      "level": "write",
      "scope": "workspace",
      "person": "admin"
    },
    "inbox": null
  },
  {
    "name": "listCampaigns",
    "method": "get",
    "path": "/v1/campaigns",
    "perm": {
      "permission": "audience",
      "level": "read",
      "scope": "domain"
    },
    "inbox": null
  },
  {
    "name": "listCampaignTemplates",
    "method": "get",
    "path": "/v1/templates",
    "perm": {
      "permission": "audience",
      "level": "read"
    },
    "inbox": null
  },
  {
    "name": "listContactConsentEvents",
    "method": "get",
    "path": "/v1/contacts/{id}/consent",
    "perm": {
      "permission": "audience",
      "level": "read",
      "scope": "workspace"
    },
    "inbox": null
  },
  {
    "name": "listContactImports",
    "method": "get",
    "path": "/v1/contact-imports",
    "perm": {
      "permission": "audience",
      "level": "read",
      "scope": "workspace"
    },
    "inbox": null
  },
  {
    "name": "listContactLists",
    "method": "get",
    "path": "/v1/lists",
    "perm": {
      "permission": "audience",
      "level": "read",
      "scope": "workspace"
    },
    "inbox": null
  },
  {
    "name": "listContacts",
    "method": "get",
    "path": "/v1/contacts",
    "perm": {
      "permission": "audience",
      "level": "read",
      "scope": "workspace"
    },
    "inbox": null
  },
  {
    "name": "listDomains",
    "method": "get",
    "path": "/v1/domains",
    "perm": {
      "permission": "configuration",
      "level": "read",
      "scope": "domain",
      "person": "admin"
    },
    "inbox": null
  },
  {
    "name": "listEmailEvents",
    "method": "get",
    "path": "/v1/emails/{id}/events",
    "perm": {
      "permission": "sentMail",
      "level": "read",
      "scope": "domain"
    },
    "inbox": null
  },
  {
    "name": "listEmails",
    "method": "get",
    "path": "/v1/emails",
    "perm": {
      "permission": "sentMail",
      "level": "read",
      "scope": "domain"
    },
    "inbox": null
  },
  {
    "name": "listEndpoints",
    "method": "get",
    "path": "/v1/endpoints",
    "perm": {
      "permission": "receivingRules",
      "level": "read",
      "scope": "workspace",
      "person": "admin"
    },
    "inbox": null
  },
  {
    "name": "listInboundAddresses",
    "method": "get",
    "path": "/v1/inbound/addresses",
    "perm": {
      "permission": "inboxes",
      "level": "read",
      "scope": "address"
    },
    "inbox": null
  },
  {
    "name": "listInboundDomains",
    "method": "get",
    "path": "/v1/inbound/domains",
    "perm": {
      "permission": "receivingRules",
      "level": "write",
      "scope": "workspace",
      "person": "admin"
    },
    "inbox": null
  },
  {
    "name": "listInboundEndpoints",
    "method": "get",
    "path": "/v1/inbound/endpoints",
    "perm": {
      "permission": "receivingRules",
      "level": "write",
      "scope": "workspace",
      "person": "admin"
    },
    "inbox": null
  },
  {
    "name": "listInboundEvents",
    "method": "get",
    "path": "/v1/inbound/events",
    "perm": {
      "permission": "receivedMail",
      "level": "read",
      "scope": "recipient"
    },
    "inbox": null
  },
  {
    "name": "listInboundMessages",
    "method": "get",
    "path": "/v1/inbound/messages",
    "perm": {
      "permission": "receivedMail",
      "level": "read",
      "scope": "recipient"
    },
    "inbox": null
  },
  {
    "name": "listInboundSubdomains",
    "method": "get",
    "path": "/v1/inbound/domains/{id}/subdomains",
    "perm": {
      "permission": "receivingRules",
      "level": "write",
      "scope": "workspace",
      "person": "admin"
    },
    "inbox": null
  },
  {
    "name": "listInboundThreads",
    "method": "get",
    "path": "/v1/inbound/threads",
    "perm": {
      "permission": "receivedMail",
      "level": "read",
      "scope": "recipient"
    },
    "inbox": null
  },
  {
    "name": "listInboundWebhookDeliveries",
    "method": "get",
    "path": "/v1/inbound/webhooks/{id}/deliveries",
    "perm": {
      "permission": "configuration",
      "level": "write",
      "scope": "workspace",
      "person": "admin"
    },
    "inbox": null
  },
  {
    "name": "listInboundWebhooks",
    "method": "get",
    "path": "/v1/inbound/webhooks",
    "perm": {
      "permission": "configuration",
      "level": "read",
      "scope": "workspace",
      "person": "admin",
      "delegatedLevel": "write"
    },
    "inbox": null
  },
  {
    "name": "listInboxAppPasswords",
    "method": "get",
    "path": "/v1/inboxes/{id}/app-passwords",
    "perm": {
      "permission": "configuration",
      "level": "write",
      "scope": "workspace",
      "person": "admin"
    },
    "inbox": null
  },
  {
    "name": "listInboxes",
    "method": "get",
    "path": "/v1/inboxes",
    "perm": {
      "permission": "inboxes",
      "level": "read",
      "scope": "address"
    },
    "inbox": "read"
  },
  {
    "name": "listInboxFolders",
    "method": "get",
    "path": "/v1/inboxes/{id}/folders",
    "perm": {
      "permission": "receivedMail",
      "level": "read",
      "scope": "address"
    },
    "inbox": "read"
  },
  {
    "name": "listInboxMessages",
    "method": "get",
    "path": "/v1/inboxes/{id}/messages",
    "perm": {
      "permission": "receivedMail",
      "level": "read",
      "scope": "address"
    },
    "inbox": "read"
  },
  {
    "name": "listListMembers",
    "method": "get",
    "path": "/v1/lists/{id}/members",
    "perm": {
      "permission": "audience",
      "level": "read",
      "scope": "workspace"
    },
    "inbox": null
  },
  {
    "name": "listLogs",
    "method": "get",
    "path": "/v1/logs",
    "perm": {
      "permission": "sentMail",
      "level": "read",
      "scope": "domain"
    },
    "inbox": null
  },
  {
    "name": "listNewsletters",
    "method": "get",
    "path": "/v1/newsletters",
    "perm": {
      "permission": "audience",
      "level": "read",
      "scope": "workspace"
    },
    "inbox": null
  },
  {
    "name": "listReceivingHosts",
    "method": "get",
    "path": "/v1/inbound/domains/{id}/hosts",
    "perm": {
      "permission": "receivingRules",
      "level": "write",
      "scope": "workspace",
      "person": "admin"
    },
    "inbox": null
  },
  {
    "name": "listRegions",
    "method": "get",
    "path": "/v1/regions",
    "perm": {
      "permission": "configuration",
      "level": "read",
      "scope": "workspace"
    },
    "inbox": null
  },
  {
    "name": "listRoutes",
    "method": "get",
    "path": "/v1/routing/routes",
    "perm": {
      "permission": "receivingRules",
      "level": "read",
      "scope": "workspace",
      "person": "admin"
    },
    "inbox": null
  },
  {
    "name": "listRoutingVersions",
    "method": "get",
    "path": "/v1/routing/versions",
    "perm": {
      "permission": "receivingRules",
      "level": "read",
      "scope": "workspace",
      "person": "admin"
    },
    "inbox": null
  },
  {
    "name": "listRuleRecipes",
    "method": "get",
    "path": "/v1/rules/recipes",
    "perm": {
      "permission": "receivingRules",
      "level": "read",
      "scope": "workspace",
      "person": "admin"
    },
    "inbox": null
  },
  {
    "name": "listRuleTemplates",
    "method": "get",
    "path": "/v1/rules/templates",
    "perm": {
      "permission": "receivingRules",
      "level": "read",
      "scope": "workspace",
      "person": "admin"
    },
    "inbox": null
  },
  {
    "name": "listRuleVersions",
    "method": "get",
    "path": "/v1/rules/history",
    "perm": {
      "permission": "receivingRules",
      "level": "read",
      "scope": "workspace",
      "person": "admin"
    },
    "inbox": null
  },
  {
    "name": "listSegments",
    "method": "get",
    "path": "/v1/segments",
    "perm": {
      "permission": "audience",
      "level": "read",
      "scope": "workspace"
    },
    "inbox": null
  },
  {
    "name": "listWebhookDeliveries",
    "method": "get",
    "path": "/v1/webhooks/{id}/deliveries",
    "perm": {
      "permission": "configuration",
      "level": "read",
      "scope": "workspace",
      "person": "admin"
    },
    "inbox": null
  },
  {
    "name": "listWebhooks",
    "method": "get",
    "path": "/v1/webhooks",
    "perm": {
      "permission": "configuration",
      "level": "read",
      "scope": "workspace",
      "person": "admin"
    },
    "inbox": null
  },
  {
    "name": "listWorkspaceInvitations",
    "method": "get",
    "path": "/v1/workspaces/current/invitations",
    "perm": {
      "person": "admin",
      "level": "read"
    },
    "inbox": null
  },
  {
    "name": "listWorkspaceMembers",
    "method": "get",
    "path": "/v1/workspaces/current/members",
    "perm": {
      "person": "admin",
      "level": "read"
    },
    "inbox": null
  },
  {
    "name": "moveInboxMessage",
    "method": "post",
    "path": "/v1/inboxes/{id}/messages/{messageId}/move",
    "perm": {
      "permission": "receivedMail",
      "level": "write",
      "scope": "address",
      "person": "admin"
    },
    "inbox": "modify"
  },
  {
    "name": "pauseCampaign",
    "method": "post",
    "path": "/v1/campaigns/{id}/pause",
    "perm": {
      "permission": "sendEmail",
      "level": "on",
      "scope": "workspace",
      "person": "admin"
    },
    "inbox": null
  },
  {
    "name": "planAudienceMutation",
    "method": "post",
    "path": "/v1/audience-query/plan",
    "perm": {
      "permission": "audience",
      "level": "write",
      "scope": "workspace",
      "person": "admin"
    },
    "inbox": null
  },
  {
    "name": "previewCampaign",
    "method": "get",
    "path": "/v1/campaigns/{id}/preview",
    "perm": {
      "permission": "audience",
      "level": "read",
      "scope": "domain"
    },
    "inbox": null
  },
  {
    "name": "previewCampaignAudience",
    "method": "get",
    "path": "/v1/campaigns/{id}/audience",
    "perm": {
      "permission": "audience",
      "level": "read",
      "scope": "workspace"
    },
    "inbox": null
  },
  {
    "name": "previewCampaignTemplate",
    "method": "get",
    "path": "/v1/templates/{id}/preview",
    "perm": {
      "permission": "audience",
      "level": "read"
    },
    "inbox": null
  },
  {
    "name": "previewContactImport",
    "method": "post",
    "path": "/v1/contact-imports",
    "perm": {
      "permission": "audience",
      "level": "write",
      "scope": "workspace"
    },
    "inbox": null
  },
  {
    "name": "previewEmail",
    "method": "post",
    "path": "/v1/emails/preview",
    "perm": {
      "permission": "sentMail",
      "level": "read",
      "scope": "domain"
    },
    "inbox": null
  },
  {
    "name": "previewSegment",
    "method": "post",
    "path": "/v1/segments/{id}/preview",
    "perm": {
      "permission": "audience",
      "level": "read",
      "scope": "workspace"
    },
    "inbox": null
  },
  {
    "name": "provisionRegion",
    "method": "post",
    "path": "/v1/regions/{region}/provision",
    "perm": {
      "permission": "configuration",
      "level": "write",
      "scope": "workspace",
      "person": "admin"
    },
    "inbox": null
  },
  {
    "name": "publishCampaignTemplate",
    "method": "post",
    "path": "/v1/templates/{id}/publish",
    "perm": {
      "permission": "audience",
      "level": "write",
      "scope": "workspace"
    },
    "inbox": null
  },
  {
    "name": "queryAudience",
    "method": "post",
    "path": "/v1/audience-query/query",
    "perm": {
      "permission": "audience",
      "level": "read",
      "scope": "workspace"
    },
    "inbox": null
  },
  {
    "name": "redeliverInboundMessage",
    "method": "post",
    "path": "/v1/inbound/messages/{messageId}/redeliver",
    "perm": {
      "permission": "configuration",
      "level": "write",
      "scope": "workspace",
      "person": "admin"
    },
    "inbox": null
  },
  {
    "name": "releaseRetiredAddress",
    "method": "delete",
    "path": "/v1/inbound/retired/{address}",
    "perm": {
      "permission": "inboxes",
      "level": "write",
      "scope": "workspace",
      "person": "admin"
    },
    "inbox": null
  },
  {
    "name": "removeDomainMailFrom",
    "method": "delete",
    "path": "/v1/domains/{id}/mail-from",
    "perm": {
      "permission": "configuration",
      "level": "write",
      "scope": "domain",
      "person": "admin"
    },
    "inbox": null
  },
  {
    "name": "removeInboundSubdomain",
    "method": "delete",
    "path": "/v1/inbound/domains/{id}/subdomains/{subdomainId}",
    "perm": {
      "permission": "receivingRules",
      "level": "write",
      "scope": "workspace",
      "person": "admin",
      "credential": "lasting"
    },
    "inbox": null
  },
  {
    "name": "removeListMember",
    "method": "delete",
    "path": "/v1/lists/{id}/members/{contactId}",
    "perm": {
      "permission": "audience",
      "level": "write",
      "scope": "workspace",
      "person": "admin"
    },
    "inbox": null
  },
  {
    "name": "removeReceivingHost",
    "method": "delete",
    "path": "/v1/inbound/domains/{id}/hosts/{hostId}",
    "perm": {
      "permission": "receivingRules",
      "level": "write",
      "scope": "workspace",
      "person": "admin",
      "credential": "lasting"
    },
    "inbox": null
  },
  {
    "name": "renderCampaignPreviewImage",
    "method": "get",
    "path": "/v1/campaigns/{id}/preview-image",
    "perm": {
      "permission": "sendEmail",
      "level": "on",
      "scope": "domain"
    },
    "inbox": null
  },
  {
    "name": "renderCampaignTemplatePreviewImage",
    "method": "get",
    "path": "/v1/templates/{id}/preview-image",
    "perm": {
      "permission": "sendEmail",
      "level": "on"
    },
    "inbox": null
  },
  {
    "name": "replyToInboundThread",
    "method": "post",
    "path": "/v1/inbound/threads/{threadId}/reply",
    "perm": {
      "permission": "sendEmail",
      "level": "on",
      "scope": "address"
    },
    "inbox": "send"
  },
  {
    "name": "rescheduleCampaign",
    "method": "post",
    "path": "/v1/campaigns/{id}/reschedule",
    "perm": {
      "permission": "sendEmail",
      "level": "on",
      "scope": "workspace",
      "person": "admin"
    },
    "inbox": null
  },
  {
    "name": "rescheduleEmail",
    "method": "post",
    "path": "/v1/emails/{id}/reschedule",
    "perm": {
      "permission": "sendEmail",
      "level": "on",
      "scope": "domain"
    },
    "inbox": null
  },
  {
    "name": "restoreRoutingVersion",
    "method": "post",
    "path": "/v1/routing/versions/{v}/restore",
    "perm": {
      "permission": "receivingRules",
      "level": "write",
      "scope": "workspace",
      "person": "admin",
      "credential": "lasting"
    },
    "inbox": null
  },
  {
    "name": "restoreRuleVersion",
    "method": "post",
    "path": "/v1/rules/restore",
    "perm": {
      "permission": "receivingRules",
      "level": "write",
      "scope": "workspace",
      "person": "admin",
      "credential": "lasting"
    },
    "inbox": null
  },
  {
    "name": "resumeCampaign",
    "method": "post",
    "path": "/v1/campaigns/{id}/resume",
    "perm": {
      "permission": "sendEmail",
      "level": "on",
      "scope": "workspace",
      "person": "admin"
    },
    "inbox": null
  },
  {
    "name": "retryInboundWebhookDelivery",
    "method": "post",
    "path": "/v1/inbound/webhooks/{id}/deliveries/{deliveryId}/retry",
    "perm": {
      "permission": "configuration",
      "level": "write",
      "scope": "workspace",
      "person": "admin"
    },
    "inbox": null
  },
  {
    "name": "retryWebhookDelivery",
    "method": "post",
    "path": "/v1/webhooks/{id}/deliveries/{deliveryId}/retry",
    "perm": {
      "permission": "configuration",
      "level": "write",
      "scope": "workspace",
      "person": "admin"
    },
    "inbox": null
  },
  {
    "name": "revokeAgent",
    "method": "post",
    "path": "/v1/agents/{id}/revoke",
    "perm": {
      "person": "any",
      "credential": "dashboard"
    },
    "inbox": null
  },
  {
    "name": "revokeAgentToken",
    "method": "post",
    "path": "/v1/agent-tokens/{id}/revoke",
    "perm": {
      "permission": "configuration",
      "level": "write",
      "scope": "workspace",
      "person": "admin",
      "credential": "lasting"
    },
    "inbox": null
  },
  {
    "name": "revokeApiKey",
    "method": "post",
    "path": "/v1/api-keys/{id}/revoke",
    "perm": {
      "permission": "configuration",
      "level": "write",
      "scope": "workspace",
      "person": "admin",
      "credential": "lasting"
    },
    "inbox": null
  },
  {
    "name": "revokeInboxAppPassword",
    "method": "delete",
    "path": "/v1/inboxes/{id}/app-passwords/{passwordId}",
    "perm": {
      "permission": "configuration",
      "level": "write",
      "scope": "workspace",
      "person": "admin",
      "credential": "lasting"
    },
    "inbox": null
  },
  {
    "name": "revokeWorkspaceInvitation",
    "method": "delete",
    "path": "/v1/workspaces/current/invitations",
    "perm": {
      "person": "admin",
      "level": "write"
    },
    "inbox": null
  },
  {
    "name": "rotateInboundWebhookSecret",
    "method": "post",
    "path": "/v1/inbound/webhooks/{id}/rotate-secret",
    "perm": {
      "permission": "configuration",
      "level": "write",
      "scope": "workspace",
      "person": "admin",
      "credential": "lasting"
    },
    "inbox": null
  },
  {
    "name": "rotateWebhookSecret",
    "method": "post",
    "path": "/v1/webhooks/{id}/rotate-secret",
    "perm": {
      "permission": "configuration",
      "level": "write",
      "scope": "workspace",
      "person": "admin",
      "credential": "lasting"
    },
    "inbox": null
  },
  {
    "name": "saveRule",
    "method": "put",
    "path": "/v1/rules/scripts/{key}",
    "perm": {
      "permission": "receivingRules",
      "level": "write",
      "scope": "workspace",
      "person": "admin",
      "credential": "lasting"
    },
    "inbox": null
  },
  {
    "name": "scheduleCampaign",
    "method": "post",
    "path": "/v1/campaigns/{id}/schedule",
    "perm": {
      "permission": "sendEmail",
      "level": "on",
      "scope": "workspace",
      "person": "admin"
    },
    "inbox": null
  },
  {
    "name": "sendCampaign",
    "method": "post",
    "path": "/v1/campaigns/{id}/send",
    "perm": {
      "permission": "sendEmail",
      "level": "on",
      "scope": "workspace",
      "person": "admin"
    },
    "inbox": null
  },
  {
    "name": "sendEmail",
    "method": "post",
    "path": "/v1/emails/send",
    "perm": {
      "permission": "sendEmail",
      "level": "on",
      "scope": "domain"
    },
    "inbox": null
  },
  {
    "name": "sendEmailBatch",
    "method": "post",
    "path": "/v1/emails/batch",
    "perm": {
      "permission": "sendEmail",
      "level": "on",
      "scope": "domain"
    },
    "inbox": null
  },
  {
    "name": "sendEndpointVerification",
    "method": "post",
    "path": "/v1/endpoints/{name}/verification",
    "perm": {
      "permission": "receivingRules",
      "level": "write",
      "scope": "workspace",
      "person": "admin",
      "credential": "lasting"
    },
    "inbox": null
  },
  {
    "name": "setCampaignArchived",
    "method": "patch",
    "path": "/v1/campaigns/{id}/archive",
    "perm": {
      "permission": "sendEmail",
      "level": "on",
      "scope": "domain"
    },
    "inbox": null
  },
  {
    "name": "setCampaignPacing",
    "method": "post",
    "path": "/v1/campaigns/{id}/pacing",
    "perm": {
      "permission": "sendEmail",
      "level": "on",
      "scope": "workspace",
      "person": "admin"
    },
    "inbox": null
  },
  {
    "name": "setCampaignTemplateArchived",
    "method": "patch",
    "path": "/v1/templates/{id}/archive",
    "perm": {
      "permission": "audience",
      "level": "write",
      "scope": "workspace"
    },
    "inbox": null
  },
  {
    "name": "setDecisionOptIns",
    "method": "put",
    "path": "/v1/rules/decisions",
    "perm": {
      "permission": "receivingRules",
      "level": "write",
      "scope": "workspace",
      "person": "admin",
      "credential": "lasting"
    },
    "inbox": null
  },
  {
    "name": "setInboundAddressFlow",
    "method": "patch",
    "path": "/v1/inbound/addresses/{addressId}/flow",
    "perm": {
      "permission": "receivingRules",
      "level": "write",
      "scope": "workspace",
      "person": "admin",
      "credential": "lasting"
    },
    "inbox": null
  },
  {
    "name": "simulateInboxMessage",
    "method": "post",
    "path": "/v1/inboxes/{id}/simulate",
    "perm": {
      "permission": "receivedMail",
      "level": "write",
      "scope": "address",
      "person": "admin"
    },
    "inbox": null
  },
  {
    "name": "testCampaign",
    "method": "post",
    "path": "/v1/campaigns/{id}/test",
    "perm": {
      "permission": "sendEmail",
      "level": "on",
      "scope": "workspace"
    },
    "inbox": null
  },
  {
    "name": "testEndpoint",
    "method": "post",
    "path": "/v1/endpoints/{name}/test",
    "perm": {
      "permission": "receivingRules",
      "level": "write",
      "scope": "workspace",
      "person": "admin",
      "credential": "lasting"
    },
    "inbox": null
  },
  {
    "name": "testInboundWebhook",
    "method": "post",
    "path": "/v1/inbound/webhooks/{id}/test",
    "perm": {
      "permission": "configuration",
      "level": "write",
      "scope": "workspace",
      "person": "admin"
    },
    "inbox": null
  },
  {
    "name": "testRouting",
    "method": "post",
    "path": "/v1/routing/test",
    "perm": {
      "permission": "receivingRules",
      "level": "read",
      "scope": "workspace",
      "person": "admin"
    },
    "inbox": null
  },
  {
    "name": "testRules",
    "method": "post",
    "path": "/v1/rules/test",
    "perm": {
      "permission": "receivingRules",
      "level": "read",
      "scope": "workspace",
      "person": "admin"
    },
    "inbox": null
  },
  {
    "name": "testWebhook",
    "method": "post",
    "path": "/v1/webhooks/{id}/test",
    "perm": {
      "permission": "configuration",
      "level": "write",
      "scope": "workspace",
      "person": "admin"
    },
    "inbox": null
  },
  {
    "name": "unscheduleCampaign",
    "method": "post",
    "path": "/v1/campaigns/{id}/unschedule",
    "perm": {
      "permission": "sendEmail",
      "level": "on",
      "scope": "workspace",
      "person": "admin"
    },
    "inbox": null
  },
  {
    "name": "updateApiKey",
    "method": "patch",
    "path": "/v1/api-keys/{id}",
    "perm": {
      "permission": "configuration",
      "level": "write",
      "scope": "workspace",
      "person": "admin",
      "credential": "lasting"
    },
    "inbox": null
  },
  {
    "name": "updateCampaign",
    "method": "patch",
    "path": "/v1/campaigns/{id}",
    "perm": {
      "permission": "sendEmail",
      "level": "on",
      "scope": "domain"
    },
    "inbox": null
  },
  {
    "name": "updateCampaignTemplate",
    "method": "patch",
    "path": "/v1/templates/{id}",
    "perm": {
      "permission": "audience",
      "level": "write",
      "scope": "workspace"
    },
    "inbox": null
  },
  {
    "name": "updateContact",
    "method": "patch",
    "path": "/v1/contacts/{id}",
    "perm": {
      "permission": "audience",
      "level": "write",
      "scope": "workspace"
    },
    "inbox": null
  },
  {
    "name": "updateContactConsent",
    "method": "post",
    "path": "/v1/contacts/{id}/consent",
    "perm": {
      "permission": "audience",
      "level": "write",
      "scope": "workspace"
    },
    "inbox": null
  },
  {
    "name": "updateContactList",
    "method": "patch",
    "path": "/v1/lists/{id}",
    "perm": {
      "permission": "audience",
      "level": "write",
      "scope": "workspace",
      "person": "admin"
    },
    "inbox": null
  },
  {
    "name": "updateEndpoint",
    "method": "patch",
    "path": "/v1/endpoints/{name}",
    "perm": {
      "permission": "receivingRules",
      "level": "write",
      "scope": "workspace",
      "person": "admin",
      "credential": "lasting"
    },
    "inbox": null
  },
  {
    "name": "updateInboundAddress",
    "method": "patch",
    "path": "/v1/inbound/addresses/{addressId}",
    "perm": {
      "permission": "inboxes",
      "level": "write",
      "scope": "workspace",
      "person": "admin"
    },
    "inbox": null
  },
  {
    "name": "updateInboundDomain",
    "method": "patch",
    "path": "/v1/inbound/domains/{id}",
    "perm": {
      "permission": "receivingRules",
      "level": "write",
      "scope": "workspace",
      "person": "admin",
      "credential": "lasting"
    },
    "inbox": null
  },
  {
    "name": "updateInboundScanPolicy",
    "method": "patch",
    "path": "/v1/inbound/policy",
    "perm": {
      "permission": "receivingRules",
      "level": "write",
      "scope": "workspace",
      "person": "admin"
    },
    "inbox": null
  },
  {
    "name": "updateInboundSubdomain",
    "method": "patch",
    "path": "/v1/inbound/domains/{id}/subdomains/{subdomainId}",
    "perm": {
      "permission": "receivingRules",
      "level": "write",
      "scope": "workspace",
      "person": "admin",
      "credential": "lasting"
    },
    "inbox": null
  },
  {
    "name": "updateInboundThread",
    "method": "patch",
    "path": "/v1/inbound/threads/{threadId}",
    "perm": {
      "permission": "receivedMail",
      "level": "write",
      "scope": "address",
      "person": "admin"
    },
    "inbox": null
  },
  {
    "name": "updateInboundWebhook",
    "method": "patch",
    "path": "/v1/inbound/webhooks/{id}",
    "perm": {
      "permission": "configuration",
      "level": "write",
      "scope": "workspace",
      "person": "admin",
      "credential": "lasting"
    },
    "inbox": null
  },
  {
    "name": "updateInbox",
    "method": "patch",
    "path": "/v1/inboxes/{id}",
    "perm": {
      "permission": "receivedMail",
      "level": "write",
      "scope": "address",
      "person": "admin"
    },
    "inbox": "modify"
  },
  {
    "name": "updateInboxFolder",
    "method": "patch",
    "path": "/v1/inboxes/{id}/folders/{folder}",
    "perm": {
      "permission": "receivedMail",
      "level": "write",
      "scope": "address",
      "person": "admin"
    },
    "inbox": "modify"
  },
  {
    "name": "updateInboxMessage",
    "method": "patch",
    "path": "/v1/inboxes/{id}/messages/{messageId}",
    "perm": {
      "permission": "receivedMail",
      "level": "write",
      "scope": "address",
      "person": "admin"
    },
    "inbox": "modify"
  },
  {
    "name": "updateNewsletter",
    "method": "patch",
    "path": "/v1/newsletters/{id}",
    "perm": {
      "permission": "audience",
      "level": "write",
      "scope": "workspace",
      "person": "admin"
    },
    "inbox": null
  },
  {
    "name": "updateReceivingHost",
    "method": "patch",
    "path": "/v1/inbound/domains/{id}/hosts/{hostId}",
    "perm": {
      "permission": "receivingRules",
      "level": "write",
      "scope": "workspace",
      "person": "admin",
      "credential": "lasting"
    },
    "inbox": null
  },
  {
    "name": "updateRoute",
    "method": "patch",
    "path": "/v1/routing/routes/{id}",
    "perm": {
      "permission": "receivingRules",
      "level": "write",
      "scope": "workspace",
      "person": "admin",
      "credential": "lasting"
    },
    "inbox": null
  },
  {
    "name": "updateRule",
    "method": "patch",
    "path": "/v1/rules/scripts/{key}",
    "perm": {
      "permission": "receivingRules",
      "level": "write",
      "scope": "workspace",
      "person": "admin",
      "credential": "lasting"
    },
    "inbox": null
  },
  {
    "name": "updateRuleFromRecipe",
    "method": "put",
    "path": "/v1/rules/scripts/{key}/recipe",
    "perm": {
      "permission": "receivingRules",
      "level": "write",
      "scope": "workspace",
      "person": "admin",
      "credential": "lasting"
    },
    "inbox": null
  },
  {
    "name": "updateSegment",
    "method": "patch",
    "path": "/v1/segments/{id}",
    "perm": {
      "permission": "audience",
      "level": "write",
      "scope": "workspace",
      "person": "admin"
    },
    "inbox": null
  },
  {
    "name": "updateWebhook",
    "method": "patch",
    "path": "/v1/webhooks/{id}",
    "perm": {
      "permission": "configuration",
      "level": "write",
      "scope": "workspace",
      "person": "admin",
      "credential": "lasting"
    },
    "inbox": null
  },
  {
    "name": "updateWorkspaceSettings",
    "method": "patch",
    "path": "/v1/settings/workspace",
    "perm": {
      "permission": "configuration",
      "level": "write",
      "scope": "workspace",
      "person": "admin"
    },
    "inbox": null
  },
  {
    "name": "uploadAttachment",
    "method": "post",
    "path": "/v1/attachments",
    "perm": {
      "permission": "sendEmail",
      "level": "on",
      "scope": "domain"
    },
    "inbox": null
  },
  {
    "name": "uploadTemplateAsset",
    "method": "post",
    "path": "/v1/template-assets",
    "perm": {
      "permission": "audience",
      "level": "write",
      "scope": "workspace"
    },
    "inbox": null
  },
  {
    "name": "verifyDomain",
    "method": "post",
    "path": "/v1/domains/{id}/verify",
    "perm": {
      "permission": "configuration",
      "level": "write",
      "scope": "domain",
      "person": "admin"
    },
    "inbox": null
  },
  {
    "name": "waitForMessage",
    "method": "get",
    "path": "/v1/inboxes/{id}/messages",
    "perm": {
      "permission": "receivedMail",
      "level": "read",
      "scope": "address"
    },
    "inbox": "read"
  }
];
