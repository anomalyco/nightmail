---
title: Privacy Policy
description: How Anomaly handles personal data in Nightmail: what we collect about customers, how we process the mail customers send and receive, screening and AI, retention, and your rights.
updated: 26 November 2026
effective: 20 November 2026
changes: abuseHolds
---

This policy explains how **Anomaly Innovations, Inc.** ("Anomaly", "we", "us") handles personal data in **Nightmail**, the email service at nightmail.dev: its website, API, dashboard, SDK, MCP server, and IMAP and SMTP access.

## 1. Two roles: controller and processor

Nightmail handles personal data in two different roles.

| Data | Whose decision | Our role |
| --- | --- | --- |
| **About our customers:** people who sign in, workspace members, billing contacts, people who contact support or report abuse | Ours | **Controller.** This policy applies in full. |
| **In our customers' mail:** the people our customers email, the people who email them, contacts and lists, and message content | The customer's | **Processor** (a "service provider" under US state privacy laws). The customer's own privacy policy applies. We process this data on the customer's instructions, under our [Terms of Service](/legal/terms) and, where one is signed, our Data Processing Addendum. |
| **Customer mail we screen or fingerprint to prevent abuse and to compute sender scores** | Ours, for this purpose only | **Controller**, only to keep the service safe for recipients and customers ([section 5](#automated-screening-and-ai)). We don't use it for anything else. |

**If you got an email sent through Nightmail, or sent mail to an address that uses Nightmail,** the business that uses Nightmail decides what happens to your data. Contact them first. If you contact us, we'll pass your request to them where we can identify them ([section 12](#rights-of-people-in-our-customers-mail)).

## 2. Data about our customers

| What | Details | Source |
| --- | --- | --- |
| **Identity** | Name, email address, and the account identifier from Anomaly's sign-in service (account.anoma.ly). You sign in there with GitHub, with Google, with a link or code emailed to you, or with your email and a password. If you use GitHub or Google: its account ID, its email address and whether it's verified, and for Google the Google Workspace domain if there is one. | You, through the sign-in service (and GitHub or Google, if you use one) |
| **Workspaces** | Workspaces you belong to, your role (owner, admin or member), and invitations (email address and role) | You and other members |
| **Credentials** | API keys, MCP grants, agent tokens, inbox keys and app passwords. Keys are stored as hashes; we can't read them back. | You |
| **Sessions** | A session cookie, valid for up to 7 days. Sessions don't record your IP address or browser. Once abuse monitoring is on, signing in keeps a keyed code of your network and your browser from a fixed list (see **Abuse and fraud signals**). | Your browser |
| **Sign-in attempts** | Issuer, account ID, sign-in method and provider, email and name, outcome and time, and, once abuse monitoring is on, that sign-in's keyed codes (see **Abuse and fraud signals**). Kept 30 days; refused sign-in requests 90 days. | Sign-in service |
| **Waitlist** | If we refuse a sign-in because Nightmail isn't open to you yet: the email address and name from that sign-in, when you first and last tried, and how many times. Used only to tell you when Nightmail opens. Kept until we've emailed you that it's open, or 1 year after your last attempt. | Sign-in service (and GitHub or Google, if you use one) |
| **Abuse and fraud signals** | **Abuse monitoring started on 21 November 2026 at 15:30 UTC**, and nothing from before that date is kept. Once it's on, when you sign in we keep: keyed codes of your network (shortened as in the audit trail), of your email address, of the mailbox it names where your provider documents how it reads addresses (for example, Gmail ignores dots and "+tags"), of your email domain when it's your own rather than a public mailbox provider's, and of the GitHub or Google account you signed in with; your network provider and country; your browser and system from a short fixed list (for example, "Chrome 131 on macOS"), or "other"; and three flags: a disposable email service, a "+tag" address, and a sign-in we refused. From your payments: a keyed code of each card's fingerprint. This also covers people whose sign-in we refuse. A keyed code shows whether two accounts share a value without showing the value. Because we hold the key, we can check whether a value we already know matches one. We use these only to notice when several accounts belong to the same person or operation ([section 5.7](#linking-related-accounts)). | Your browser, the sign-in service and our payment records |
| **Activity (audit trail)** | Who did what in a workspace (for example, created a key or changed a role), when, the reason, the request ID, your network (shortened to the first three parts of an IPv4 address, or a /48 for IPv6) and browser family. Never secrets or message content. | Our systems |
| **Billing** | Stripe customer ID; card brand, last four digits, expiry and fingerprint; top-ups, refunds, disputes, balance and usage history. **Stripe holds your full card number; we never see it.** | You and Stripe |
| **Usage** | How much each workspace sends, receives and stores, and its sender score and standing | Our systems |
| **Support** | Your support conversations by chat or email, with the AI support agent or with staff: your messages and screenshots, the page you were on, recent request IDs, notes support keeps about you between conversations, and whether you allowed support to read message content | You and our support agent |
| **Notices** | Emails we send you about billing, limits, standing and these policies | Our systems |
| **Product news and service status** | Emails about new features and about incidents or maintenance. Every one has an unsubscribe link. Billing, security and policy notices continue either way. | Our systems |
| **Website and dashboard usage** | Pages you open, links and sign-in controls you click, the referring host, campaign tags, country, device class and viewport. To count daily visitors, our server combines your IP address and browser user agent with a new random secret each UTC day. We keep the resulting code, not the IP address or user agent, in usage records and discard the old secret. Dashboard dialogs, form errors and error messages may be tied to your account and workspace IDs. Never what you type, email addresses or message content. Nothing is stored on your device, and nothing is recorded when your browser sends Do Not Track or Global Privacy Control. Kept 400 days and used to improve the product. | Your browser |
| **Technical logs** | Request logs (method, path, status, timing and error codes), and connection logs from the IMAP and SMTP gateway, which may include the connecting IP address. Request logs are kept about 3 days; gateway logs 30 days. | Our systems |

**Cookies.** Nightmail uses a session cookie (up to 7 days) and short-lived sign-in cookies (10 minutes). After a refused sign-in, one of them holds your email address so the page can show where we'll write to you. The Nightmail website and dashboard use **no analytics or advertising cookies**, and dashboard usage records store nothing on your device.

## 3. Data in our customers' mail

### 3.1 Sending

- Recipient, Cc and Bcc addresses; From, Reply-To and sender name; subject; HTML and text content; attachments; custom headers.
- Delivery events: sent, delivered, bounced (with the reason), complained, rejected and delayed. If tracking is on, opened and clicked, with the link clicked and whether the event looked like it came from a bot. Today, tracking is on by default for marketing mail and campaigns, and off for transactional mail and replies; customers can turn it off for any message or campaign.
- Contacts, lists and segments the customer uploads, with consent, unsubscribe and suppression records, and the last time each contact opened or clicked.
- Campaign drafts and templates.

### 3.2 Receiving

- The sender, recipients, subject, headers, text and HTML bodies, and attachments of mail sent to a customer's addresses.
- Authentication results (SPF, DKIM and DMARC) and Amazon's spam and virus verdicts.
- What the customer's routing and rules did with each message: delivered, labeled, junked, forwarded, posted to Slack or Discord, or sent to a webhook.
- AI decision questions and the scores returned.
- For inboxes: folders, read state and flags.

### 3.3 What customers send elsewhere

Customers can send their data to places they choose: their webhooks, Slack or Discord, forwarding addresses, MCP clients and AI agents, mail clients over IMAP, and their own AWS account. Those are the customer's choices and aren't our subprocessors.

## 4. Why we use data, and our legal bases

| Purpose | Data | Legal basis (EU and UK) |
| --- | --- | --- |
| Provide the service: sign you in, run workspaces, send and receive mail as customers instruct | Account data; customer mail as processor | Contract |
| Billing: take payments, keep the balance, send receipts and notices, handle refunds and disputes | Billing and usage data | Contract; legal obligation (tax and accounting records) |
| Security, fraud and abuse prevention: spam screening, sender scores and limits, card-fraud checks, noticing related accounts, {{before abuseHolds: from {{date abuseHolds}} }}holds for review ([section 5.7](#linking-related-accounts)), investigating abuse reports | Usage data; abuse and fraud signals; screening results; message metadata and content as screened or fingerprinted ([section 5](#automated-screening-and-ai)) | Legitimate interests (protecting recipients, customers and our infrastructure) |
| Support, including the AI support agent | Account data; support conversations; message content only with your permission | Contract; consent for message content |
| Service and policy notices | Contact details | Contract; legitimate interests |
| Product news and service status emails to customers | Contact details | Legitimate interests (telling customers about the service they use). You can unsubscribe at any time. |
| Improve the dashboard: find where people get stuck or run into errors | Dashboard usage | Legitimate interests (making the product easier to use) |
| Improve the service and publish aggregate statistics (for example, total mail volume on our homepage) | Aggregated usage | Legitimate interests. Aggregates don't identify anyone. |
| Comply with the law and respond to valid legal requests | As needed | Legal obligation |

We **don't sell** personal data, don't "share" it for cross-context behavioral advertising, and don't use it for advertising.

## 5. Automated screening and AI

### 5.1 What is screened

| What | When | What the classifier receives |
| --- | --- | --- |
| **Spam screen on sending** | Messages sent through Nightmail's shared (Hosted) sending pool, before they reach Amazon. Repeated identical content may reuse a recent result. | The sender name and address, subject, visible text from the HTML and text parts, and the domains of links, up to about 24 KB per message |
| **Forwarded mail** | When a rule forwards a received message to an outside address | The same parts of the forwarded message |
| **AI decisions** | Only for receiving domains or routes the customer opted in | The subject, sender, authentication results and up to 8,000 characters of visible text, plus the customer's questions |

Received mail isn't sent to the classifier unless the customer turns on AI decisions or a forward. BYO AWS sending isn't screened unless the customer asks for it.

### 5.2 Who runs it

The classifier is **Jev**, from **TypeSafe AI**. Nightmail calls TypeSafe's API directly.

### 5.3 What the results are used for

- A message whose spam score is over the threshold is **rejected before it's sent**. The rejection is recorded with the score and model name.
- Rejection rates feed the workspace's **sender score**, which sets its daily sending limit and can lead to a warning, a hold on marketing, or a pause.
- AI decision scores are given to the customer's rules, which decide what to do.

### 5.4 People and automated decisions

- Anomaly staff who review abuse see a workspace's score history, bounce and complaint counts by recipient domain, and, for the last 7 days, the **subject line (first 120 characters) and score** of each rejected message. They don't see message bodies.
- A workspace can ask for a person to review any warning, hold or pause, and tell us why it thinks the decision is wrong (see the [Terms of Service](/legal/terms#getting-back-and-appeals)).
- **Holds for review.** {{before abuseHolds: From {{date abuseHolds}}, abuse monitoring}}{{after abuseHolds: Abuse monitoring}} can pause a workspace's sending automatically in one case ([section 5.7](#linking-related-accounts)). A person reviews every such hold, whether or not you ask.
- These decisions concern a customer's sending account, not the people in the customer's mail.

### 5.5 Training

- **Anomaly doesn't use customer mail or AI decision questions to train AI models.**
- **TypeSafe has confirmed to us in writing that it doesn't retain or train on** the content Nightmail sends to it.

### 5.6 AI support agent

- Support email and the dashboard's **Help** chat are answered first by an AI agent that runs on **Claude**, a model from **Anthropic**, through Anomaly's own model gateway.
- To answer, Anthropic receives your messages and screenshots, what the agent looks up in your account ([section 6](#support-access)), and the notes support keeps about you. It gets message content only with your permission.
- The agent's answers can be wrong. You can ask for a person at any time: say so, or use **Talk to a person** in the chat.
- **Neither Anomaly nor Anthropic uses support conversations to train AI models.**

### 5.7 Linking related accounts

**Abuse monitoring started on 21 November 2026 at 15:30 UTC**, as named in [section 2](#data-about-our-customers). {{before abuseHolds: Before {{date abuseHolds}}, it is monitor-only: it doesn't block, pause or limit accounts by itself. From {{date abuseHolds}} at 00:00 UTC, it}}{{after abuseHolds: It}} can pause sending in one case, a **hold for review**, described below. Otherwise it doesn't block, pause or limit accounts by itself.

- **Why.** To notice one person or operation using several accounts: to send spam or commit payment fraud through more than one, to come back after a pause, or to multiply the free allowance. {{before abuseHolds:From {{date abuseHolds}}, also}}{{after abuseHolds:Also}} to stop the same mail going out from several workspaces at once while a person looks at it (the hold for review below).
- **What we compare.** The abuse and fraud signals of accounts ([section 2](#data-about-our-customers)). For mail that Amazon accepted from Nightmail's shared (Hosted) sending pool, we also take **fingerprints** from a small sample of messages: a keyed numeric summary of the wording, and keyed codes of the domains the message links to and is sent from. We don't fingerprint mail sent through your own AWS account, mail that wasn't sent (still scheduled, or cancelled, suppressed or rejected), or any message or campaign created before monitoring started.
- **This compares customers with each other.** Signals and fingerprints from different workspaces are kept together so that equal values can be found. It's the one place where data taken from your workspace is compared with other customers'. No customer can see anything about another.
- **What these records hold.** No message text, subject, recipient or address. A fingerprint can't be turned back into a message. Because we hold the key, we can tell whether a message or domain we already have matches one. The messages themselves stay in your sending log for 30 days, as before.
- **Who sees it.** When accounts share signals, Anomaly staff who review abuse can see which accounts look related and which kinds of signal they share, never the values behind the codes.
{{before abuseHolds: - **A person decides.** Before {{date abuseHolds}}, nothing is blocked, paused or limited automatically because accounts look related. A workspace can ask for a review as in [section 5.4](#people-and-automated-decisions).
}}- **Hold for review{{before abuseHolds:, from {{date abuseHolds}}}}.**
  - **When.** If several workspaces that are new senders or below good standing ([Acceptable Use Policy, section 10](/legal/acceptable-use#score-and-daily-limit)) send the same or nearly the same message to many people outside those workspaces, we may pause their sending automatically, without a person deciding first.
  - **What it does.** Sending stops, as in any pause ([Terms, section 8.2](/legal/terms#the-enforcement-ladder)). Receiving, inboxes and the dashboard keep working, and nothing in the workspace is deleted. Mail already queued waits up to 72 hours; if the hold is still on then, that mail is canceled.
  - **What it isn't.** A hold isn't a finding that you broke our rules. It leaves no strike ([Terms, section 8.4](/legal/terms#getting-back-and-appeals)), and it never closes an account or workspace.
  - **How you're told.** Owners and admins get an email, and the dashboard shows that sending is held for review.
  - **Review.** A person at Anomaly reviews every hold and decides whether to lift it. You don't need to ask, but you can tell us more at any time: use **Help** in the dashboard or email [support@nightmail.dev](mailto:support@nightmail.dev). When a hold is lifted, sending resumes at the limit the workspace had before.
  - **What doesn't cause a hold.** Accounts aren't held, limited or closed automatically because they look related in other ways, such as sharing a network, a payment card or the domain of a sign-in email address. A workspace that is no longer a new sender and is in good standing is never held.
- **Your choices.** You can ask what these records hold about your account, object to it, or ask us to erase it ([section 11](#your-rights)). We don't use these signals for anything else, and we don't sell them or share them outside Anomaly.

## 6. Support access

- **An AI agent answers first.** Mail to [support@nightmail.dev](mailto:support@nightmail.dev) and the dashboard's **Help** chat go first to our AI support agent ([section 5.6](#ai-support-agent)).
- **It confirms who you are first.** In the dashboard, Help knows you're signed in. By email, it checks that the message really came from your account's address. Until then, it looks at no account.
- **It works with your own access.** It sees only the workspaces you belong to, never another customer's, and only while your conversation is open. It reads; it never changes anything in your workspace on its own. A change happens only after you confirm it, signed in to the dashboard.
- **Message content only with your permission.** A prompt in the Help chat lets support read message content for that one conversation, in that one workspace. It's off until you choose. A request by email never includes message content.
- Without your permission, support sees settings, domains, the addresses, subjects and status of mail, delivery events, error codes and failed API requests, webhook delivery status (not payloads or URLs), standing, billing, campaigns (not their content) and your workspace's activity trail. Never keys, passwords or webhook secrets.
- **People at Anomaly.** Support staff can read support conversations and the notes support keeps, and can step in to answer you themselves. A staff member who needs to look at your workspace gets read-only access for your request, limited to the workspaces you belong to, that expires within **2 hours**.
- Your workspace's **Activity** page shows "Nightmail support viewed this workspace" with the request. Every support read is logged and kept 90 days.
- Any other access to systems that hold message content is limited to Anomaly personnel who need it to run, secure or repair Nightmail.

## 7. Subprocessors and other recipients

The providers that process personal data for Nightmail, what each does and where, are listed on the [Subprocessors](/legal/subprocessors) page. We update that page before a new subprocessor starts processing personal data.

We also disclose data when the law requires it, to protect people or the service, or to a buyer or successor in a merger or sale, under this policy.

## 8. International transfers

Nightmail stores and processes data mainly in the **United States**. Cloudflare may process requests in data centers close to the user anywhere in the world. When we transfer personal data from the EU, the UK or Switzerland, we rely on the European Commission's Standard Contractual Clauses (with the UK Addendum for UK data) or another transfer mechanism the law allows. There's no EU data-residency option today.

## 9. How long we keep data

| Data | How long |
| --- | --- |
| **Received mail** (text, HTML, headers, attachments) to ordinary addresses | **Kept until the customer deletes it** (no automatic expiry). To delete received mail for ordinary addresses, a workspace owner emails [support@nightmail.dev](mailto:support@nightmail.dev). Mail older than 90 days counts as billable storage. |
| Raw original message (MIME) for ordinary addresses | 90 days |
| **Persistent inbox** mail | Until deleted |
| **Agent inbox** mail | Erased when the inbox ends: by default after 24 hours plus 24 hours of grace (at most 30 days plus 7); a 45-day safety rule backs this up |
| Incoming mail awaiting processing | 3 days |
| Mail that couldn't be matched to a customer (quarantine) | 30 days |
| Mail held because a balance is unpaid | Until the customer adds credit or the workspace is closed |
| **Sent mail** records (content, recipients) and delivery events | 30 days |
| Received-mail events and webhook delivery records | 30 days |
| Contacts, lists, consent and suppression records | Until the customer deletes them. Unsubscribe and suppression records may be kept after a contact is deleted so the opt-out keeps working. |
| Routing and rule version history | Up to 1 year |
| Audit trail | 1 year; billing and payment events 7 years; support reads 90 days |
| Support conversations (messages, screenshots and what the agent looked up) | 90 days after the conversation ends. Email to support@ also stays in our support mailbox until we delete it. |
| Support tickets, and each conversation's summary | 1 year after the ticket is resolved or the conversation is closed |
| Notes support keeps about you | Until deleted; support keeps the latest 50 |
| Billing ledger and payment records | 7 years, including after a workspace is closed |
| Stripe webhook events | 90 days |
| Sign-in attempts | 30 days; refused sign-in requests 90 days |
| Waitlist | Until we've emailed you that Nightmail is open, or 1 year after your last sign-in attempt |
| Abuse and fraud signals | 90 days after we last saw each one (for example, your last sign-in from that network), whether or not the workspace is still open. Fingerprints of sent mail: 30 days. An account keeps at most 100 values of each kind; older ones are dropped first. |
| Sessions | Until they expire (up to 7 days) |
| Request logs | About 3 days; IMAP and SMTP gateway logs 30 days |
| Dashboard usage | 400 days |
| Database backups | Until they expire on our database provider's backup schedule. Deleting data doesn't remove it from backups before then. |

When a workspace is closed, we delete its data as described in the [Terms of Service](/legal/terms#ending-the-agreement).

## 10. Security

- Data is encrypted in transit with TLS. IMAP and SMTP require TLS before you sign in: implicit TLS on ports 993 and 465, or STARTTLS on ports 143 and 587.
- Stored data is encrypted at rest by our infrastructure providers (Amazon S3, Cloudflare R2 and PlanetScale).
- Webhook secrets and endpoint URLs are encrypted in the database. API keys and support tokens are stored as hashes.
- Customers' data is separated by workspace in every database query and storage path. The one exception is abuse monitoring ([section 5.7](#linking-related-accounts)), which compares keyed codes from different workspaces and which only staff who review abuse can read.
- The audit trail can't be changed or deleted before its retention ends, even by administrators.
- Support access, by the AI agent or a person, is limited to the workspaces of the person it's helping and lasts only while their request is open (for a person, at most 2 hours). It reads, changes nothing without that person's confirmation, and is logged.

We'll notify affected customers and authorities of a personal data breach as the law requires.

## 11. Your rights

Depending on where you live, you may have the right to access, correct, delete or export your personal data, to object to or restrict some uses, to withdraw consent, and to complain to a data-protection authority. US state residents may also have the right to know, delete and correct, and not to be discriminated against for using these rights. We don't sell or share personal data for advertising.

To use these rights, email [privacy@nightmail.dev](mailto:privacy@nightmail.dev). We'll verify who you are and answer within the time the law requires (usually 30 or 45 days).

**Abuse and fraud signals.** These rights cover the signals in [section 5.7](#linking-related-accounts). Once we've verified that the account is yours, we tell you which kinds of signal we hold about it and how many, never anything about another customer. If you ask, we erase them, and where we uphold an objection we stop recording them for your account. If we must keep recording to protect the service, we'll tell you why. If we refused your sign-in and you never had an account, tell us which account you used at Anomaly's sign-in service: we check that it's yours and don't act on an email address alone. An erasure also covers what was noted about you before it but not yet processed.

**Data Processing Addendum.** Business customers who need one can request our Data Processing Addendum at [privacy@nightmail.dev](mailto:privacy@nightmail.dev).

## 12. Rights of people in our customers' mail

If you received mail sent through Nightmail, or sent mail to an address hosted on Nightmail:

- **To unsubscribe,** use the link in the email. It works without contacting us.
- **To access or delete your data,** contact the business that sent you the mail or owns the address you wrote to. They control your data.
- **If you contact us** at [privacy@nightmail.dev](mailto:privacy@nightmail.dev), we'll forward your request to that business where we can identify it, and help them respond as our contracts require.
- **Abuse monitoring** ([section 5.7](#linking-related-accounts)) keeps nothing about you as a recipient: no address, and no code made from one.
- **To report spam or abuse,** email [abuse@nightmail.dev](mailto:abuse@nightmail.dev) with the full headers.

## 13. Children

Nightmail is a business service and isn't for children. You must be at least **18** to create an account. We don't knowingly collect personal data from children; if we learn we have, we'll delete it.

## 14. Changes

We'll post updates on this page and tell customers by email or in the dashboard at least 30 days before material changes take effect.
{{before abuseHolds:
**Announced changes.**

- **{{date abuseHolds}}:** holds for review ([section 5.7](#linking-related-accounts)), with matching changes to the [Terms of Service](/legal/terms#the-enforcement-ladder) and the [Acceptable Use Policy](/legal/acceptable-use#how-we-enforce-this-policy). Announced on {{announced abuseHolds}}.
}}
## 15. Contact

Anomaly Innovations, Inc.\
2443 Fillmore St #380-6343, San Francisco, CA 94115, United States

Privacy and data requests: [privacy@nightmail.dev](mailto:privacy@nightmail.dev)
