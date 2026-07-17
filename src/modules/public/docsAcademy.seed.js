const { DocCategory } = require("@infra/database/DocCategory");
const { DocPage } = require("@infra/database/DocPage");

function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

const CATEGORY_OUTLINE = [
  {
    name: "Getting Started",
    icon: "Rocket",
    description: "Account setup, onboarding, and initial workspace configuration.",
    audience: ["business", "marketing", "agency"],
    articles: [
      "Introduction",
      "Platform Overview",
      "Create AI Wiz Chat Account",
      "Complete Business Profile",
      "Connect Meta WhatsApp Business",
      "Setup Checklist",
    ],
  },
  {
    name: "Dashboard Guide",
    icon: "LayoutDashboard",
    description: "Understand the main dashboard, analytics summary, contacts, and team visibility.",
    audience: ["business", "marketing", "agency"],
    articles: ["Dashboard Overview", "Analytics Explanation", "Contacts Overview", "Team / Agents Overview"],
  },
  {
    name: "WhatsApp Setup",
    icon: "Smartphone",
    description: "Meta onboarding, number setup, billing, and messaging quality.",
    audience: ["business", "marketing"],
    articles: [
      "Connect Meta Account",
      "Add WhatsApp Number",
      "Verify Business Manager",
      "Payment Method Setup",
      "Phone Number Quality Rating",
      "Messaging Limits Explained",
    ],
  },
  {
    name: "Templates",
    icon: "FileText",
    description: "Create, approve, optimize, and troubleshoot WhatsApp templates.",
    audience: ["business", "marketing"],
    articles: [
      "What is WhatsApp Template",
      "Create Template",
      "Template Categories",
      "Template Approval Guide",
      "Why Template Gets Rejected",
      "Edit Template",
      "Delete Template",
      "Template Variables",
      "Header/Footer/Button Setup",
      "Best Template Examples",
    ],
  },
  {
    name: "Contacts",
    icon: "Users",
    description: "Import, organize, enrich, and segment contacts for campaigns and CRM.",
    audience: ["business", "marketing", "agency"],
    articles: ["Import Contacts", "Upload CSV", "Create Contact Tags", "Custom Attributes", "Contact Segmentation"],
  },
  {
    name: "Campaigns",
    icon: "Megaphone",
    description: "Build, launch, schedule, and measure WhatsApp campaigns.",
    audience: ["marketing", "business"],
    articles: [
      "Create Campaign",
      "Schedule Campaign",
      "Recurring Campaign",
      "Campaign Analytics",
      "Failed Message Reasons",
      "Delivery Reports",
      "Export Reports",
    ],
  },
  {
    name: "Live Chat Inbox",
    icon: "MessageCircle",
    description: "Handle customer conversations, assignment, notes, and conversation status.",
    audience: ["team", "agency", "business"],
    articles: [
      "Inbox Overview",
      "Assign Chat To Agent",
      "Labels",
      "Notes",
      "Customer Timeline",
      "Conversation Status",
    ],
  },
  {
    name: "AI Agent",
    icon: "Bot",
    description: "Build, train, and manage AI agents with human handover support.",
    audience: ["business", "team", "developer"],
    articles: [
      "Create AI Agent",
      "Train AI Agent",
      "Upload Knowledge Base",
      "Connect AI Agent With WhatsApp",
      "AI Agent Rules",
      "Human Handover",
    ],
  },
  {
    name: "Flow Builder",
    icon: "Workflow",
    description: "Create automation journeys with message, logic, AI, and API nodes.",
    audience: ["business", "marketing", "developer"],
    articles: [
      "Introduction",
      "Create Automation Flow",
      "Text Node",
      "Button Node",
      "Question Node",
      "Condition Node",
      "Delay Node",
      "API Request Node",
      "AI Agent Node",
      "Human Transfer Node",
      "Publish Flow",
    ],
  },
  {
    name: "Analytics",
    icon: "BarChart3",
    description: "Interpret campaign, template, conversion, and team performance data.",
    audience: ["business", "marketing", "agency"],
    articles: [
      "Message Analytics",
      "Campaign Analytics",
      "Agent Performance",
      "Conversion Tracking",
      "Failed Reason Tracking",
    ],
  },
  {
    name: "Billing",
    icon: "CreditCard",
    description: "Plans, renewals, invoices, and subscription management.",
    audience: ["business", "agency"],
    articles: ["Upgrade Plan", "Auto Renewal", "Manage Subscription", "Invoice Download"],
  },
  {
    name: "Developer Documentation",
    icon: "Code2",
    description: "Integrate APIs, secure API keys, consume webhooks, and track events.",
    audience: ["developer"],
    articles: [
      "API Introduction",
      "Generate API Key",
      "Authentication",
      "Send WhatsApp Message API",
      "Template Message API",
      "Contact API",
      "Campaign API",
      "Webhook Setup",
      "Webhook Events",
      "Rate Limits",
      "Error Codes",
      "Links and Click Tracking",
      "Conversions and Analytics API",
    ],
  },
  {
    name: "Security",
    icon: "Shield",
    description: "API key hygiene, permissions, and team roles.",
    audience: ["business", "team", "developer"],
    articles: ["API Key Security", "Team Permission", "Roles Management"],
  },
  {
    name: "Troubleshooting",
    icon: "LifeBuoy",
    description: "Resolve common delivery, template, Meta, webhook, and payment issues.",
    audience: ["business", "marketing", "developer"],
    articles: ["Message Not Sending", "Template Pending Issue", "Meta Connection Error", "Webhook Error", "Payment Issue"],
  },
];

function buildGenericBlocks({ categoryName, articleTitle, isDeveloper = false }) {
  const base = [
    {
      type: "video",
      title: `Watch: ${articleTitle}`,
      url: "",
      thumbnail: "",
      duration: "5 min",
      caption: `Guided walkthrough for ${articleTitle.toLowerCase()}.`,
    },
    {
      type: "heading",
      level: 2,
      value: `What you will learn`,
    },
    {
      type: "list",
      style: "check",
      items: [
        `How ${articleTitle.toLowerCase()} fits into ${categoryName.toLowerCase()}.`,
        "The exact screen or API surface to use inside AI Wiz Chat.",
        "Common mistakes and best practices.",
      ],
    },
    {
      type: "heading",
      level: 2,
      value: articleTitle,
    },
    {
      type: "text",
      value: `${articleTitle} helps your team complete the ${categoryName.toLowerCase()} workflow using the existing AI Wiz Chat platform. This article is part of AI Wiz Chat Academy and is meant to be updated from the admin docs CMS without touching code.`,
    },
    {
      type: "callout",
      tone: "info",
      title: "Tip",
      description: "Use the screenshots, videos, and examples in this article as a customer-facing guide. Keep steps aligned with the current product UI.",
    },
  ];

  if (!isDeveloper) {
    base.push(
      {
        type: "image",
        url: "",
        caption: `${articleTitle} screen preview`,
      },
      {
        type: "step-card",
        step: "1",
        title: `Open the ${categoryName} workflow`,
        description: `Navigate to the relevant section from the left sidebar and verify your workspace is connected correctly before continuing.`,
        buttonText: "Continue",
        url: "./",
      }
    );
    return base;
  }

  base.push(
    {
      type: "api-endpoint",
      title: articleTitle,
      method: "POST",
      endpoint: "/api/example",
      auth: "X-API-KEY",
      requestExample: '{\n  "example": true\n}',
      responseExample: '{\n  "success": true\n}',
    },
    {
      type: "tabs",
      tabs: [
        { label: "curl", language: "bash", code: "curl -X POST https://api.example.com/api/example" },
        { label: "Node.js", language: "javascript", code: "await fetch('/api/example', { method: 'POST' })" },
        { label: "Python", language: "python", code: "requests.post('/api/example')" },
        { label: "PHP", language: "php", code: "$client->post('/api/example');" },
      ],
    }
  );
  return base;
}

function buildDeveloperOverrides(title) {
  const map = {
    "Generate API Key": {
      endpoint: "/api-keys/generate",
      method: "POST",
      requestExample: "{}",
      responseExample: '{\n  "success": true,\n  "message": "OTP sent"\n}',
    },
    Authentication: {
      endpoint: "/api/conversions/events",
      method: "POST",
      requestExample: '{\n  "event": "purchase",\n  "phone": "+919999999999",\n  "amount": 5000\n}',
      responseExample: '{\n  "success": true,\n  "event": {\n    "eventName": "purchase"\n  }\n}',
    },
    "Send WhatsApp Message API": {
      endpoint: "/integrations/campaigns/send",
      method: "POST",
      requestExample: '{\n  "campaignName": "Order Update",\n  "recipients": [{"to":"919999999999","variables":["John"]}]\n}',
      responseExample: '{\n  "success": true,\n  "campaignId": "abc123"\n}',
    },
    "Template Message API": {
      endpoint: "/templates",
      method: "POST",
      requestExample: '{\n  "name":"order_update",\n  "category":"utility"\n}',
      responseExample: '{\n  "success": true,\n  "template": {"name":"order_update"}\n}',
    },
    "Contact API": {
      endpoint: "/contacts",
      method: "POST",
      requestExample: '{\n  "name":"Rahul",\n  "phone":"919999999999"\n}',
      responseExample: '{\n  "success": true,\n  "contact": {"phone":"919999999999"}\n}',
    },
    "Campaign API": {
      endpoint: "/campaigns",
      method: "POST",
      requestExample: '{\n  "name":"Diwali Sale",\n  "type":"broadcast"\n}',
      responseExample: '{\n  "success": true,\n  "campaign": {"name":"Diwali Sale"}\n}',
    },
    "Webhook Setup": {
      endpoint: "/webhooks/meta",
      method: "POST",
      requestExample: '{\n  "entry": []\n}',
      responseExample: '{\n  "success": true\n}',
    },
    "Links and Click Tracking": {
      endpoint: "/links",
      method: "POST",
      requestExample: '{\n  "messageId":"MESSAGE_ID",\n  "url":"https://client.com/product"\n}',
      responseExample: '{\n  "success": true,\n  "trackedUrl":"https://domain.com/r/token"\n}',
    },
    "Conversions and Analytics API": {
      endpoint: "/api/conversions/events",
      method: "POST",
      requestExample: '{\n  "event":"purchase",\n  "phone":"+919999999999",\n  "amount":5000,\n  "orderId":"123"\n}',
      responseExample: '{\n  "success": true,\n  "event": {"eventName":"purchase"}\n}',
    },
  };
  return map[title] || null;
}

function buildArticle(category, title, order) {
  const categorySlug = slugify(category.name);
  const articleSlug = slugify(title);
  const isDeveloper = category.name === "Developer Documentation";
  const contentBlocks = buildGenericBlocks({
    categoryName: category.name,
    articleTitle: title,
    isDeveloper,
  });
  const override = isDeveloper ? buildDeveloperOverrides(title) : null;
  if (override) {
    const apiBlock = contentBlocks.find((block) => block.type === "api-endpoint");
    if (apiBlock) Object.assign(apiBlock, override, { title });
  }

  return {
    slug: articleSlug,
    categorySlug,
    title,
    description: `${title} guide for AI Wiz Chat Academy.`,
    tags: [category.name, ...(isDeveloper ? ["api", "developer"] : ["academy", "tutorial"])],
    keywords: [title, category.name, "ai wiz chat", articleSlug],
    audience: category.audience,
    isPopular: ["Introduction", "Connect Meta WhatsApp Business", "Create Template", "Create Campaign", "Generate API Key"].includes(title),
    isFeatured: ["Introduction", "API Introduction", "Create Campaign"].includes(title),
    hero: {
      title,
      subtitle: `${category.name} guide`,
      icon: category.icon,
      imageUrl: "",
    },
    videoMeta: {
      url: "",
      thumbnail: "",
      duration: ["Create AI Wiz Chat Account", "Connect Meta WhatsApp Business", "Create Template", "Create Campaign", "Generate API Key"].includes(title) ? "5 min" : "",
    },
    relatedArticleSlugs: [],
    contentBlocks,
    order,
  };
}

async function ensureAcademySeedData() {
  const existingCategories = await DocCategory.countDocuments({});
  if (existingCategories > 0) return;

  for (let index = 0; index < CATEGORY_OUTLINE.length; index += 1) {
    const category = CATEGORY_OUTLINE[index];
    const categorySlug = slugify(category.name);
    await DocCategory.create({
      name: category.name,
      slug: categorySlug,
      order: index + 1,
      icon: category.icon,
      description: category.description,
      audience: category.audience,
      isPublished: true,
      updatedByAdminId: "seed",
    });

    for (let articleIndex = 0; articleIndex < category.articles.length; articleIndex += 1) {
      const article = buildArticle(category, category.articles[articleIndex], articleIndex + 1);
      const content = article.contentBlocks
        .map((block) => {
          if (block.type === "heading") return `${"#".repeat(Math.max(1, Math.min(Number(block.level || 2), 4)))} ${block.value}`;
          if (block.type === "text") return block.value;
          if (block.type === "list") return (block.items || []).map((item) => `- ${item}`).join("\n");
          if (block.type === "callout") return `> ${block.title}: ${block.description}`;
          if (block.type === "api-endpoint") return `### ${block.title}\n\`${block.method} ${block.endpoint}\``;
          return "";
        })
        .filter(Boolean)
        .join("\n\n");

      await DocPage.create({
        slug: article.slug,
        title: article.title,
        updatedByAdminId: "seed",
        data: {
          __type: "doc",
          slug: article.slug,
          title: article.title,
          description: article.description,
          category: category.name,
          content,
          contentBlocks: article.contentBlocks,
          tags: article.tags,
          keywords: article.keywords,
          audience: article.audience,
          readingTime: 5,
          hero: article.hero,
          sidebar: {
            section: category.name,
            sectionOrder: index + 1,
            itemOrder: article.order,
          },
          seo: {
            metaTitle: `${article.title} | AI Wiz Chat Academy`,
            metaDescription: article.description,
            ogImage: "",
            noIndex: false,
          },
          relatedArticleSlugs: article.relatedArticleSlugs,
          videoMeta: article.videoMeta,
          isPopular: article.isPopular,
          isFeatured: article.isFeatured,
          status: "published",
          order: article.order,
          analytics: { views: 0, lastViewedAt: null, searchHits: 0 },
        },
      });
    }
  }
}

module.exports = { ensureAcademySeedData, CATEGORY_OUTLINE, slugify };
