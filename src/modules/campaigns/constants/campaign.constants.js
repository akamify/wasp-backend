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

module.exports = { CAMPAIGN_STATUSES, CAMPAIGN_TYPES, CAMPAIGN_EVENTS };
