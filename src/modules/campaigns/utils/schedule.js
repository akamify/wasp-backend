const { HttpError } = require("@shared/utils/httpError");
const { CAMPAIGN_SCHEDULE_FREQUENCIES } = require("@modules/campaigns/constants/campaign.constants");

const DEFAULT_TIMEZONE = "Asia/Kolkata";
const TIME_OF_DAY_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const VALID_TYPES = new Set(Object.values(CAMPAIGN_SCHEDULE_FREQUENCIES));

function assertTimezone(timezone) {
    const value = String(timezone || DEFAULT_TIMEZONE).trim() || DEFAULT_TIMEZONE;
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
        return value;
    } catch {
        throw new HttpError(400, "Invalid schedule timezone");
    }
}

function normalizeTimeOfDay(value) {
    const text = String(value || "").trim();
    if (!TIME_OF_DAY_PATTERN.test(text)) {
        throw new HttpError(400, "schedule.timeOfDay must use 24-hour HH:mm format");
    }
    return text;
}

function normalizeWeekdays(values) {
    const weekdays = Array.from(
        new Set((Array.isArray(values) ? values : []).map(Number).filter((day) => Number.isInteger(day)))
    ).sort((a, b) => a - b);
    if (!weekdays.length) throw new HttpError(400, "Select at least one weekday");
    if (weekdays.some((day) => day < 1 || day > 7)) {
        throw new HttpError(400, "schedule.weekdays must contain values from 1 to 7");
    }
    return weekdays;
}

function getZonedParts(date, timezone) {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
    }).formatToParts(date);
    const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
    return {
        year: Number(values.year),
        month: Number(values.month),
        day: Number(values.day),
        hour: Number(values.hour),
        minute: Number(values.minute),
        second: Number(values.second),
    };
}

function zonedDateTimeToUtc({ year, month, day, hour, minute, timezone }) {
    const desiredLocalMs = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
    let candidateMs = desiredLocalMs;
    for (let attempt = 0; attempt < 4; attempt += 1) {
        const actual = getZonedParts(new Date(candidateMs), timezone);
        const actualLocalMs = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, 0, 0);
        const adjustment = desiredLocalMs - actualLocalMs;
        candidateMs += adjustment;
        if (adjustment === 0) break;
    }
    return new Date(candidateMs);
}

function addLocalDays(parts, days) {
    const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
    return {
        year: shifted.getUTCFullYear(),
        month: shifted.getUTCMonth() + 1,
        day: shifted.getUTCDate(),
    };
}

function weekdayFromLocalDate(parts) {
    const jsDay = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
    return jsDay === 0 ? 7 : jsDay;
}

function timeFromDateInTimezone(date, timezone) {
    const parts = getZonedParts(date, timezone);
    return `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
}

function computeNextRunAt({ type, timezone, runAt, timeOfDay, weekdays, now = new Date(), afterRun = false }) {
    const normalizedType = String(type || "").toLowerCase();
    const current = now instanceof Date ? now : new Date(now);
    if (Number.isNaN(current.getTime())) throw new HttpError(400, "Invalid current schedule time");

    if (normalizedType === CAMPAIGN_SCHEDULE_FREQUENCIES.ONCE) {
        if (afterRun) return null;
        const target = runAt instanceof Date ? runAt : new Date(runAt);
        if (Number.isNaN(target.getTime()) || target.getTime() <= current.getTime()) {
            throw new HttpError(400, "schedule.runAt must be in the future");
        }
        return target;
    }

    const zone = assertTimezone(timezone);
    const normalizedTime = normalizeTimeOfDay(timeOfDay);
    const [hour, minute] = normalizedTime.split(":").map(Number);
    const localToday = getZonedParts(current, zone);

    if (normalizedType === CAMPAIGN_SCHEDULE_FREQUENCIES.DAILY) {
        for (let offset = 0; offset <= 1; offset += 1) {
            const dateParts = addLocalDays(localToday, offset);
            const candidate = zonedDateTimeToUtc({ ...dateParts, hour, minute, timezone: zone });
            if (candidate.getTime() > current.getTime()) return candidate;
        }
    }

    if (normalizedType === CAMPAIGN_SCHEDULE_FREQUENCIES.WEEKLY) {
        const normalizedWeekdays = normalizeWeekdays(weekdays);
        for (let offset = 0; offset <= 7; offset += 1) {
            const dateParts = addLocalDays(localToday, offset);
            if (!normalizedWeekdays.includes(weekdayFromLocalDate(dateParts))) continue;
            const candidate = zonedDateTimeToUtc({ ...dateParts, hour, minute, timezone: zone });
            if (candidate.getTime() > current.getTime()) return candidate;
        }
    }

    throw new HttpError(400, "Unable to calculate next campaign run");
}

function normalizeScheduleInput({ scheduledAt, schedule, now = new Date() }) {
    const hasSchedulePayload = Boolean(schedule && typeof schedule === "object");
    const legacyType = schedule?.frequency;
    const rawType = schedule?.type || legacyType || (scheduledAt ? CAMPAIGN_SCHEDULE_FREQUENCIES.ONCE : "");
    if (!rawType) return { isScheduled: false, isRecurring: false };

    const type = String(rawType).toLowerCase();
    if (!VALID_TYPES.has(type)) throw new HttpError(400, "Invalid schedule type");
    const timezone = assertTimezone(schedule?.timezone);
    const isLegacy = !schedule?.type;

    if (!isLegacy) {
        if (type === CAMPAIGN_SCHEDULE_FREQUENCIES.ONCE && (schedule?.timeOfDay !== undefined || schedule?.weekdays !== undefined)) {
            throw new HttpError(400, "Once schedule only accepts runAt");
        }
        if (type === CAMPAIGN_SCHEDULE_FREQUENCIES.DAILY && (schedule?.runAt !== undefined || schedule?.weekdays !== undefined)) {
            throw new HttpError(400, "Daily schedule only accepts timeOfDay");
        }
        if (type === CAMPAIGN_SCHEDULE_FREQUENCIES.WEEKLY && schedule?.runAt !== undefined) {
            throw new HttpError(400, "Weekly schedule does not accept runAt");
        }
    }

    const legacyStart = schedule?.startAt || scheduledAt;
    let runAt;
    let timeOfDay;
    let weekdays;

    if (type === CAMPAIGN_SCHEDULE_FREQUENCIES.ONCE) {
        runAt = schedule?.runAt || legacyStart;
        if (!runAt) throw new HttpError(400, "schedule.runAt is required");
        runAt = new Date(runAt);
        if (Number.isNaN(runAt.getTime())) throw new HttpError(400, "Invalid schedule.runAt");
    } else {
        timeOfDay = schedule?.timeOfDay;
        if (!timeOfDay && legacyStart) {
            const legacyDate = new Date(legacyStart);
            if (!Number.isNaN(legacyDate.getTime())) timeOfDay = timeFromDateInTimezone(legacyDate, timezone);
        }
        timeOfDay = normalizeTimeOfDay(timeOfDay);
        if (type === CAMPAIGN_SCHEDULE_FREQUENCIES.WEEKLY) {
            weekdays = schedule?.weekdays;
            if ((!Array.isArray(weekdays) || !weekdays.length) && isLegacy && legacyStart) {
                weekdays = [weekdayFromLocalDate(getZonedParts(new Date(legacyStart), timezone))];
            }
            weekdays = normalizeWeekdays(weekdays);
        }
    }

    const nextRunAt = computeNextRunAt({ type, timezone, runAt, timeOfDay, weekdays, now });
    const endAt = schedule?.endAt ? new Date(schedule.endAt) : undefined;
    if (endAt && (Number.isNaN(endAt.getTime()) || endAt.getTime() < nextRunAt.getTime())) {
        throw new HttpError(400, "schedule.endAt must be after the next run");
    }
    return {
        isScheduled: hasSchedulePayload || Boolean(scheduledAt),
        isRecurring: type !== CAMPAIGN_SCHEDULE_FREQUENCIES.ONCE,
        type,
        frequency: type,
        status: "active",
        timezone,
        runAt: runAt || undefined,
        timeOfDay: timeOfDay || undefined,
        weekdays: weekdays || [],
        startAt: legacyStart ? new Date(legacyStart) : undefined,
        endAt,
        maxOccurrences: schedule?.maxOccurrences ? Number(schedule.maxOccurrences) : undefined,
        occurrencesRun: 0,
        nextRunAt,
        lastRunAt: null,
        lockUntil: null,
        lockedBy: null,
    };
}

function getNextRunAt({ schedule, now = new Date() }) {
    if (!schedule) return null;
    const maxOccurrences = Number(schedule.maxOccurrences || 0);
    const nextOccurrenceNumber = Number(schedule.occurrencesRun || 0) + 1;
    if (maxOccurrences > 0 && nextOccurrenceNumber >= maxOccurrences) return null;
    const type = schedule.type || schedule.frequency;
    const timezone = schedule.timezone || DEFAULT_TIMEZONE;
    const legacyStart = schedule.startAt ? new Date(schedule.startAt) : null;
    const timeOfDay = schedule.timeOfDay || (
        legacyStart && !Number.isNaN(legacyStart.getTime())
            ? timeFromDateInTimezone(legacyStart, timezone)
            : undefined
    );
    const weekdays = Array.isArray(schedule.weekdays) && schedule.weekdays.length
        ? schedule.weekdays
        : type === CAMPAIGN_SCHEDULE_FREQUENCIES.WEEKLY && legacyStart && !Number.isNaN(legacyStart.getTime())
            ? [weekdayFromLocalDate(getZonedParts(legacyStart, timezone))]
            : schedule.weekdays;
    const nextRunAt = computeNextRunAt({
        type,
        timezone,
        runAt: schedule.runAt || schedule.startAt,
        timeOfDay,
        weekdays,
        now,
        afterRun: String(type) === CAMPAIGN_SCHEDULE_FREQUENCIES.ONCE,
    });
    const endAt = schedule.endAt ? new Date(schedule.endAt) : null;
    return endAt && nextRunAt && nextRunAt.getTime() > endAt.getTime() ? null : nextRunAt;
}

function buildRecurringSchedule({ scheduledAt, schedule, now = new Date() }) {
    const normalized = normalizeScheduleInput({ scheduledAt, schedule, now });
    return normalized.isScheduled ? normalized : null;
}

module.exports = {
    DEFAULT_TIMEZONE,
    normalizeScheduleInput,
    computeNextRunAt,
    getNextRunAt,
    buildRecurringSchedule,
};
