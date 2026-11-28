import type { JobHandler } from '../core/types.js';
import { campaignStatsJob } from '../campaigns/stats.js';
import { releaseScheduled } from './scheduled.js';
import { cancelPageJob } from '../campaigns/launch.js';
import { runCampaign } from '../campaigns/run.js';

// Pre-migration email.dispatch job rows complete as no-ops: sending_emails.status drives the dispatcher (src/sending/dispatcher.ts).
const retiredDispatchJob: JobHandler = async () => {};
// Job rows of the previous release's prepare/expand/finish chain continue as runs of the same campaign.
export const jobHandlers: Record<string, JobHandler> = { 'sending.cancelPage':cancelPageJob, 'sending.campaignStats': campaignStatsJob, 'sending.release': releaseScheduled, 'email.dispatch': retiredDispatchJob, 'campaign.run': runCampaign, 'campaign.prepare': runCampaign, 'campaign.expand': runCampaign, 'campaign.finish': runCampaign };
