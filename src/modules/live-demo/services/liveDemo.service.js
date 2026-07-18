const { LiveDemoEnquiry } = require("@infra/database/LiveDemoEnquiry");
const { HttpError } = require("@shared/utils/httpError");
const { sendEmail } = require("@shared/services/emailService");
const {
  buildLiveDemoCreatedEmailHtml,
  buildLiveDemoCompletedEmailHtml,
} = require("@shared/utils/emailTemplates");

const TIME_ZONE = "Asia/Kolkata";
const SLOT_START_MINUTES = 9 * 60;
const SLOT_END_MINUTES = 23 * 60;
const SLOT_INTERVAL_MINUTES = 30;
const STATUSES = ["Pending", "Confirmed", "Completed", "Cancelled"];

function pad(value) {
  return String(value).padStart(2, "0");
}

function toDisplaySlot(totalMinutes) {
  const hour24 = Math.floor(totalMinutes / 60);
  const minute = totalMinutes % 60;
  const suffix = hour24 >= 12 ? "PM" : "AM";
  const hour12 = hour24 % 12 || 12;
  return `${pad(hour12)}:${pad(minute)} ${suffix}`;
}

function parseSlotMinutes(slot) {
  const match = String(slot || "").trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const suffix = match[3].toUpperCase();
  if (hour < 1 || hour > 12 || minute < 0 || minute > 59) return null;
  if (suffix === "PM" && hour !== 12) hour += 12;
  if (suffix === "AM" && hour === 12) hour = 0;
  return hour * 60 + minute;
}

function generateTimeSlots() {
  const slots = [];
  for (let minutes = SLOT_START_MINUTES; minutes <= SLOT_END_MINUTES; minutes += SLOT_INTERVAL_MINUTES) {
    slots.push(toDisplaySlot(minutes));
  }
  return slots;
}

function getTodayParts() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    date: `${byType.year}-${byType.month}-${byType.day}`,
    minutes: Number(byType.hour) * 60 + Number(byType.minute),
  };
}

function assertValidDate(date) {
  const text = String(date || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new HttpError(400, "Valid demo date is required", { code: "LIVE_DEMO_DATE_INVALID" });
  }
  const parsed = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
    throw new HttpError(400, "Valid demo date is required", { code: "LIVE_DEMO_DATE_INVALID" });
  }
  const today = getTodayParts().date;
  if (text < today) {
    throw new HttpError(400, "Past dates cannot be selected", { code: "LIVE_DEMO_DATE_PAST" });
  }
  return text;
}

function assertValidSlot(date, slot) {
  const slotText = String(slot || "").trim().toUpperCase();
  const slotMinutes = parseSlotMinutes(slotText);
  if (slotMinutes == null || slotMinutes < SLOT_START_MINUTES || slotMinutes > SLOT_END_MINUTES || slotMinutes % SLOT_INTERVAL_MINUTES !== 0) {
    throw new HttpError(400, "Valid time slot is required", { code: "LIVE_DEMO_SLOT_INVALID" });
  }
  const today = getTodayParts();
  if (date === today.date && slotMinutes <= today.minutes) {
    throw new HttpError(400, "Past time slots cannot be selected", { code: "LIVE_DEMO_SLOT_PAST" });
  }
  return toDisplaySlot(slotMinutes);
}

async function listSlots({ date }) {
  const safeDate = assertValidDate(date);
  const bookedRows = await LiveDemoEnquiry.find({ date: safeDate })
    .select("slot")
    .lean();
  const booked = new Set(bookedRows.map((row) => String(row.slot)));
  const today = getTodayParts();
  return generateTimeSlots().map((slot) => {
    const past = safeDate === today.date && Number(parseSlotMinutes(slot)) <= today.minutes;
    const isBooked = booked.has(slot);
    return {
      slot,
      available: !past && !isBooked,
      booked: isBooked,
    };
  });
}

async function createEnquiry(payload) {
  const date = assertValidDate(payload.date);
  const slot = assertValidSlot(date, payload.slot);
  const doc = {
    name: String(payload.name || "").trim(),
    email: String(payload.email || "").trim().toLowerCase(),
    phone: String(payload.phone || "").trim(),
    platform: payload.platform,
    date,
    slot,
    notes: String(payload.notes || "").trim(),
  };
  try {
    const created = await LiveDemoEnquiry.create(doc);
    const dto = toAdminDto(created);
    void sendLiveDemoEmail({
      enquiry: dto,
      subject: "Your live demo request has been received",
      htmlContent: buildLiveDemoCreatedEmailHtml(dto),
      textContent: `Hi ${dto.name}, your live demo request was received. Platform: ${dto.platform}. Date: ${dto.date}. Time: ${dto.slot}. Status: Pending.`,
      event: "created",
    });
    return dto;
  } catch (err) {
    if (Number(err?.code) === 11000) {
      throw new HttpError(409, "This demo slot is already booked", { code: "LIVE_DEMO_SLOT_BOOKED" });
    }
    throw err;
  }
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toAdminDto(doc) {
  const item = doc?.toObject ? doc.toObject() : doc;
  if (!item) return null;
  return {
    id: String(item._id || ""),
    name: item.name || "",
    email: item.email || "",
    phone: item.phone || "",
    platform: item.platform || "",
    date: item.date || "",
    slot: item.slot || "",
    notes: item.notes || "",
    status: item.status || "Pending",
    createdAt: item.createdAt || null,
    updatedAt: item.updatedAt || null,
  };
}

async function listAdminEnquiries({ page = 1, limit = 25, q = "", status = "all", date = "" }) {
  const safePage = Math.max(1, Number(page || 1) || 1);
  const safeLimit = Math.min(Math.max(Number(limit || 25) || 25, 5), 100);
  const filter = {};
  const search = String(q || "").trim();
  if (search) {
    const rx = new RegExp(escapeRegex(search), "i");
    filter.$or = [{ name: rx }, { email: rx }, { phone: rx }, { platform: rx }];
  }
  if (STATUSES.includes(status)) filter.status = status;
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))) filter.date = String(date);

  const [total, items] = await Promise.all([
    LiveDemoEnquiry.countDocuments(filter),
    LiveDemoEnquiry.find(filter)
      .sort({ createdAt: -1 })
      .skip((safePage - 1) * safeLimit)
      .limit(safeLimit),
  ]);

  return {
    items: items.map(toAdminDto),
    total,
    page: safePage,
    limit: safeLimit,
    totalPages: Math.max(1, Math.ceil(total / safeLimit)),
  };
}

async function updateStatus({ id, status }) {
  if (status !== "Completed") {
    throw new HttpError(400, "Valid status is required", { code: "LIVE_DEMO_STATUS_INVALID" });
  }
  const updated = await LiveDemoEnquiry.findOneAndUpdate(
    { _id: id },
    { $set: { status } },
    { returnDocument: "after" }
  );
  if (!updated) throw new HttpError(404, "Live demo enquiry not found", { code: "LIVE_DEMO_NOT_FOUND" });
  const dto = toAdminDto(updated);
  void sendLiveDemoEmail({
    enquiry: dto,
    subject: "Your live demo has been completed",
    htmlContent: buildLiveDemoCompletedEmailHtml(dto),
    textContent: `Hi ${dto.name}, your live demo has been marked as completed. Platform: ${dto.platform}. Date: ${dto.date}. Time: ${dto.slot}.`,
    event: "completed",
  });
  return dto;
}

async function sendLiveDemoEmail({ enquiry, subject, htmlContent, textContent, event }) {
  if (!enquiry?.email) return;
  try {
    const result = await sendEmail({
      toEmail: enquiry.email,
      toName: enquiry.name || "",
      subject,
      htmlContent,
      textContent,
    });
    if (result?.skipped || result?.failed) {
      console.warn("[live-demo] email not sent", {
        event,
        enquiryId: enquiry.id,
        skipped: !!result.skipped,
        failed: !!result.failed,
        reason: result.reason || result.providerMessage || "unknown",
      });
    }
  } catch (err) {
    console.warn("[live-demo] email send failed", {
      event,
      enquiryId: enquiry.id,
      message: err?.message || "unknown",
    });
  }
}

module.exports = {
  STATUSES,
  generateTimeSlots,
  listSlots,
  createEnquiry,
  listAdminEnquiries,
  updateStatus,
};
