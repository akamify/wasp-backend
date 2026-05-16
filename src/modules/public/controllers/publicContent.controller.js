const Joi = require("joi");
const { PublicPage } = require("@infra/database/PublicPage");
const { SupportTicket } = require("@infra/database/SupportTicket");
const { CareerApplication } = require("@infra/database/CareerApplication");
const { HttpError } = require("@shared/utils/httpError");
const { sendEmail } = require("@shared/services/emailService");
const {
  buildTicketCreatedEmailHtml,
  buildCareerApplicationEmailHtml,
} = require("@shared/utils/emailTemplates");
const { storeBufferToUploads } = require("@shared/utils/fileStorage");
const { isCloudinaryConfigured, uploadBufferToCloudinary } = require("@shared/services/cloudinaryService");

function normalizeSlug(slug) {
  return String(slug || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function defaultPageData(slug) {
  const nowIso = new Date().toISOString();
  if (slug === "help-center") {
    return {
      hero: {
        title: "Help Center",
        subtitle: "Find answers or raise a support ticket.",
        icon: "HelpCircle",
        imageUrl: "",
      },
      contacts: [
        { label: "Email", value: "support@example.com" },
        { label: "Phone", value: "+91 90000 00000" },
        { label: "WhatsApp", value: "+91 90000 00000" },
      ],
      faqs: [
        { q: "How do I get started?", a: "Create an account, connect WhatsApp, and start sending campaigns." },
        { q: "How do I raise a ticket?", a: "Click the Raise Ticket button and fill your details." },
      ],
      updatedAt: nowIso,
    };
  }
  if (slug === "careers") {
    return {
      hero: { title: "Careers", subtitle: "Join our team.", icon: "Briefcase", imageUrl: "" },
      introMarkdown:
        "We are always looking for talented people. Submit your application and we will get back to you if shortlisted.",
      departments: ["Engineering", "Sales", "Marketing", "Support", "Operations"],
      noticePeriods: ["Immediate", "15 days", "30 days", "45 days", "60 days", "90 days"],
      modesOfWork: ["On-site", "Remote", "Hybrid"],
      updatedAt: nowIso,
    };
  }
  if (slug === "about") {
    return {
      hero: { title: "About", subtitle: "Who we are.", icon: "Info", imageUrl: "" },
      bodyMarkdown:
        "Write your About page content here. This content is managed from the Admin panel.",
      updatedAt: nowIso,
    };
  }
  if (slug === "privacy-policy") {
    return {
      hero: { title: "Privacy Policy", subtitle: "", icon: "Shield", imageUrl: "" },
      bodyMarkdown: "Add your privacy policy content here (admin-managed).",
      updatedAt: nowIso,
    };
  }
  if (slug === "terms-of-service") {
    return {
      hero: { title: "Terms of Service", subtitle: "", icon: "FileText", imageUrl: "" },
      bodyMarkdown: "Add your terms of service content here (admin-managed).",
      updatedAt: nowIso,
    };
  }
  if (slug === "cookie-policy") {
    return {
      hero: { title: "Cookie Policy", subtitle: "", icon: "Cookie", imageUrl: "" },
      bodyMarkdown: "Add your cookie policy content here (admin-managed).",
      updatedAt: nowIso,
    };
  }
  return { updatedAt: nowIso };
}

async function ensurePage(slug) {
  const normalized = normalizeSlug(slug);
  if (!normalized) throw new HttpError(400, "Invalid page");
  let page = await PublicPage.findOne({ slug: normalized }).select("slug title data updatedAt createdAt");
  if (!page) {
    page = await PublicPage.create({
      slug: normalized,
      title: "",
      data: defaultPageData(normalized),
      updatedByAdminId: "seed",
    });
  }
  return page;
}

async function getPublicPage(req, res) {
  const slug = normalizeSlug(req.params.slug);
  const page = await ensurePage(slug);
  res.json({
    success: true,
    page: {
      slug: page.slug,
      title: page.title || page.data?.hero?.title || "",
      data: page.data || {},
      updatedAt: page.updatedAt,
    },
  });
}

const ticketSchema = Joi.object({
  name: Joi.string().trim().min(2).max(80).required(),
  email: Joi.string().trim().email().required(),
  phone: Joi.string().trim().allow("").max(30).default(""),
  subject: Joi.string().trim().min(3).max(120).required(),
  message: Joi.string().trim().min(5).max(2000).required(),
});

async function createSupportTicket(req, res) {
  const payload = await ticketSchema.validateAsync(req.body, { abortEarly: false, stripUnknown: true });
  const ticket = await SupportTicket.create({
    name: payload.name,
    email: payload.email.toLowerCase(),
    phone: payload.phone,
    subject: payload.subject,
    message: payload.message,
  });

  // Fire-and-forget email; do not block ticket creation.
  sendEmail({
    toEmail: ticket.email,
    toName: ticket.name,
    subject: `Ticket received: ${ticket.subject}`,
    htmlContent: buildTicketCreatedEmailHtml({
      ticketId: String(ticket._id),
      name: ticket.name,
      email: ticket.email,
      phone: ticket.phone,
      subject: ticket.subject,
      message: ticket.message,
    }),
    textContent: `Your support ticket was created.\nTicket: ${ticket._id}\nSubject: ${ticket.subject}`,
  }).catch(() => {});

  res.status(201).json({
    success: true,
    ticket: { id: String(ticket._id), status: ticket.status, createdAt: ticket.createdAt },
    message: "Ticket submitted successfully.",
  });
}

const careerBodySchema = Joi.object({
  name: Joi.string().trim().min(2).max(80).required(),
  whatsappPhone: Joi.string().trim().min(6).max(30).required(),
  email: Joi.string().trim().email().required(),
  organisationName: Joi.string().trim().min(2).max(120).required(),
  currentRole: Joi.string().trim().min(2).max(120).required(),
  applyingRole: Joi.string().trim().min(2).max(120).required(),
  department: Joi.string().trim().min(2).max(80).required(),
  yearsExpIndustry: Joi.number().min(0).max(60).required(),
  yearsCurrentJob: Joi.number().min(0).max(60).required(),
  currentSalary: Joi.string().trim().min(1).max(60).required(),
  expectedSalary: Joi.string().trim().min(1).max(60).required(),
  noticePeriod: Joi.string().trim().min(1).max(60).required(),
  modeOfWork: Joi.string().trim().min(1).max(60).required(),
});

async function applyCareer(req, res) {
  if (!req.file) throw new HttpError(400, "Resume is required");
  const body = await careerBodySchema.validateAsync(req.body, { abortEarly: false, stripUnknown: true });

  let resumeStoredName = "";
  let resumeUrl = "";
  let resumePublicId = "";

  if (isCloudinaryConfigured()) {
    const uploaded = await uploadBufferToCloudinary({
      buffer: req.file.buffer,
      mimeType: req.file.mimetype,
      originalName: req.file.originalname,
      folder: "resumes",
    });
    resumeUrl = String(uploaded?.secure_url || uploaded?.url || "");
    resumePublicId = String(uploaded?.public_id || "");
  } else {
    const stored = storeBufferToUploads({
      folder: "resumes",
      buffer: req.file.buffer,
      mimeType: req.file.mimetype,
    });
    resumeStoredName = stored.storedName;
  }

  const app = await CareerApplication.create({
    ...body,
    email: body.email.toLowerCase(),
    resume: {
      originalName: req.file.originalname,
      storedName: resumeStoredName,
      url: resumeUrl,
      publicId: resumePublicId,
      mimeType: req.file.mimetype,
      sizeBytes: Number(req.file.size || req.file.buffer?.length || 0),
    },
  });

  sendEmail({
    toEmail: app.email,
    toName: app.name,
    subject: "Application received",
    htmlContent: buildCareerApplicationEmailHtml({ applicantName: app.name, applyingRole: app.applyingRole }),
    textContent: `Hi ${app.name}, we received your application for ${app.applyingRole}.`,
  }).catch(() => {});

  res.status(201).json({
    success: true,
    application: { id: String(app._id), status: app.status, createdAt: app.createdAt },
    message: "Application submitted successfully.",
  });
}

module.exports = { getPublicPage, createSupportTicket, applyCareer, normalizeSlug };

