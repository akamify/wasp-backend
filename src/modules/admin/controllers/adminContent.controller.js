const Joi = require("joi");
const axios = require("axios");
const { PublicPage } = require("@infra/database/PublicPage");
const { SupportTicket } = require("@infra/database/SupportTicket");
const { CareerApplication } = require("@infra/database/CareerApplication");
const { HttpError } = require("@shared/utils/httpError");
const { resolveUploadsPath } = require("@shared/utils/fileStorage");
const { sendEmail } = require("@shared/services/emailService");
const { buildTicketResolvedEmailHtml } = require("@shared/utils/emailTemplates");
const { normalizeSlug } = require("@modules/public/controllers/publicContent.controller");
const { uploadBufferToCloudinary } = require("@shared/services/cloudinaryService");
const { appBrandName, appBrandLogoUrl } = require("@core/config/env");
const DOC_PREFIX = "docs-";
const LEGACY_DOC_PATH_PREFIX = "docs/";
const DOC_BRAND_SLUG = "__docs_brand__";
const PLATFORM_BRAND_SLUG = "__platform_brand__";

function parsePaging(req) {
  const page = Math.max(1, Number(req.query.page || 1) || 1);
  const limitRaw = Number(req.query.limit || 25) || 25;
  const limit = Math.min(Math.max(limitRaw, 5), 200);
  const skip = (page - 1) * limit;
  return { page, limit, skip };
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildSearchRegex(req) {
  const q = String(req.query.q || "").trim();
  if (!q) return null;
  return new RegExp(escapeRegExp(q), "i");
}

function normalizeListOption(value) {
  return String(value || "").trim().toLowerCase();
}

function listResponse({ items, total, page, limit }) {
  return { success: true, items, page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) };
}

function isDocsManagedSlug(slugValue) {
  const slug = String(slugValue || "").trim().toLowerCase();
  return slug === DOC_BRAND_SLUG || slug.startsWith(DOC_PREFIX) || slug.startsWith(LEGACY_DOC_PATH_PREFIX);
}

function isDocLikePayload(data) {
  if (!data || typeof data !== "object") return false;
  const hasDocSlug = Boolean(String(data.slug || "").trim());
  const hasDocStatus = ["draft", "published"].includes(String(data.status || "").trim().toLowerCase());
  const content = String(data.content || "").trim();
  const title = String(data.title || "").trim();
  const description = String(data.description || "").trim();
  const hasContent = Object.prototype.hasOwnProperty.call(data, "content");
  const hasKeywords = Array.isArray(data.keywords);
  const hasSidebar = !!(data.sidebar && typeof data.sidebar === "object");
  const hasSeo = !!(data.seo && typeof data.seo === "object");
  const hasMeaningfulDocFields =
    Boolean(title) ||
    Boolean(description) ||
    Boolean(content) ||
    (Array.isArray(data.keywords) && data.keywords.length > 0);
  return hasDocSlug && hasDocStatus && (hasContent || hasKeywords || hasSidebar || hasSeo) && hasMeaningfulDocFields;
}

async function adminListPages(req, res) {
  const pages = await PublicPage.find({ slug: { $nin: [DOC_BRAND_SLUG] } })
    .sort({ slug: 1 })
    .select("slug title updatedAt");
  const filtered = pages.filter((p) => !isDocsManagedSlug(p.slug) && String(p?.data?.__type || "") !== "doc" && !isDocLikePayload(p?.data || {}));
  res.json({
    success: true,
    items: filtered.map((p) => ({ slug: p.slug, title: p.title || "", updatedAt: p.updatedAt })),
  });
}

async function adminGetPage(req, res) {
  const slug = normalizeSlug(req.params.slug);
  if (isDocsManagedSlug(slug)) throw new HttpError(403, "This slug is managed from Docs module");
  let page = await PublicPage.findOne({ slug }).select("slug title data updatedAt");
  if (page && (String(page?.data?.__type || "") === "doc" || isDocLikePayload(page?.data || {}))) {
    throw new HttpError(403, "This slug is managed from Docs module");
  }
  if (!page) {
    page = await PublicPage.create({ slug, title: "", data: {}, updatedByAdminId: String(req.user?.id || "admin") });
  }
  res.json({ success: true, page: { slug: page.slug, title: page.title || "", data: page.data || {}, updatedAt: page.updatedAt } });
}

const upsertSchema = Joi.object({
  title: Joi.string().allow("").max(120).default(""),
  data: Joi.object().required(),
});

async function adminUpsertPage(req, res) {
  const slug = normalizeSlug(req.params.slug);
  if (isDocsManagedSlug(slug)) throw new HttpError(403, "This slug is managed from Docs module");
  const payload = await upsertSchema.validateAsync(req.body, { abortEarly: false, stripUnknown: true });
  const adminId = String(req.user?.id || "admin");

  const existing = await PublicPage.findOne({ slug }).select("data");
  if (String(existing?.data?.__type || "") === "doc" || isDocLikePayload(existing?.data || {})) {
    throw new HttpError(403, "This slug is managed from Docs module");
  }

  const page = await PublicPage.findOneAndUpdate(
    { slug },
    { $set: { title: payload.title, data: payload.data, updatedByAdminId: adminId } },
    { new: true, upsert: true }
  ).select("slug title data updatedAt");

  res.json({ success: true, page: { slug: page.slug, title: page.title || "", data: page.data || {}, updatedAt: page.updatedAt } });
}

async function adminSupportTickets(req, res) {
  const { page, limit, skip } = parsePaging(req);
  const rx = buildSearchRegex(req);
  const filterKey = normalizeListOption(req.query.filter || "all");
  const sortKey = normalizeListOption(req.query.sort || "recent");

  const searchFilter = rx
    ? {
        $or: [{ name: rx }, { email: rx }, { phone: rx }, { subject: rx }, { status: rx }],
      }
    : {};

  const statusFilter =
    filterKey === "resolved"
      ? { status: "resolved" }
      : filterKey === "open"
        ? { status: { $ne: "resolved" } }
        : {};

  const filter = { $and: [searchFilter, statusFilter] };
  const sort =
    sortKey === "old"
      ? { createdAt: 1 }
      : sortKey === "subject"
        ? { subject: 1, createdAt: -1 }
        : { createdAt: -1 };

  const [total, tickets] = await Promise.all([
    SupportTicket.countDocuments(filter),
    SupportTicket.find(filter).sort(sort).skip(skip).limit(limit).select("name email phone subject message status resolvedAt resolutionNote createdAt"),
  ]);

  res.json(
    listResponse({
      items: tickets.map((t) => ({
        id: String(t._id),
        name: t.name,
        email: t.email,
        phone: t.phone || "",
        subject: t.subject,
        message: t.message,
        status: t.status,
        resolvedAt: t.resolvedAt,
        resolutionNote: t.resolutionNote || "",
        createdAt: t.createdAt,
      })),
      total,
      page,
      limit,
    })
  );
}

const resolveSchema = Joi.object({
  resolutionNote: Joi.string().trim().allow("").max(2000).default(""),
});

async function adminResolveSupportTicket(req, res) {
  const id = String(req.params.id || "").trim();
  const payload = await resolveSchema.validateAsync(req.body, { abortEarly: false, stripUnknown: true });
  const adminId = String(req.user?.id || "admin");

  const ticket = await SupportTicket.findById(id).select("name email phone subject message status");
  if (!ticket) throw new HttpError(404, "Ticket not found");
  if (ticket.status !== "resolved") {
    ticket.status = "resolved";
    ticket.resolvedAt = new Date();
    ticket.resolvedByAdminId = adminId;
    ticket.resolutionNote = payload.resolutionNote || "";
    await ticket.save();
  }

  sendEmail({
    toEmail: ticket.email,
    toName: ticket.name,
    subject: `Ticket resolved: ${ticket.subject}`,
    htmlContent: buildTicketResolvedEmailHtml({
      ticketId: String(ticket._id),
      name: ticket.name,
      subject: ticket.subject,
      resolutionNote: ticket.resolutionNote || "",
    }),
    textContent: `Your ticket has been marked resolved.\nTicket: ${ticket._id}\nSubject: ${ticket.subject}`,
  }).catch(() => {});

  res.json({ success: true, ticket: { id: String(ticket._id), status: ticket.status, resolvedAt: ticket.resolvedAt } });
}

async function adminCareerApplications(req, res) {
  const { page, limit, skip } = parsePaging(req);
  const rx = buildSearchRegex(req);
  const filter = rx
    ? { $or: [{ name: rx }, { email: rx }, { whatsappPhone: rx }, { applyingRole: rx }, { department: rx }, { status: rx }] }
    : {};

  const [total, apps] = await Promise.all([
    CareerApplication.countDocuments(filter),
    CareerApplication.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .select("name email whatsappPhone organisationName currentRole applyingRole department yearsExpIndustry yearsCurrentJob currentSalary expectedSalary noticePeriod modeOfWork status adminNote resume createdAt updatedAt"),
  ]);

  res.json(
    listResponse({
      items: apps.map((a) => ({
        id: String(a._id),
        name: a.name,
        email: a.email,
        whatsappPhone: a.whatsappPhone,
        organisationName: a.organisationName,
        currentRole: a.currentRole,
        applyingRole: a.applyingRole,
        department: a.department,
        yearsExpIndustry: a.yearsExpIndustry,
        yearsCurrentJob: a.yearsCurrentJob,
        currentSalary: a.currentSalary,
        expectedSalary: a.expectedSalary,
        noticePeriod: a.noticePeriod,
        modeOfWork: a.modeOfWork,
        status: a.status,
        adminNote: a.adminNote || "",
        resume: a.resume ? { originalName: a.resume.originalName, mimeType: a.resume.mimeType, sizeBytes: a.resume.sizeBytes } : null,
        createdAt: a.createdAt,
        updatedAt: a.updatedAt,
      })),
      total,
      page,
      limit,
    })
  );
}

const careerUpdateSchema = Joi.object({
  status: Joi.string().valid("new", "reviewing", "shortlisted", "rejected").required(),
  adminNote: Joi.string().trim().allow("").max(2000).default(""),
});

async function adminUpdateCareerApplication(req, res) {
  const id = String(req.params.id || "").trim();
  const payload = await careerUpdateSchema.validateAsync(req.body, { abortEarly: false, stripUnknown: true });
  const adminId = String(req.user?.id || "admin");
  const app = await CareerApplication.findById(id).select("status adminNote updatedByAdminId updatedAt");
  if (!app) throw new HttpError(404, "Application not found");
  app.status = payload.status;
  app.adminNote = payload.adminNote || "";
  app.updatedByAdminId = adminId;
  await app.save();
  res.json({ success: true, application: { id: String(app._id), status: app.status, updatedAt: app.updatedAt } });
}

async function adminDownloadResume(req, res) {
  const id = String(req.params.id || "").trim();
  const app = await CareerApplication.findById(id).select("resume name");
  if (!app?.resume) throw new HttpError(404, "Resume not found");

  // Prefer Cloudinary URL if present.
  if (app.resume.url) {
    res.setHeader("Content-Type", app.resume.mimeType || "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(app.resume.originalName || "resume")}"`);
    try {
      const upstream = await axios.get(app.resume.url, { responseType: "stream", timeout: 20000 });
      upstream.data.pipe(res);
      return;
    } catch {
      // Fallback to redirect if streaming fails (CORS doesn't apply on redirects from browser download).
      return res.redirect(app.resume.url);
    }
  }

  if (!app.resume.storedName) throw new HttpError(404, "Resume not found");
  const abs = resolveUploadsPath({ folder: "resumes", storedName: app.resume.storedName });
  res.setHeader("Content-Type", app.resume.mimeType);
  res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(app.resume.originalName)}"`);
  return res.sendFile(abs);
}

async function adminGetPlatformBrand(req, res) {
  const page = await PublicPage.findOne({ slug: PLATFORM_BRAND_SLUG }).select("data updatedAt");
  return res.json({
    success: true,
    settings: {
      brandName: String(page?.data?.brandName || appBrandName || "DigitalWhasp"),
      brandLogoUrl: String(page?.data?.brandLogoUrl || appBrandLogoUrl || ""),
    },
    meta: { source: page ? "db" : "env", updatedAt: page?.updatedAt || null },
  });
}

async function adminUpdatePlatformBrand(req, res) {
  const schema = Joi.object({
    brandName: Joi.string().trim().allow("").max(120).default(""),
    brandLogoUrl: Joi.string().allow("").max(5000).default(""),
  });
  const payload = await schema.validateAsync(req.body, { abortEarly: false, stripUnknown: true });
  const nextName = String(payload.brandName || "").trim();
  const nextLogo = String(payload.brandLogoUrl || "").trim();

  const page = await PublicPage.findOneAndUpdate(
    { slug: PLATFORM_BRAND_SLUG },
    {
      $set: {
        title: "Platform Brand",
        data: {
          brandName: nextName || String(appBrandName || "DigitalWhasp"),
          brandLogoUrl: nextLogo || String(appBrandLogoUrl || ""),
        },
        updatedByAdminId: String(req.user?.id || "admin"),
      },
    },
    { new: true, upsert: true }
  ).select("data updatedAt");

  return res.json({
    success: true,
    settings: {
      brandName: String(page?.data?.brandName || appBrandName || "DigitalWhasp"),
      brandLogoUrl: String(page?.data?.brandLogoUrl || appBrandLogoUrl || ""),
    },
    meta: { source: "db", updatedAt: page?.updatedAt || null },
  });
}

async function adminUploadPlatformBrandLogo(req, res) {
  const file = req.file;
  if (!file?.buffer) throw new HttpError(400, "Logo file is required");

  const uploaded = await uploadBufferToCloudinary({
    buffer: file.buffer,
    mimeType: file.mimetype,
    originalName: file.originalname,
    folder: "waspakamify/platform-brand",
  });
  const logoUrl = String(uploaded?.secure_url || uploaded?.url || "").trim();
  if (!logoUrl) throw new HttpError(500, "Failed to upload logo");

  return res.json({ success: true, logoUrl });
}

module.exports = {
  adminListPages,
  adminGetPage,
  adminUpsertPage,
  adminSupportTickets,
  adminResolveSupportTicket,
  adminCareerApplications,
  adminUpdateCareerApplication,
  adminDownloadResume,
  adminGetPlatformBrand,
  adminUpdatePlatformBrand,
  adminUploadPlatformBrandLogo,
};


