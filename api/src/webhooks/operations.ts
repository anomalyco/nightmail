import { registerSenderScore } from '../sender-score.js';
import { registerUsage } from '../usage.js';
import { wrapModuleLoad } from '../core/errors.js';
import type { App, JobHandler } from '../core/types.js';
import { retryDatabaseFailures } from '../jobs.js';
import { registerDomainsAndSettings, registerMetrics } from '../domains/routes.js';
import { domainVerify, domainMx } from '../domains/hosted.js';
import { sesJob, simulatedFeedbackJob, simulatedFeedbackRecovery, publishJob, publishBatchJob } from '../ses/feedback.js';
import { registerWebhooks, webhookJob, resumeDeliveries } from './deliveries.js';
import { registerUnsubscribe } from '../audience/unsubscribe.js';
import { registerPublicEvents } from '../ses/sns-ingress.js';

export function registerOperations(app: App) {
  registerDomainsAndSettings(app);
  registerWebhooks(app);
  registerPublicEvents(app);
  registerUnsubscribe(app);
  registerMetrics(app);
  registerSenderScore(app);
  registerUsage(app);
}
export const operationJobs: Record<string, JobHandler> = { 'domain.placement': retryDatabaseFailures(async (...args) => { await (await wrapModuleLoad(() => import('../placement.js'))).shadowPlacement(...args); }), 'domain.verify': retryDatabaseFailures(domainVerify), 'domain.setupCheck': retryDatabaseFailures(async (...args) => { await (await wrapModuleLoad(() => import('../domain-setup.js'))).domainSetupCheckJob(...args); }), 'domain.linkCheck': retryDatabaseFailures(async (...args) => { await (await wrapModuleLoad(() => import('../domain-setup.js'))).domainLinkCheckJob(...args); }), 'domain.linkCleanup': retryDatabaseFailures(async (...args) => { await (await wrapModuleLoad(() => import('../domain-setup.js'))).domainLinkCleanupJob(...args); }), 'domain.mx': retryDatabaseFailures(domainMx), 'domain.builtin': retryDatabaseFailures(async (...args) => { await (await wrapModuleLoad(() => import('../builtin-domain.js'))).builtinDomainJob(...args); }), 'operation.webhook': retryDatabaseFailures(webhookJob), 'operation.resumeDeliveries': retryDatabaseFailures(resumeDeliveries), 'operation.ses': retryDatabaseFailures(sesJob), 'operation.simulatedFeedback': retryDatabaseFailures(simulatedFeedbackJob), 'operation.simulatedFeedbackRecovery': retryDatabaseFailures(simulatedFeedbackRecovery), 'operation.publish': retryDatabaseFailures(publishJob), 'operation.publishBatch': retryDatabaseFailures(publishBatchJob) };
