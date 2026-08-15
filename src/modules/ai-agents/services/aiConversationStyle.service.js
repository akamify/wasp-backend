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
  const value = String(text || "").trim().toLowerCase();
  if (!value) return false;
  return (
    /\b(what is|who are you|about|business profile|company profile|profile)\b/.test(value) ||
    /\b(services|service|what do you do|what do you offer)\b/.test(value) ||
    /\b(kya hai|kaun ho|kon ho|profile|business profile)\b/.test(value) ||
    /\b(kya karte ho|konsi service|kon si service|services dete|service dete)\b/.test(value)
  );
}

function inferResponseLength(text) {
  const value = String(text || "").trim();
  if (!value) return "short";
  if (isSimpleGreeting(value)) return "greeting";
  const words = value.split(/\s+/).filter(Boolean);
  const lower = value.toLowerCase();
  const detailIntent =
    /\b(how|why|explain|detail|details|process|strategy|benefit|pricing|services|steps|compare)\b/i.test(lower) ||
    /\b(kaise|kyu|kyun|samjhao|detail|process|pricing|service|services)\b/i.test(lower);
  if (detailIntent || isBusinessInfoQuestion(value)) return words.length <= 12 ? "medium" : "detailed";
  if (words.length <= 4 || value.length <= 24) return "very_short";
  if (words.length <= 12) return "short";
  return "medium";
}

function detectConversationIntent(text) {
  const value = String(text || "").trim().toLowerCase();
  if (!value) return "general";
  if (isSimpleGreeting(value)) return "greeting";
  if (/\b(price|pricing|cost|charge|charges|package|quote|budget)\b/.test(value) || /\b(price|pricing|budget|cost|charge|charges)\b/i.test(value) || /\b(price|pricing)\b/i.test(value) || /\b(price)\b/i.test(value) || /\b(kitna|price|pricing|budget|cost)\b/.test(value)) {
    return "pricing";
  }
  if (/\b(service|services|offer|offering|provide|products)\b/.test(value) || /\b(service|services|dete|offer|provide|karte)\b/i.test(value)) {
    return "service_discovery";
  }
  if (/\b(profit|benefit|roi|result|results|grow|growth|advantage)\b/.test(value) || /\b(fayda|benefit|result|growth|profit)\b/i.test(value)) {
    return "benefit";
  }
  if (/\b(expensive|costly|high|trust|sure|guarantee|prove|proof|doubt)\b/.test(value) || /\b(mehenga|mahenga|trust|bharosa|sure|proof)\b/i.test(value)) {
    return "objection";
  }
  if (/\b(real estate|builder|clinic|doctor|education|school|coaching|ecommerce|restaurant|salon)\b/.test(value) || /\b(realestate|property|builder|clinic|doctor|school|coaching|ecommerce)\b/i.test(value)) {
    return "industry";
  }
  if (/\b(need|looking|want|help|suggest|recommend)\b/.test(value) || /\b(chahiye|suggest|recommend|help)\b/i.test(value)) {
    return "qualification";
  }
  return "general";
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
    "service_discovery",
    "industry",
    "benefit",
    "qualification",
  ].includes(intent) || isBusinessInfoQuestion(value);
}

function maxOutputTokensForLength(length) {
  switch (length) {
    case "greeting":
      return 80;
    case "very_short":
      return 140;
    case "short":
      return 220;
    case "medium":
      return 360;
    case "detailed":
      return 520;
    default:
      return 220;
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
  const intent = detectConversationIntent(userMessage);
  const name = firstName(contactName);
  const instructions = [
    languageStyle === "hindi"
      ? "Reply fully in Hindi script because the customer is typing in Hindi."
      : languageStyle === "henglish"
        ? "Reply in natural Hinglish because the customer is mixing Hindi and English."
        : "Reply in clear English because the customer is typing in English.",
    responseLength === "greeting"
      ? "For a greeting, reply in 1 to 2 short lines and include only one useful next question."
      : responseLength === "very_short"
        ? "The customer message is short, so keep the reply very short: 1 to 2 compact lines with only one useful next question."
        : responseLength === "short"
          ? "Keep the reply concise: 1 to 2 short lines with only one useful next question unless the customer asks for detail."
          : responseLength === "medium"
            ? "Give a concise explanation, keep it practical, and end with only one short useful follow-up question."
            : "For a detailed business query, give a concise explanation, then short bullet points, then only one useful follow-up question.",
    "Sound natural and conversational on WhatsApp, not robotic or overly formal.",
    "Never claim you are human, a person, or a team member. If the customer asks who you are, say you are the company's assistant or virtual assistant.",
    "Do not mention confidence scores, token limits, knowledge chunks, or internal retrieval.",
    "If relevant knowledge exists but one detail is missing, ask one short clarifying question before escalating.",
    name ? `You may use the customer's first name (${name}) naturally, but at most once.` : "Do not force the customer's name if it feels unnatural.",
  ];
  return {
    languageStyle,
    responseLength,
    intent,
    maxOutputTokens: maxOutputTokensForLength(responseLength),
    instructions,
  };
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
  lines = enforceSingleQuestion(lines);

  if (!hasQuestion(lines)) {
    lines.push(defaultFollowUpQuestion(effectiveStyle));
  }

  lines = limitLines(lines, effectiveStyle.responseLength);
  return lines.join("\n").trim();
}

function normalizeLines(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
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
    responseLength === "greeting" || responseLength === "very_short" || responseLength === "short"
      ? 2
      : responseLength === "medium"
        ? 4
        : 6;
  if (lines.length <= maxLines) return lines;
  const head = lines.slice(0, Math.max(1, maxLines - 1));
  const tail = lines[lines.length - 1];
  return [...head, tail];
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
  buildGreetingReply,
  buildReplyStyleGuide,
  buildKnowledgeMissClarifier,
  normalizeReplyForPolicy,
};
