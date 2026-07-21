const { DocPage } = require("@infra/database/DocPage");
const { DocCategory } = require("@infra/database/DocCategory");
const { DocFeedback } = require("@infra/database/DocFeedback");
const { DocSetting } = require("@infra/database/DocSetting");
const { HttpError } = require("@shared/utils/httpError");
const { appBrandName } = require("@core/config/env");
const { ensureAcademySeedData, slugify } = require("@modules/public/docsAcademy.seed");

const DOC_BRAND_KEY = "brand";

function asArray(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter(Boolean);
  return [];
}

function plainContent(data) {
  return String(data?.content || "").trim();
}

function contentBlocks(data) {
  return Array.isArray(data?.contentBlocks) ? data.contentBlocks : [];
}

function computeReadingTime(data) {
  const existing = Number(data?.readingTime || 0);
  if (existing > 0) return existing;
  const blockText = contentBlocks(data)
    .map((block) =>
      [block?.value, block?.description, block?.caption, ...(Array.isArray(block?.items) ? block.items : [])]
        .filter(Boolean)
        .join(" ")
    )
    .join(" ");
  const source = `${plainContent(data)} ${blockText}`.trim();
  const words = source ? source.split(/\s+/).filter(Boolean).length : 0;
  return Math.max(1, Math.ceil(words / 180));
}

function normalizeDoc(page, categoryMap = new Map()) {
  const data = page?.data || {};
  const categoryName = String(data?.category || data?.sidebar?.section || "general").trim() || "general";
  const categorySlug = slugify(categoryName);
  const category = categoryMap.get(categorySlug) || null;
  return {
    id: String(page?._id || ""),
    pageKey: String(page?.pageKey || data?.pageKey || ""),
    targetSectionId: String(page?.targetSectionId || data?.targetSectionId || ""),
    slug: String(data?.slug || page?.slug || ""),
    title: String(data?.title || page?.title || ""),
    description: String(data?.description || ""),
    content: plainContent(data),
    contentBlocks: contentBlocks(data),
    tags: asArray(data?.tags),
    keywords: asArray(data?.keywords),
    audience: asArray(data?.audience),
    readingTime: computeReadingTime(data),
    hero: data?.hero || null,
    sidebar: {
      section: categoryName,
      sectionOrder: Number(data?.sidebar?.sectionOrder || category?.order || 0),
      itemOrder: Number(data?.sidebar?.itemOrder ?? data?.order ?? 0),
    },
    seo: {
      metaTitle: String(data?.seo?.metaTitle || data?.title || page?.title || ""),
      metaDescription: String(data?.seo?.metaDescription || data?.description || ""),
      ogImage: String(data?.seo?.ogImage || ""),
      noIndex: !!data?.seo?.noIndex,
    },
    relatedArticleSlugs: asArray(data?.relatedArticleSlugs),
    videoMeta: data?.videoMeta || null,
    isPopular: !!data?.isPopular,
    isFeatured: !!data?.isFeatured,
    status: String(data?.status || "draft"),
    category: category
      ? {
          name: category.name,
          slug: category.slug,
          icon: category.icon,
          description: category.description,
          audience: category.audience || [],
          order: Number(category.order || 0),
        }
      : {
          name: categoryName,
          slug: categorySlug,
          icon: String(data?.hero?.icon || "BookOpen"),
          description: "",
          audience: asArray(data?.audience),
          order: Number(data?.sidebar?.sectionOrder || 0),
        },
    analytics: {
      views: Number(data?.analytics?.views || 0),
      lastViewedAt: data?.analytics?.lastViewedAt || null,
      searchHits: Number(data?.analytics?.searchHits || 0),
    },
    createdAt: page?.createdAt || null,
    updatedAt: page?.updatedAt || null,
  };
}

function scoreMatch(article, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return 0;
  const haystacks = [
    { value: article.title, weight: 12 },
    { value: article.description, weight: 8 },
    { value: article.category?.name, weight: 6 },
    { value: (article.tags || []).join(" "), weight: 5 },
    { value: (article.keywords || []).join(" "), weight: 5 },
    { value: article.content.slice(0, 500), weight: 2 },
  ];
  let score = 0;
  for (const item of haystacks) {
    const value = String(item.value || "").toLowerCase();
    if (!value) continue;
    if (value === q) score += item.weight * 3;
    else if (value.startsWith(q)) score += item.weight * 2;
    else if (value.includes(q)) score += item.weight;
    else {
      const pieces = q.split(/\s+/).filter(Boolean);
      const matched = pieces.filter((piece) => value.includes(piece)).length;
      if (matched) score += matched * Math.max(1, item.weight - 1);
    }
  }
  return score;
}

function stableSectionId(block) {
  return String(block?.sectionId || block?.anchorId || block?.id || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function headingItemsFromDocData(data) {
  const blocks = contentBlocks(data);
  const blockHeadings = blocks.flatMap((block) => {
    if (block?.type === "heading" && Number(block?.level || 2) >= 2) {
      const title = String(block?.value || "").trim();
      const id = stableSectionId(block);
      return title && id ? [{ id, title, level: Number(block?.level || 2) }] : [];
    }

    if (block?.type === "text") {
      return String(block?.value || "")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => /^##\s+|^###\s+/.test(line))
        .map((line) => {
          const level = line.startsWith("###") ? 3 : 2;
          const title = line.replace(/^#{2,3}\s+/, "").trim();
          return title ? { id: "", title, level } : null;
        })
        .filter((item) => item?.id);
    }

    return [];
  });

  if (blockHeadings.length) return blockHeadings;

  return plainContent(data)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^##\s+|^###\s+/.test(line))
    .map((line) => {
      const level = line.startsWith("###") ? 3 : 2;
      const title = line.replace(/^#{2,3}\s+/, "").trim();
      return title ? { id: "", title, level } : null;
    })
    .filter((item) => item?.id);
}

async function getPublishedDocsAndCategories() {
  await ensureAcademySeedData();
  const [categories, pages] = await Promise.all([
    DocCategory.find({ isPublished: true }).sort({ order: 1, name: 1 }).lean(),
    DocPage.find({ "data.__type": "doc", "data.status": "published" }).sort({ updatedAt: -1 }).lean(),
  ]);
  const categoryMap = new Map(categories.map((category) => [category.slug, category]));
  const docs = pages.map((page) => normalizeDoc(page, categoryMap));
  return { categories, docs, categoryMap };
}

async function docsLinkIndex(req, res) {
  const pages = await DocPage.find({ "data.__type": "doc", "data.status": "published" })
    .select("slug title pageKey targetSectionId data updatedAt")
    .sort({ updatedAt: -1 })
    .lean();

  const docs = pages.map((page) => {
    const data = page?.data || {};
    return {
      pageKey: String(page?.pageKey || data?.pageKey || ""),
      targetSectionId: String(page?.targetSectionId || data?.targetSectionId || ""),
      slug: String(data?.slug || page?.slug || ""),
      title: String(data?.title || page?.title || ""),
      description: String(data?.description || ""),
      category: String(data?.category || data?.sidebar?.section || ""),
      sections: headingItemsFromDocData(data).map((item) => ({
        id: item.id,
        title: item.title,
        level: item.level,
      })),
      updatedAt: page?.updatedAt || null,
    };
  }).filter((doc) => doc.slug && doc.title);

  return res.json({
    success: true,
    docs,
  });
}

async function buildFeedbackSummary(slug) {
  const rows = await DocFeedback.aggregate([
    { $match: { slug } },
    {
      $group: {
        _id: "$slug",
        total: { $sum: 1 },
        helpfulYes: { $sum: { $cond: [{ $eq: ["$helpful", true] }, 1, 0] } },
        helpfulNo: { $sum: { $cond: [{ $eq: ["$helpful", false] }, 1, 0] } },
      },
    },
  ]);
  const summary = rows[0] || { total: 0, helpfulYes: 0, helpfulNo: 0 };
  return {
    total: Number(summary.total || 0),
    helpfulYes: Number(summary.helpfulYes || 0),
    helpfulNo: Number(summary.helpfulNo || 0),
    helpfulPct: summary.total ? Number(((summary.helpfulYes / summary.total) * 100).toFixed(1)) : 0,
  };
}

async function academyHome(req, res) {
  const { categories, docs } = await getPublishedDocsAndCategories();
  const brand = await DocSetting.findOne({ key: DOC_BRAND_KEY }).select("data").lean();

  const tree = categories.map((category) => ({
    name: category.name,
    slug: category.slug,
    icon: category.icon,
    description: category.description,
    audience: category.audience || [],
    order: Number(category.order || 0),
    items: docs
      .filter((doc) => doc.category.slug === category.slug)
      .sort((a, b) => a.sidebar.itemOrder - b.sidebar.itemOrder || a.title.localeCompare(b.title))
      .map((doc) => ({
        id: doc.id,
        slug: doc.slug,
        title: doc.title,
        description: doc.description,
        readingTime: doc.readingTime,
        tags: doc.tags,
      })),
  }));

  const featuredArticles = docs.filter((doc) => doc.isFeatured).slice(0, 6);
  const popularArticles = [...docs]
    .sort((a, b) => (b.analytics.views || 0) - (a.analytics.views || 0) || (b.isPopular ? 1 : 0) - (a.isPopular ? 1 : 0))
    .slice(0, 6);
  const recentArticles = [...docs].sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0)).slice(0, 8);

  res.json({
    success: true,
    brand: {
      name: String(brand?.data?.brandName || appBrandName || "AI Wiz Chat Academy"),
      logoUrl: String(brand?.data?.brandLogoUrl || ""),
    },
    tree,
    featuredArticles,
    popularArticles,
    recentArticles,
  });
}

async function academyArticle(req, res) {
  const { categorySlug, articleSlug } = req.params;
  const { docs } = await getPublishedDocsAndCategories();
  const article = docs.find((doc) => doc.category.slug === String(categorySlug || "").trim() && doc.slug === String(articleSlug || "").trim());
  if (!article) throw new HttpError(404, "Academy article not found");

  await DocPage.updateOne(
    { _id: article.id },
    {
      $inc: { "data.analytics.views": 1 },
      $set: { "data.analytics.lastViewedAt": new Date() },
    }
  );

  const categoryDocs = docs
    .filter((doc) => doc.category.slug === article.category.slug)
    .sort((a, b) => a.sidebar.itemOrder - b.sidebar.itemOrder || a.title.localeCompare(b.title));
  const currentIndex = categoryDocs.findIndex((doc) => doc.id === article.id);
  const previousArticle = currentIndex > 0 ? categoryDocs[currentIndex - 1] : null;
  const nextArticle = currentIndex >= 0 && currentIndex < categoryDocs.length - 1 ? categoryDocs[currentIndex + 1] : null;

  const relatedArticles = docs
    .filter((doc) => doc.id !== article.id)
    .filter((doc) => article.relatedArticleSlugs.includes(doc.slug) || doc.category.slug === article.category.slug)
    .slice(0, 6);

  const feedbackSummary = await buildFeedbackSummary(article.slug);
  return res.json({
    success: true,
    article: {
      ...article,
      analytics: { ...article.analytics, views: article.analytics.views + 1 },
    },
    previousArticle,
    nextArticle,
    relatedArticles,
    feedbackSummary,
  });
}

async function academySearch(req, res) {
  const query = String(req.query.q || "").trim();
  const limit = Math.min(Math.max(Number(req.query.limit || 12), 1), 20);
  const { docs } = await getPublishedDocsAndCategories();
  if (!query) return res.json({ success: true, query, results: [] });

  const scored = docs
    .map((doc) => ({ doc, score: scoreMatch(doc, query) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || (b.doc.analytics.views || 0) - (a.doc.analytics.views || 0))
    .slice(0, limit);

  await Promise.all(
    scored.map((entry) =>
      DocPage.updateOne({ _id: entry.doc.id }, { $inc: { "data.analytics.searchHits": 1 } }).catch(() => {})
    )
  );

  return res.json({
    success: true,
    query,
    results: scored.map((entry) => ({
      ...entry.doc,
      score: entry.score,
      highlight: {
        title: entry.doc.title,
        description: entry.doc.description,
      },
    })),
  });
}

async function academyRelated(req, res) {
  const { categorySlug, articleSlug } = req.params;
  const { docs } = await getPublishedDocsAndCategories();
  const article = docs.find((doc) => doc.category.slug === String(categorySlug || "").trim() && doc.slug === String(articleSlug || "").trim());
  if (!article) throw new HttpError(404, "Academy article not found");
  const items = docs
    .filter((doc) => doc.id !== article.id)
    .filter((doc) => article.relatedArticleSlugs.includes(doc.slug) || doc.category.slug === article.category.slug)
    .slice(0, 6);
  return res.json({ success: true, items });
}

module.exports = {
  academyHome,
  academyArticle,
  academySearch,
  academyRelated,
  docsLinkIndex,
};
