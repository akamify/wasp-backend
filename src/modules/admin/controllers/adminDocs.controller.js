const Joi = require("joi");
const mongoose = require("mongoose");
const { DocPage } = require("@infra/database/DocPage");
const { DocSetting } = require("@infra/database/DocSetting");
const { HttpError } = require("@shared/utils/httpError");
const { uploadBufferToCloudinary } = require("@shared/services/cloudinaryService");

const DOC_PREFIX = "docs-";
const DOC_BRAND_KEY = "brand";
const LEGACY_DOC_PATH_PREFIX = "docs/";
const RESERVED_DOC_SLUGS = new Set(["brand", "__docs_brand__"]);
const CMS_PAGE_SLUGS = new Set(["about", "privacy-policy", "terms-of-service", "cookie-policy", "help-center", "careers"]);
const KNOWN_DOC_SLUGS = new Set(["introduction", "quick-start", "authentication", "meta-setup", "webhooks"]);

const docSchema = Joi.object({
  title: Joi.string().trim().min(1).max(200).required(),
  slug: Joi.string().trim().lowercase().pattern(/^[a-z0-9-]+$/).required(),
  description: Joi.string().allow("").max(500).default(""),
  content: Joi.string().allow("").default(""),
  keywords: Joi.alternatives().try(Joi.array().items(Joi.string().trim().max(80)), Joi.string().allow("")),
  category: Joi.string().trim().allow("").default("general"),
  order: Joi.number().min(0).default(0),
  status: Joi.string().valid("draft", "published").default("draft"),
  sidebar: Joi.object({
    section: Joi.string().allow("").default(""),
    sectionOrder: Joi.number().default(0),
    itemOrder: Joi.number().default(0),
  }).default(),
  seo: Joi.object({
    metaTitle: Joi.string().allow("").default(""),
    metaDescription: Joi.string().allow("").default(""),
    ogImage: Joi.string().allow("").default(""),
    noIndex: Joi.boolean().default(false),
  }).default(),
});

function normalizeDocSlugCandidate(rawSlug, data) {
  const raw = String(rawSlug || "").trim().toLowerCase();
  const mappedRaw = raw.startsWith(DOC_PREFIX)
    ? raw.slice(DOC_PREFIX.length)
    : raw.startsWith(LEGACY_DOC_PATH_PREFIX)
    ? raw.slice(LEGACY_DOC_PATH_PREFIX.length)
    : raw;
  const dataSlug = String(data?.slug || "").trim().toLowerCase();
  return dataSlug || mappedRaw;
}

function getDocPayloadFromPage(page) {
  const root = page?.data && typeof page.data === "object" ? page.data : {};
  const candidates = [root, root?.data, root?.doc, root?.page, root?.payload].filter((x) => x && typeof x === "object");
  const looksLikeDoc = (obj) =>
    Boolean(
      String(obj?.title || "").trim() ||
        String(obj?.description || "").trim() ||
        String(obj?.content || "").trim() ||
        String(obj?.bodyMarkdown || "").trim() ||
        String(obj?.introMarkdown || "").trim() ||
        String(obj?.markdown || "").trim() ||
        String(obj?.status || "").trim() ||
        String(obj?.category || "").trim() ||
        String(obj?.slug || "").trim() ||
        Array.isArray(obj?.keywords) ||
        obj?.sidebar ||
        obj?.seo ||
        Array.isArray(obj?.blocks)
    );
  for (const c of candidates) {
    if (looksLikeDoc(c)) return c;
  }
  return root;
}

function collectDeepObjects(root, maxDepth = 3) {
  const out = [];
  const queue = [{ node: root, depth: 0 }];
  const seen = new Set();
  while (queue.length) {
    const current = queue.shift();
    if (!current || !current.node || typeof current.node !== "object") continue;
    if (seen.has(current.node)) continue;
    seen.add(current.node);
    out.push(current.node);
    if (current.depth >= maxDepth) continue;
    for (const value of Object.values(current.node)) {
      if (value && typeof value === "object") queue.push({ node: value, depth: current.depth + 1 });
    }
  }
  return out;
}

function pickFirstNonEmptyString(objects, keys) {
  for (const key of keys) {
    for (const obj of objects) {
      const value = obj?.[key];
      if (typeof value === "string" && value.trim()) return value;
    }
  }
  return "";
}

function extractBlockContent(objects) {
  for (const obj of objects) {
    if (!Array.isArray(obj?.blocks)) continue;
    const text = obj.blocks
      .map((b) => String(b?.snippet || b?.content || b?.text || b?.body || "").trim())
      .filter(Boolean)
      .join("\n\n");
    if (text) return text;
  }
  return "";
}

async function resolveDocPageByIdentifier(identifier) {
  const raw = String(identifier || "").trim();
  if (!raw) return null;

  let page = null;
  if (mongoose.Types.ObjectId.isValid(raw)) {
    page = await DocPage.findById(raw);
    if (page && isDocPage(page)) return page;
  }

  const normalized = raw.toLowerCase();
  const slugCandidates = [
    normalized,
    normalized.startsWith(DOC_PREFIX) ? normalized : `${DOC_PREFIX}${normalized}`,
    normalized.startsWith(LEGACY_DOC_PATH_PREFIX) ? normalized : `${LEGACY_DOC_PATH_PREFIX}${normalized}`,
  ];

  page = await DocPage.findOne({ slug: { $in: Array.from(new Set(slugCandidates)) } });
  if (!page || !isDocPage(page)) return null;
  return page;
}

function normalizeDocFromPage(page) {
  const d = getDocPayloadFromPage(page);
  const objects = collectDeepObjects(d, 4);
  const rawSlug = String(page?.slug || "");
  const normalizedSlug = rawSlug.startsWith(DOC_PREFIX)
    ? rawSlug.slice(DOC_PREFIX.length)
    : rawSlug.startsWith(LEGACY_DOC_PATH_PREFIX)
    ? rawSlug.slice(LEGACY_DOC_PATH_PREFIX.length)
    : rawSlug;
  const blockContent = extractBlockContent(objects);
  const normalizedContent =
    pickFirstNonEmptyString(objects, [
      "content",
      "bodyMarkdown",
      "introMarkdown",
      "markdown",
      "contentMarkdown",
      "rawMarkdown",
      "rawContent",
      "body",
      "text",
    ]) || blockContent;
  const normalizedDescription = pickFirstNonEmptyString(objects, ["description", "subtitle", "summary", "excerpt"]);
  const normalizedCategory = String(pickFirstNonEmptyString(objects, ["category"]) || d?.sidebar?.section || "general");
  const statusCandidate = String(pickFirstNonEmptyString(objects, ["status"]) || "").toLowerCase();
  const normalizedStatus = ["draft", "published"].includes(statusCandidate)
    ? statusCandidate
    : d?.published === true
    ? "published"
    : "draft";
  const titleCandidate = pickFirstNonEmptyString(objects, ["title", "name", "heading"]);
  const seoTitleCandidate = pickFirstNonEmptyString(objects, ["metaTitle"]);
  const seoDescriptionCandidate = pickFirstNonEmptyString(objects, ["metaDescription"]);
  const seoImageCandidate = pickFirstNonEmptyString(objects, ["ogImage"]);
  const noIndexCandidate = objects.some((obj) => obj && typeof obj.noIndex === "boolean") ? !!objects.find((obj) => typeof obj?.noIndex === "boolean")?.noIndex : false;
  const keywordsCandidate = objects.find((obj) => Array.isArray(obj?.keywords))?.keywords;

  return {
    id: String(page._id),
    title: String(titleCandidate || page?.title || ""),
    slug: String(d.slug || normalizedSlug),
    description: normalizedDescription,
    content: normalizedContent,
    keywords: Array.isArray(keywordsCandidate) ? keywordsCandidate : [],
    category: normalizedCategory,
    order: Number(objects.find((obj) => typeof obj?.order === "number")?.order || 0),
    status: normalizedStatus,
    sidebar: {
      section: String(objects.find((obj) => typeof obj?.sidebar?.section === "string")?.sidebar?.section || normalizedCategory || "general"),
      sectionOrder: Number(objects.find((obj) => typeof obj?.sidebar?.sectionOrder === "number")?.sidebar?.sectionOrder || 0),
      itemOrder: Number(objects.find((obj) => typeof obj?.sidebar?.itemOrder === "number")?.sidebar?.itemOrder || 0),
    },
    seo: {
      metaTitle: String(seoTitleCandidate || titleCandidate || ""),
      metaDescription: String(seoDescriptionCandidate || normalizedDescription || ""),
      ogImage: String(seoImageCandidate || ""),
      noIndex: noIndexCandidate,
    },
    createdAt: page.createdAt,
    updatedAt: page.updatedAt,
  };
}

function isLegacyDocPage(page) {
  const slug = String(page?.slug || "").trim().toLowerCase();
  if (!slug || RESERVED_DOC_SLUGS.has(slug) || CMS_PAGE_SLUGS.has(slug)) return false;
  if (KNOWN_DOC_SLUGS.has(slug)) return true;
  const data = getDocPayloadFromPage(page);
  const hasBodyMarkdown = typeof data.bodyMarkdown === "string" && data.bodyMarkdown.trim().length > 0;
  const hasMarkdownishContent = typeof data.content === "string" && data.content.trim().length > 0;
  const hasNestedBlocks = Array.isArray(data.blocks) && data.blocks.length > 0;
  return hasBodyMarkdown || hasMarkdownishContent || hasNestedBlocks;
}

function isDocLikePayload(data) {
  if (!data || typeof data !== "object") return false;
  const source = getDocPayloadFromPage({ data });
  const objects = collectDeepObjects(source, 4);
  const hasDocType = String(source?.__type || source?.type || "").toLowerCase() === "doc";
  const hasMarkdown = Boolean(
    pickFirstNonEmptyString(objects, ["content", "bodyMarkdown", "introMarkdown", "markdown", "contentMarkdown", "rawMarkdown", "rawContent", "body"])
  );
  const hasDocFields = objects.some(
    (obj) =>
      typeof obj?.status === "string" ||
      typeof obj?.category === "string" ||
      Array.isArray(obj?.keywords) ||
      !!obj?.sidebar ||
      !!obj?.seo ||
      Array.isArray(obj?.blocks)
  );
  const hasDocSlug = Boolean(String(source.slug || "").trim());
  return hasDocType || hasMarkdown || (hasDocSlug && hasDocFields);
}

function isDocPage(page) {
  const slug = String(page?.slug || "").trim().toLowerCase();
  const normalizedCandidate = normalizeDocSlugCandidate(slug, page?.data || {});
  if (!slug || RESERVED_DOC_SLUGS.has(normalizedCandidate)) return false;
  return true;
}

async function adminDocsList(req, res) {
  const pages = await DocPage.find({}).sort({ updatedAt: -1 });
  const docs = pages
    .filter(isDocPage)
    .map(normalizeDocFromPage)
    .sort((a, b) => {
      const orderA = Number(a?.order || 0);
      const orderB = Number(b?.order || 0);
      if (orderA !== orderB) return orderA - orderB;
      return String(a?.title || "").localeCompare(String(b?.title || ""));
    });

  const brand = await DocSetting.findOne({ key: DOC_BRAND_KEY }).select("data");
  res.json({
    success: true,
    items: docs,
    meta: {
      brandName: String(brand?.data?.brandName || ""),
      brandLogoUrl: String(brand?.data?.brandLogoUrl || ""),
    },
  });
}

async function adminDocsGet(req, res) {
  const id = String(req.params.id || "").trim();
  const page = await resolveDocPageByIdentifier(id);
  if (!page) throw new HttpError(404, "Doc not found");
  return res.json({ success: true, doc: normalizeDocFromPage(page) });
}

async function adminDocsCreate(req, res) {
  const payload = await docSchema.validateAsync(req.body, { abortEarly: false, stripUnknown: true });
  const docSlug = String(payload.slug || "").trim().toLowerCase();
  if (RESERVED_DOC_SLUGS.has(docSlug)) throw new HttpError(400, "This slug is reserved and cannot be used for docs");
  const slug = docSlug;

  const exists = await DocPage.findOne({ slug }).select("_id");
  if (exists) throw new HttpError(409, "Doc slug already exists");

  const data = {
    ...payload,
    keywords: Array.isArray(payload.keywords)
      ? payload.keywords
      : String(payload.keywords || "").split(",").map((x) => String(x).trim()).filter(Boolean),
    sidebar: {
      ...(payload.sidebar || {}),
      section: String(payload?.sidebar?.section || payload.category || "general"),
    },
    __type: "doc",
  };

  const page = await DocPage.create({
    slug,
    title: payload.title,
    data,
    updatedByAdminId: String(req.user?.id || ""),
  });

  return res.json({ success: true, doc: normalizeDocFromPage(page) });
}

async function adminDocsUpdate(req, res) {
  const id = String(req.params.id || "").trim();
  const payload = await docSchema.validateAsync(req.body, { abortEarly: false, stripUnknown: true });

  const existing = await resolveDocPageByIdentifier(id);
  if (!existing) throw new HttpError(404, "Doc not found");

  const docSlug = String(payload.slug || "").trim().toLowerCase();
  if (RESERVED_DOC_SLUGS.has(docSlug)) throw new HttpError(400, "This slug is reserved and cannot be used for docs");
  const nextSlug = docSlug;
  if (nextSlug !== String(existing.slug)) {
    const conflict = await DocPage.findOne({ slug: nextSlug, _id: { $ne: existing._id } }).select("_id");
    if (conflict) throw new HttpError(409, "Doc slug already exists");
  }

  existing.slug = nextSlug;
  existing.title = payload.title;
  existing.data = {
    ...payload,
    keywords: Array.isArray(payload.keywords)
      ? payload.keywords
      : String(payload.keywords || "").split(",").map((x) => String(x).trim()).filter(Boolean),
    sidebar: {
      ...(payload.sidebar || {}),
      section: String(payload?.sidebar?.section || payload.category || "general"),
    },
    __type: "doc",
  };
  existing.updatedByAdminId = String(req.user?.id || "");
  await existing.save();

  return res.json({ success: true, doc: normalizeDocFromPage(existing) });
}

async function adminDocsDelete(req, res) {
  const id = String(req.params.id || "").trim();
  const page = await resolveDocPageByIdentifier(id);
  if (!page) throw new HttpError(404, "Doc not found");
  await DocPage.deleteOne({ _id: page._id });
  return res.json({ success: true });
}

async function adminDocsBrandGet(req, res) {
  const page = await DocSetting.findOne({ key: DOC_BRAND_KEY }).select("data");
  return res.json({
    success: true,
    settings: {
      brandName: String(page?.data?.brandName || ""),
      brandLogoUrl: String(page?.data?.brandLogoUrl || ""),
    },
  });
}

async function adminDocsBrandUpdate(req, res) {
  const schema = Joi.object({
    brandName: Joi.string().allow("").max(120).default(""),
    brandLogoUrl: Joi.string().allow("").max(5000).default(""),
  });
  const payload = await schema.validateAsync(req.body, { abortEarly: false, stripUnknown: true });

  const page = await DocSetting.findOneAndUpdate(
    { key: DOC_BRAND_KEY },
    { $set: { data: payload, updatedByAdminId: String(req.user?.id || "") } },
    { new: true, upsert: true }
  ).select("data");

  return res.json({
    success: true,
    settings: {
      brandName: String(page?.data?.brandName || ""),
      brandLogoUrl: String(page?.data?.brandLogoUrl || ""),
    },
  });
}

async function adminDocsBrandUploadLogo(req, res) {
  const file = req.file;
  if (!file?.buffer) throw new HttpError(400, "Logo file is required");

  const uploaded = await uploadBufferToCloudinary({
    buffer: file.buffer,
    mimeType: file.mimetype,
    originalName: file.originalname,
    folder: "waspakamify/docs-brand",
  });

  const logoUrl = String(uploaded?.secure_url || uploaded?.url || "").trim();
  if (!logoUrl) throw new HttpError(500, "Failed to upload logo");

  return res.json({ success: true, logoUrl });
}

module.exports = {
  adminDocsList,
  adminDocsGet,
  adminDocsCreate,
  adminDocsUpdate,
  adminDocsDelete,
  adminDocsBrandGet,
  adminDocsBrandUpdate,
  adminDocsBrandUploadLogo,
};
