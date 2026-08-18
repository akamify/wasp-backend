const SIMPLE_GREETING_PATTERNS = [
  /^hi$/i,
  /^hii+$/i,
  /^hello$/i,
  /^hey$/i,
  /^hy$/i,
  /^yo$/i,
  /^namaste$/i,
  /^good (morning|afternoon|evening)$/i,
];

const ROMAN_HINDI_HINTS = [
  "aap",
  "ap",
  "kaise",
  "kya",
  "kaun",
  "kyu",
  "kyun",
  "batao",
  "bataye",
  "chahiye",
  "hain",
  "hai",
  "mera",
  "meri",
  "mujhe",
  "hum",
  "sir",
  "ji",
  "kr",
  "kar",
  "rah",
  "rha",
  "raha",
  "krna",
  "karna",
  "pooch",
  "samjhao",
];

const INTENT_PRIORITY = [
  "greeting",
  "business_profile",
  "service_discovery",
  "pricing",
  "benefit",
  "industry",
  "qualification",
  "objection",
  "general",
];

function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .split(/[^a-z0-9\u0900-\u097f]+/i)
    .map((item) => item.trim())
    .filter(Boolean);
}

function hasDevanagari(text) {
  return /[\u0900-\u097f]/.test(String(text || ""));
}

function countRomanHindiHints(text) {
  const tokens = tokenize(text);
  return tokens.filter((token) => ROMAN_HINDI_HINTS.includes(token)).length;
}

function inferLanguageStyle(text) {
  const value = String(text || "").trim();
  if (!value) return "english";
  const hasHindiScript = hasDevanagari(value);
  const hasLatin = /[a-z]/i.test(value);
  const romanHindiHits = countRomanHindiHints(value);
  if (hasHindiScript && hasLatin) return "henglish";
  if (hasHindiScript) return "hindi";
  if (romanHindiHits >= 2) return "henglish";
  return "english";
}

function isSimpleGreeting(text) {
  const value = String(text || "").trim();
  if (!value) return false;
  return SIMPLE_GREETING_PATTERNS.some((pattern) => pattern.test(value));
}

function isBusinessInfoQuestion(text) {
  return isCompanyProfileQuestion(text) || isServiceQuestion(text);
}

function isCompanyProfileQuestion(text) {
  const value = String(text || "").trim().toLowerCase();
  if (!value) return false;
  return (
    /\b(what is|who are you|about|business profile|company profile|profile)\b/.test(value) ||
    /\b(what do you do)\b/.test(value) ||
    /\b(kya hai|kaun ho|kon ho|profile|business profile)\b/.test(value) ||
    /\b(kya karte ho)\b/.test(value)
  );
}

function isServiceQuestion(text) {
  const value = String(text || "").trim().toLowerCase();
  if (!value) return false;
  return (
    /\b(services|service|what do you offer|what services)\b/.test(value) ||
    /\b(konsi service|kon si service|services dete|service dete|service provide|provide karte)\b/.test(value)
  );
}

function detectIntentSignals(text) {
  const value = String(text || "").trim().toLowerCase();
  if (!value) return ["general"];
  if (isSimpleGreeting(value)) return ["greeting"];

  const intents = [];
  const pushIntent = (intent) => {
    if (intent && !intents.includes(intent)) intents.push(intent);
  };

  if (isCompanyProfileQuestion(value)) pushIntent("business_profile");
  if (
    isServiceQuestion(value) ||
    /\b(service|services|offer|offering|provide|products)\b/.test(value) ||
    /\b(service|services|dete|offer|provide|karte)\b/i.test(value)
  ) {
    pushIntent("service_discovery");
  }
  if (
    /\b(price|pricing|priceing|cost|charge|charges|package|quote|quotation|estimate|fee|fees|rate|rates|budget)\b/.test(value) ||
    /\b(kitna|kitne|price|pricing|budget|cost|charge|charges|quotation|quote|fees)\b/.test(value)
  ) {
    pushIntent("pricing");
  }
  if (/\b(profit|benefit|roi|result|results|grow|growth|advantage)\b/.test(value) || /\b(fayda|benefit|result|growth|profit)\b/i.test(value)) {
    pushIntent("benefit");
  }
  if (/\b(expensive|costly|high|trust|sure|guarantee|prove|proof|doubt)\b/.test(value) || /\b(mehenga|mahenga|trust|bharosa|sure|proof)\b/i.test(value)) {
    pushIntent("objection");
  }
  if (/\b(real estate|builder|clinic|doctor|education|school|coaching|ecommerce|restaurant|salon)\b/.test(value) || /\b(realestate|property|builder|clinic|doctor|school|coaching|ecommerce)\b/i.test(value)) {
    pushIntent("industry");
  }
  if (/\b(need|looking|want|help|suggest|recommend)\b/.test(value) || /\b(chahiye|suggest|recommend|help)\b/i.test(value)) {
    pushIntent("qualification");
  }

  if (!intents.length) return ["general"];
  return intents.sort((a, b) => INTENT_PRIORITY.indexOf(a) - INTENT_PRIORITY.indexOf(b));
}

function requestedKnowledgeSectionsForQuery(text) {
  const intents = detectIntentSignals(text);
  const sections = [];
  const pushSection = (sectionKey) => {
    if (sectionKey && !sections.includes(sectionKey)) sections.push(sectionKey);
  };

  for (const intent of intents) {
    if (intent === "business_profile") pushSection("business_profile");
    if (intent === "service_discovery") pushSection("services_products");
    if (intent === "pricing") pushSection("pricing_policy");
    if (intent === "benefit") pushSection("industry_playbooks");
    if (intent === "industry") pushSection("industry_playbooks");
    if (intent === "qualification") pushSection("lead_qualification");
    if (intent === "objection") pushSection("objection_handling");
  }

  if (isBusinessInfoQuestion(text)) pushSection("faq");
  return sections;
}

function inferResponseLength(text) {
  const value = String(text || "").trim();
  if (!value) return "short";
  if (isSimpleGreeting(value)) return "greeting";
  const intents = detectIntentSignals(value);
  const words = value.split(/\s+/).filter(Boolean);
  const lower = value.toLowerCase();
  const detailIntent =
    /\b(how|why|explain|detail|details|process|strategy|benefit|pricing|services|steps|compare)\b/i.test(lower) ||
    /\b(kaise|kyu|kyun|samjhao|detail|process|pricing|service|services)\b/i.test(lower);
  if (intents.length > 1) return "detailed";
  if (isBusinessInfoQuestion(value)) return words.length <= 6 ? "medium" : "detailed";
  if (detailIntent) return words.length <= 12 ? "medium" : "detailed";
  if (words.length <= 4 || value.length <= 24) return "very_short";
  if (words.length <= 12) return "short";
  return "medium";
}

function detectConversationIntent(text) {
  return detectIntentSignals(text)[0] || "general";
}

function shouldForceHandoverOnKnowledgeMiss(text) {
  const value = String(text || "").trim().toLowerCase();
  if (!value) return false;
  return (
    /\b(payment|paid|refund|billing|invoice|chargeback)\b/.test(value) ||
    /\b(complaint|angry|issue|problem|bad service|not happy)\b/.test(value) ||
    /\b(custom quote|custom quotation|quotation|quote|proposal)\b/.test(value) ||
    /\b(payment|refund|billing)\b/i.test(value) ||
    /\b(shikayat|complaint|refund|payment|quote|quotation)\b/i.test(value)
  );
}

function shouldPreferClarificationOverHandover(text) {
  const value = String(text || "").trim();
  if (!value) return true;
  if (shouldForceHandoverOnKnowledgeMiss(value)) return false;
  const intent = detectConversationIntent(value);
  return [
    "general",
    "business_profile",
    "service_discovery",
    "industry",
    "benefit",
    "qualification",
  ].includes(intent) || isBusinessInfoQuestion(value);
}

function maxOutputTokensForLength(length) {
  switch (length) {
    case "greeting":
      return 120;
    case "very_short":
      return 240;
    case "short":
      return 360;
    case "medium":
      return 560;
    case "detailed":
      return 920;
    default:
      return 360;
  }
}

function firstName(name) {
  const value = String(name || "").trim();
  if (!value) return "";
  return value.split(/\s+/)[0].slice(0, 40);
}

function buildGreetingReply({ userMessage, contactName }) {
  const style = inferLanguageStyle(userMessage);
  const name = firstName(contactName);
  const prefix = name ? `${name}${style === "hindi" ? " ji" : ""}` : "";
  if (style === "hindi") {
    return prefix
      ? `Namaste ${prefix}, aap kis cheez mein madad chahte hain?`
      : "Namaste, aap kis cheez mein madad chahte hain?";
  }
  if (style === "henglish") {
    return prefix
      ? `Hello ${prefix}, aap kis cheez ke baare mein poochna chahte hain?`
      : "Hello, aap kis cheez ke baare mein poochna chahte hain?";
  }
  return prefix ? `Hello ${prefix}! How can I help you today?` : "Hello! How can I help you today?";
}

function buildReplyStyleGuide({ userMessage, contactName }) {
  const languageStyle = inferLanguageStyle(userMessage);
  const responseLength = inferResponseLength(userMessage);
  const intents = detectIntentSignals(userMessage);
  const intent = intents[0] || "general";
  const businessInfoQuestion = isBusinessInfoQuestion(userMessage);
  const requestedKnowledgeSections = requestedKnowledgeSectionsForQuery(userMessage);
  const pricingQuestion = intents.includes("pricing");
  const mixedBusinessQuestion = intents.length > 1;
  const detailedServiceQuestion =
    intent === "service_discovery" ||
    (businessInfoQuestion && !pricingQuestion) ||
    intent === "benefit" ||
    intent === "industry";
  const name = firstName(contactName);
  const instructions = [
    languageStyle === "hindi"
      ? "Reply fully in Hindi script because the customer is typing in Hindi."
      : languageStyle === "henglish"
        ? "Reply in natural Hinglish because the customer is mixing Hindi and English."
        : "Reply in clear English because the customer is typing in English.",
    responseLength === "greeting"
      ? "For a greeting, reply in 1 to 2 short lines and include only one useful next question."
      : mixedBusinessQuestion
        ? "The customer asked multiple related things. Give one complete reply that covers every asked part before asking one short follow-up question if needed."
        : pricingQuestion
          ? "For a pricing question, reply in 2 to 4 short lines. Give the available pricing guidance first, and only then ask one short follow-up if exact pricing depends on the selected service."
          : detailedServiceQuestion
            ? "For a service or business query, give a short intro, then 2 to 3 short bullets if helpful, then only one useful follow-up question."
            : responseLength === "very_short"
              ? "The customer message is short, so keep the reply very short: 1 to 2 compact lines with only one useful next question."
              : responseLength === "short"
                ? businessInfoQuestion
                  ? "Keep the reply concise but complete. For direct business or service questions, finish the answer first and add a follow-up only if it genuinely helps."
                  : "Keep the reply concise: 1 to 2 short lines with only one useful next question unless the customer asks for detail."
                : responseLength === "medium"
                  ? businessInfoQuestion
                    ? "Give a concise but complete answer in 3 to 5 short lines. Do not cut the answer short just to force a follow-up question."
                    : "Give a concise explanation, keep it practical, and end with only one short useful follow-up question."
                  : businessInfoQuestion
                    ? "For business or service profile questions, give a complete answer first in 4 to 8 short lines or bullets. Add a follow-up only if it is genuinely useful."
                    : "For a detailed business query, give a concise explanation, then short bullet points, then only one useful follow-up question.",
    "Sound natural and conversational on WhatsApp, not robotic or overly formal.",
    "Never claim you are human, a person, or a team member. If the customer asks who you are, say you are the company's assistant or virtual assistant.",
    "Do not mention confidence scores, token limits, knowledge chunks, or internal retrieval.",
    "If relevant knowledge exists but one detail is missing, ask one short clarifying question before escalating.",
    intents.length > 1
      ? "The customer asked multiple related things in one message. Answer every asked part in the same reply before asking any follow-up question."
      : "If the customer asks only one thing, stay focused on that exact ask.",
    name ? `You may use the customer's first name (${name}) naturally, but at most once.` : "Do not force the customer's name if it feels unnatural.",
  ];
  return {
    languageStyle,
    responseLength,
    intent,
    intents,
    businessInfoQuestion,
    pricingQuestion,
    mixedBusinessQuestion,
    detailedServiceQuestion,
    requestedKnowledgeSections,
    maxOutputTokens: maxOutputTokensForLength(responseLength),
    instructions,
  };
}

function buildStructuredReplyPolicy(style = {}) {
  const intents = Array.isArray(style?.intents) ? style.intents : [];
  const pricingQuestion = Boolean(style?.pricingQuestion || intents.includes("pricing"));
  const mixedBusinessQuestion = Boolean(style?.mixedBusinessQuestion || intents.length > 1);
  const detailedServiceQuestion = Boolean(
    style?.detailedServiceQuestion ||
    style?.businessInfoQuestion ||
    ["service_discovery", "benefit", "industry"].includes(style?.intent)
  );

  return {
    enabled: style?.responseLength !== "greeting",
    pricingQuestion,
    mixedBusinessQuestion,
    detailedServiceQuestion,
    maxBulletPoints: pricingQuestion ? 2 : detailedServiceQuestion || mixedBusinessQuestion ? 3 : 2,
    allowFollowUpQuestion: style?.responseLength !== "greeting",
  };
}

function cleanDisplayLine(line) {
  let value = String(line || "").trim();
  if (!value) return "";
  value = value
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/^[-*]\s+/, "• ")
    .replace(/^\d+\.\s+/, "• ")
    .replace(/\s+/g, " ")
    .trim();
  return value;
}

function renderStructuredReply({ payload, style, userMessage = "" }) {
  const effectiveStyle =
    style ||
    buildReplyStyleGuide({
      userMessage,
      contactName: "",
    });
  const policy = buildStructuredReplyPolicy(effectiveStyle);
  const intro = cleanDisplayLine(payload?.intro || "");
  const pricingSummary = cleanDisplayLine(payload?.pricingSummary || "");
  const followUpQuestion = cleanDisplayLine(payload?.followUpQuestion || "");
  const bullets = Array.isArray(payload?.bullets)
    ? payload.bullets
        .map((item) => cleanDisplayLine(item))
        .filter(Boolean)
        .slice(0, policy.maxBulletPoints)
    : [];

  const lines = [];
  if (intro) lines.push(intro);
  for (const bullet of bullets) {
    lines.push(bullet.startsWith("• ") ? bullet : `• ${bullet}`);
  }
  if (pricingSummary) lines.push(pricingSummary);
  if (policy.allowFollowUpQuestion && followUpQuestion) lines.push(followUpQuestion);
  return lines.join("\n").trim();
}

function normalizeReplyForPolicy({ reply, userMessage, style }) {
  const text = String(reply || "").trim();
  if (!text) return "";

  const effectiveStyle =
    style ||
    buildReplyStyleGuide({
      userMessage,
      contactName: "",
    });

  let lines = normalizeLines(text);
  lines = rewriteFalseHumanClaims(lines, effectiveStyle.languageStyle);
  lines = repairDanglingEnding(lines);
  lines = enforceSingleQuestion(lines);

  if (!hasQuestion(lines) && shouldAddFollowUpQuestion({ userMessage, style: effectiveStyle, lines })) {
    lines.push(defaultFollowUpQuestion(effectiveStyle));
  }

  lines = limitLines(lines, effectiveStyle.responseLength);
  return lines.join("\n").trim();
}

function repairDanglingEnding(lines) {
  if (!Array.isArray(lines) || !lines.length) return [];
  const repaired = [...lines];
  const last = String(repaired[repaired.length - 1] || "").trim();
  if (!last) return repaired.filter(Boolean);

  const danglingPattern =
    /\b(in|for|with|about|on|at|from|to|of|including|like|such as|such|and|or|because|through|via)\s*$/i;

  if (danglingPattern.test(last)) {
    if (repaired.length > 1) {
      repaired.pop();
      return repaired.filter(Boolean);
    }
    repaired[0] = last.replace(danglingPattern, "").trim();
  }

  if (/[-:]\s*$/.test(last)) {
    if (repaired.length > 1) {
      repaired.pop();
      return repaired.filter(Boolean);
    }
    repaired[0] = last.replace(/[-:]\s*$/, "").trim();
  }

  const finalLine = String(repaired[repaired.length - 1] || "").trim();
  if (finalLine && !/[.!?]$/.test(finalLine) && finalLine.split(/\s+/).length >= 5) {
    repaired[repaired.length - 1] = `${finalLine}.`;
  }

  return repaired.filter(Boolean);
}

function shouldAddFollowUpQuestion({ userMessage, style, lines }) {
  const intent = style?.intent || "general";
  const responseLength = style?.responseLength || "short";
  const businessInfoQuestion = isBusinessInfoQuestion(userMessage);
  const totalChars = (lines || []).join(" ").length;

  if (responseLength === "greeting") return true;
  if (businessInfoQuestion) return false;
  if (["service_discovery", "pricing", "industry", "benefit", "qualification"].includes(intent)) return true;
  if (responseLength === "very_short" && totalChars < 90) return true;
  return false;
}

function normalizeLines(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => cleanDisplayLine(line))
    .filter(Boolean);
}

function rewriteFalseHumanClaims(lines, languageStyle) {
  const replacement =
    languageStyle === "hindi"
      ? "मैं यहां कंपनी की वर्चुअल असिस्टेंट हूं।"
      : languageStyle === "henglish"
        ? "Main yahan company ki virtual assistant hoon."
        : "I am the company's virtual assistant here.";

  return lines.map((line) => {
    if (/\b(i am|i'm)\s+(a\s+)?(human|real person|real human|team member|sales executive|employee)\b/i.test(line)) {
      return replacement;
    }
    if (/^(main|mai)\s+(ek\s+)?(insaan|human|real person|team member|employee)\b/i.test(line)) {
      return replacement;
    }
    if (/^मैं\s+(एक\s+)?(इंसान|मानव|टीम मेंबर|कर्मचारी)\b/.test(line)) {
      return replacement;
    }
    return line;
  });
}

function enforceSingleQuestion(lines) {
  let usedQuestion = false;
  return lines.map((line) => {
    if (!line.includes("?")) return line;
    let output = "";
    for (const char of line) {
      if (char !== "?") {
        output += char;
        continue;
      }
      if (!usedQuestion) {
        output += "?";
        usedQuestion = true;
      } else {
        output += ".";
      }
    }
    return output.replace(/\s+\./g, ".").trim();
  });
}

function hasQuestion(lines) {
  return (lines || []).some((line) => line.includes("?"));
}

function defaultFollowUpQuestion(style) {
  const languageStyle = style?.languageStyle || "english";
  const intent = style?.intent || "general";

  if (languageStyle === "hindi") {
    if (intent === "pricing") return "आप किस requirement के लिए pricing जानना चाहते हैं?";
    if (intent === "service_discovery") return "आप अपने business के लिए किस service में interested हैं?";
    if (intent === "industry" || intent === "benefit" || intent === "qualification") return "क्या आप अपने business के बारे में थोड़ा बता सकते हैं?";
    return "मैं आपकी किस बात में मदद कर सकती हूं?";
  }

  if (languageStyle === "henglish") {
    if (intent === "pricing") return "Aap kis requirement ke liye pricing pooch rahe hain?";
    if (intent === "service_discovery") return "Aap apne business ke liye kis service mein interested hain?";
    if (intent === "industry" || intent === "benefit" || intent === "qualification") return "Kya aap apne business ke baare mein thoda bata sakte hain?";
    return "Main aapki kis cheez mein help kar sakti hoon?";
  }

  if (intent === "pricing") return "What requirement would you like pricing for?";
  if (intent === "service_discovery") return "Which service are you most interested in?";
  if (intent === "industry" || intent === "benefit" || intent === "qualification") return "Could you tell me a bit about your business?";
  return "What would you like help with next?";
}

function buildKnowledgeMissClarifier({ userMessage, style }) {
  const effectiveStyle =
    style ||
    buildReplyStyleGuide({
      userMessage,
      contactName: "",
    });
  const intent = effectiveStyle.intent || "general";
  const languageStyle = effectiveStyle.languageStyle || "english";

  if (languageStyle === "hindi") {
    if (intent === "service_discovery") {
      return "Main aapko sahi service suggest kar sakti hoon. Kya aap website, ads, software, ya automation ke baare mein pooch rahe hain?";
    }
    if (intent === "industry" || intent === "benefit" || intent === "qualification") {
      return "Main sahi sujhav dene ke liye aapke business ke baare mein ek chhoti si detail chahungi. Aap kis type ka business chalate hain?";
    }
    return "Main aapko sahi aur relevant jawab dena chahti hoon. Kya aap business profile, services, ya pricing ke baare mein pooch rahe hain?";
  }

  if (languageStyle === "henglish") {
    if (intent === "service_discovery") {
      return "Main aapko sahi service suggest kar sakti hoon. Kya aap website, ads, software, ya automation ke baare mein pooch rahe hain?";
    }
    if (intent === "industry" || intent === "benefit" || intent === "qualification") {
      return "Main better suggest karne ke liye aapke business ke baare mein ek short detail chahungi. Aap kis type ka business chalate hain?";
    }
    return "Main aapko sahi aur relevant jawab dena chahti hoon. Kya aap business profile, services, ya pricing ke baare mein pooch rahe hain?";
  }

  if (intent === "service_discovery") {
    return "I can guide you better if you narrow it down a little. Are you asking about website, ads, software, or automation services?";
  }
  if (intent === "industry" || intent === "benefit" || intent === "qualification") {
    return "I can suggest the right approach if I know your business type first. What kind of business do you run?";
  }
  return "I want to give you the most relevant answer. Are you asking about the business profile, services, or pricing?";
}

function limitLines(lines, responseLength) {
  const maxLines =
    responseLength === "greeting" || responseLength === "very_short"
      ? 2
      : responseLength === "short"
        ? 3
      : responseLength === "medium"
        ? 6
        : 8;
  if (lines.length <= maxLines) return lines;
  return lines.slice(0, maxLines);
}

module.exports = {
  inferLanguageStyle,
  inferResponseLength,
  detectConversationIntent,
  shouldForceHandoverOnKnowledgeMiss,
  shouldPreferClarificationOverHandover,
  maxOutputTokensForLength,
  isSimpleGreeting,
  isBusinessInfoQuestion,
  isCompanyProfileQuestion,
  isServiceQuestion,
  buildGreetingReply,
  buildReplyStyleGuide,
  buildStructuredReplyPolicy,
  renderStructuredReply,
  buildKnowledgeMissClarifier,
  normalizeReplyForPolicy,
  detectIntentSignals,
  requestedKnowledgeSectionsForQuery,
};
