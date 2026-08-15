const aiConversationStyleService = require("@modules/ai-agents/services/aiConversationStyle.service");

const KNOWN_BUSINESS_TYPES = [
  "real estate",
  "builder",
  "property",
  "clinic",
  "doctor",
  "hospital",
  "education",
  "school",
  "coaching",
  "ecommerce",
  "restaurant",
  "salon",
  "gym",
  "dental",
  "travel",
  "software",
  "marketing agency",
  "digital marketing",
  "manufacturing",
  "retail",
];

const SERVICE_KEYWORDS = [
  "website development",
  "software development",
  "meta ads",
  "google ads",
  "seo",
  "sales funnel",
  "whatsapp api",
  "automation",
  "crm",
  "landing page",
  "lead generation",
];

function clean(value, max = 160) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function uniqueList(items = [], max = 8) {
  return Array.from(new Set(items.map((item) => clean(item, 80)).filter(Boolean))).slice(0, max);
}

function pickKnownKeyword(text, options = []) {
  const normalized = String(text || "").toLowerCase();
  return options.find((item) => normalized.includes(item)) || "";
}

function extractBusinessType(text) {
  const normalized = clean(text, 280).toLowerCase();
  const known = pickKnownKeyword(normalized, KNOWN_BUSINESS_TYPES);
  if (known) return known;
  const patterns = [
    /(?:my business is|mera business|hamara business|our business is|i run|we run|hum)\s+([a-z0-9 &-]{3,60}?)(?:\s+(?:hai|is|ka|ki|ke|mein|me|and|or)\b|[.,!?]|$)/i,
    /(?:business type is|industry is)\s+([a-z0-9 &-]{3,60})(?:[.,!?]|$)/i,
  ];
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match?.[1]) return clean(match[1], 60).toLowerCase();
  }
  return "";
}

function extractGoal(text) {
  const normalized = clean(text, 280);
  const patterns = [
    /(?:i need|i want|looking for|help with|interested in)\s+(.+?)(?:[.?!]|$)/i,
    /(?:mujhe|hume|humko|hame)\s+(.+?)(?:chahiye|chaiye|chahie|help|madad)(?:[.?!]|$)/i,
    /(?:goal is|objective is)\s+(.+?)(?:[.?!]|$)/i,
  ];
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match?.[1]) return clean(match[1], 120);
  }
  return "";
}

function extractBudget(text) {
  const normalized = clean(text, 240);
  const match =
    normalized.match(/(?:budget|price|pricing|cost)\s*(?:is|around|about|=)?\s*([^\n.?!]{2,40})/i) ||
    normalized.match(/(?:rs\.?|inr|\$)\s*([0-9][0-9a-z,\s.-]{1,30})/i);
  return match?.[1] ? clean(match[1], 50) : "";
}

function extractTimeline(text) {
  const normalized = clean(text, 240).toLowerCase();
  const known = pickKnownKeyword(normalized, [
    "today",
    "tomorrow",
    "this week",
    "this month",
    "urgent",
    "immediately",
    "asap",
    "jaldi",
    "aaj",
    "is week",
    "is month",
  ]);
  return known || "";
}

function extractInterestedServices(text) {
  const normalized = clean(text, 280).toLowerCase();
  return uniqueList(SERVICE_KEYWORDS.filter((item) => normalized.includes(item)), 6);
}

function extractObjections(text) {
  const normalized = clean(text, 240).toLowerCase();
  const results = [];
  if (/\b(price|pricing|cost|charge|charges|expensive|mehenga|mahenga)\b/i.test(normalized)) results.push("pricing");
  if (/\b(roi|result|results|profit|fayda|benefit)\b/i.test(normalized)) results.push("roi");
  if (/\b(trust|bharosa|proof|guarantee|sure|doubt)\b/i.test(normalized)) results.push("trust");
  if (/\b(time|timeline|jaldi|urgent|slow)\b/i.test(normalized)) results.push("timing");
  return uniqueList(results, 4);
}

function extractAssistantQuestion(text) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (!value.includes("?")) return "";
  const sentence = value
    .split(/(?<=[?])/)
    .map((item) => item.trim())
    .find((item) => item.endsWith("?"));
  return clean(sentence, 180);
}

function normalizeProfile(profile = {}) {
  return {
    businessType: clean(profile.businessType, 80),
    businessGoal: clean(profile.businessGoal, 160),
    budgetHint: clean(profile.budgetHint, 60),
    timelineHint: clean(profile.timelineHint, 60),
    preferredLanguageStyle: clean(profile.preferredLanguageStyle, 20),
    lastUserIntent: clean(profile.lastUserIntent, 40),
    lastUserNeed: clean(profile.lastUserNeed, 160),
    lastAssistantQuestion: clean(profile.lastAssistantQuestion, 180),
    interestedServices: uniqueList(profile.interestedServices || [], 6),
    objections: uniqueList(profile.objections || [], 4),
    knownFacts: uniqueList(profile.knownFacts || [], 8),
    updatedAt: profile.updatedAt || null,
  };
}

function buildKnownFacts(profile) {
  const facts = [];
  if (profile.businessType) facts.push(`Business type: ${profile.businessType}`);
  if (profile.businessGoal) facts.push(`Goal: ${profile.businessGoal}`);
  if (profile.budgetHint) facts.push(`Budget hint: ${profile.budgetHint}`);
  if (profile.timelineHint) facts.push(`Timeline: ${profile.timelineHint}`);
  if (profile.interestedServices?.length) facts.push(`Interested services: ${profile.interestedServices.join(", ")}`);
  if (profile.objections?.length) facts.push(`Objections: ${profile.objections.join(", ")}`);
  return uniqueList(facts, 8);
}

function updateProfile({ currentProfile = {}, userMessage = "", assistantMessage = "" }) {
  const current = normalizeProfile(currentProfile);
  const languageStyle = userMessage
    ? aiConversationStyleService.inferLanguageStyle(userMessage)
    : current.preferredLanguageStyle;
  const intent = userMessage
    ? aiConversationStyleService.detectConversationIntent(userMessage)
    : current.lastUserIntent;

  const next = {
    ...current,
    preferredLanguageStyle: languageStyle || current.preferredLanguageStyle,
    lastUserIntent: intent || current.lastUserIntent,
    lastUserNeed: userMessage ? clean(userMessage, 160) : current.lastUserNeed,
    businessType: extractBusinessType(userMessage) || current.businessType,
    businessGoal: extractGoal(userMessage) || current.businessGoal,
    budgetHint: extractBudget(userMessage) || current.budgetHint,
    timelineHint: extractTimeline(userMessage) || current.timelineHint,
    interestedServices: uniqueList([
      ...(current.interestedServices || []),
      ...extractInterestedServices(userMessage),
    ], 6),
    objections: uniqueList([
      ...(current.objections || []),
      ...extractObjections(userMessage),
    ], 4),
    lastAssistantQuestion: assistantMessage
      ? extractAssistantQuestion(assistantMessage) || current.lastAssistantQuestion
      : current.lastAssistantQuestion,
    updatedAt: new Date(),
  };
  next.knownFacts = buildKnownFacts(next);
  return next;
}

function formatProfile(profile = {}) {
  const normalized = normalizeProfile(profile);
  const lines = [
    normalized.businessType ? `Business type: ${normalized.businessType}` : "",
    normalized.businessGoal ? `Goal: ${normalized.businessGoal}` : "",
    normalized.interestedServices.length ? `Interested services: ${normalized.interestedServices.join(", ")}` : "",
    normalized.budgetHint ? `Budget hint: ${normalized.budgetHint}` : "",
    normalized.timelineHint ? `Timeline: ${normalized.timelineHint}` : "",
    normalized.objections.length ? `Objections raised: ${normalized.objections.join(", ")}` : "",
    normalized.preferredLanguageStyle ? `Preferred style: ${normalized.preferredLanguageStyle}` : "",
    normalized.lastAssistantQuestion ? `Last assistant question: ${normalized.lastAssistantQuestion}` : "",
  ].filter(Boolean);
  return lines.length ? lines.join("\n") : "No remembered customer profile yet.";
}

module.exports = {
  normalizeProfile,
  updateProfile,
  formatProfile,
};
