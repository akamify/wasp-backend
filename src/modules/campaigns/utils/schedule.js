const { CAMPAIGN_SCHEDULE_FREQUENCIES } = require("@modules/campaigns/constants/campaign.constants");

function normalizeScheduleInput({ scheduledAt, schedule }) {
    const frequency = String(schedule?.frequency || CAMPAIGN_SCHEDULE_FREQUENCIES.ONCE).toLowerCase();
    const allowed = new Set(Object.values(CAMPAIGN_SCHEDULE_FREQUENCIES));
    const normalizedFrequency = allowed.has(frequency) ? frequency : CAMPAIGN_SCHEDULE_FREQUENCIES.ONCE;
    const parsedStartAt = scheduledAt ? new Date(scheduledAt) : null;
    const parsedEndAt = schedule?.endAt ? new Date(schedule.endAt) : null;
    const startAt = parsedStartAt && !Number.isNaN(parsedStartAt.getTime()) ? parsedStartAt : null;
    const endAt = parsedEndAt && !Number.isNaN(parsedEndAt.getTime()) ? parsedEndAt : null;
    const maxOccurrences = Number.isFinite(Number(schedule?.maxOccurrences))
        ? Math.max(Math.floor(Number(schedule.maxOccurrences)), 1)
        : undefined;

    return {
        frequency: normalizedFrequency,
        startAt,
        endAt,
        maxOccurrences,
        isRecurring:
            normalizedFrequency === CAMPAIGN_SCHEDULE_FREQUENCIES.DAILY ||
            normalizedFrequency === CAMPAIGN_SCHEDULE_FREQUENCIES.WEEKLY,
    };
}

function addFrequency(date, frequency) {
    const next = new Date(date);
    if (frequency === CAMPAIGN_SCHEDULE_FREQUENCIES.WEEKLY) {
        next.setUTCDate(next.getUTCDate() + 7);
        return next;
    }
    next.setUTCDate(next.getUTCDate() + 1);
    return next;
}

function getFirstFutureRunAt(startAt, frequency, now = new Date()) {
    if (!(startAt instanceof Date) || Number.isNaN(startAt.getTime())) return null;
    if (startAt.getTime() > now.getTime()) return startAt;
    if (
        frequency !== CAMPAIGN_SCHEDULE_FREQUENCIES.DAILY &&
        frequency !== CAMPAIGN_SCHEDULE_FREQUENCIES.WEEKLY
    ) {
        return startAt;
    }

    let next = new Date(startAt);
    let guard = 0;
    while (next.getTime() <= now.getTime() && guard < 3700) {
        next = addFrequency(next, frequency);
        guard += 1;
    }
    return next.getTime() > now.getTime() ? next : null;
}

function getNextRunAt({ lastRunAt, frequency, endAt, maxOccurrences, occurrencesRun, now = new Date() }) {
    if (
        frequency !== CAMPAIGN_SCHEDULE_FREQUENCIES.DAILY &&
        frequency !== CAMPAIGN_SCHEDULE_FREQUENCIES.WEEKLY
    ) {
        return null;
    }

    const runCount = Number(occurrencesRun || 0);
    if (maxOccurrences && runCount >= Number(maxOccurrences)) return null;

    const base = lastRunAt instanceof Date ? lastRunAt : new Date(lastRunAt);
    if (Number.isNaN(base.getTime())) return null;
    let next = addFrequency(base, frequency);
    let guard = 0;
    while (next.getTime() <= now.getTime() && guard < 3700) {
        next = addFrequency(next, frequency);
        guard += 1;
    }

    const end = endAt ? new Date(endAt) : null;
    if (end && !Number.isNaN(end.getTime()) && next.getTime() > end.getTime()) return null;
    return next;
}

function buildRecurringSchedule({ scheduledAt, schedule, now = new Date() }) {
    const normalized = normalizeScheduleInput({ scheduledAt, schedule });
    if (!normalized.isRecurring) return null;
    const nextRunAt = getFirstFutureRunAt(normalized.startAt, normalized.frequency, now);
    return {
        frequency: normalized.frequency,
        status: "active",
        startAt: normalized.startAt,
        endAt: normalized.endAt || undefined,
        nextRunAt,
        maxOccurrences: normalized.maxOccurrences,
        occurrencesRun: 0,
    };
}

module.exports = {
    normalizeScheduleInput,
    getFirstFutureRunAt,
    getNextRunAt,
    buildRecurringSchedule,
};
