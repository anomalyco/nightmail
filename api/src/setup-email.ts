// Onboarding's first email (sendDomainTestEmail with a subject and text): the person sends it to their own sign-in
// address from "<productName> Setup" at setup@ on the workspace's built-in domain, replies from their own mail app, and
// the reply comes back into the workspace (the built-in domain's catch-all delivers it to its Inbox). The dashboard
// prefills these words; sent unchanged they are ours, so they skip the classifier as the fixed test email does
// (sending/front-door.ts platformTestVerdict), and an edited copy is screened like any send. They read as a real message, never as a
// test or a placeholder: spam filters mark mail that does (a customer's first email landed in spam for it). Sent as plain
// text. Only the brand is imported: the dashboard bundles this file.
import { productName } from './brand.js';

export const SETUP_SENDER = { local: 'setup', name: `${productName} Setup` } as const;
export const SETUP_EMAIL = {
  subject: 'How’s your day going?',
  text: `Hit reply and tell us in a few words.\n\nYour answer comes straight back to ${productName}, and you’ll watch it land on the setup page.`,
} as const;
export const SETUP_LIMITS = { subject: 200, text: 2000 } as const;
