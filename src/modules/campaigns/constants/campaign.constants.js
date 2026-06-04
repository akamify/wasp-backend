const CAMPAIGN_STATUSES = {
    DRAFT: "draft",
    QUEUED: "queued",
    RUNNING: "running",
    COMPLETED: "completed",
    FAILED: "failed",
    PAUSED: "paused",
    CANCELED: "canceled",
    CANCELLED: "cancelled",
};

const CAMPAIGN_TYPES = {
    BROADCAST: "broadcast",
    CSV: "csv",
    API: "api",
};

const CAMPAIGN_EVENTS = {
    CREATED: "campaign-created",
    SCHEDULED: "campaign-scheduled",
    PROCESSING: "campaign-processing",
    COMPLETED: "campaign-completed",
    FAILED: "campaign-failed",
};

const CAMPAIGN_SCHEDULE_FREQUENCIES = {
    ONCE: "once",
    DAILY: "daily",
    WEEKLY: "weekly",
};

const CAMPAIGN_QUEUE_JOBS = {
    SEND_MESSAGE: "send-message",
    DISPATCH_SCHEDULED: "dispatch-scheduled-campaign",
};

const CAMPAIGN_AUDIENCE_MODES = {
    MANUAL: "manual",
    TAGS: "tags",
};

module.exports = { CAMPAIGN_STATUSES, CAMPAIGN_TYPES, CAMPAIGN_EVENTS, CAMPAIGN_SCHEDULE_FREQUENCIES, CAMPAIGN_QUEUE_JOBS, CAMPAIGN_AUDIENCE_MODES };
