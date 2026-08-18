const DEFAULT_MAX_LINE_LENGTH = 120;
const MAX_EMOJIS = 2;

function normalizeNewlines(value) {
  return String(value || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function stripUnsupportedMarkdown(text) {
  return String(text || "")
    .replace(/```([\s\S]*?)```/g, (_, code) => String(code || "").trim())
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, url) => String(alt || "").trim() || String(url || "").trim())
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "$1: $2")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\>\s?/gm, "")
    .replace(/^\s*[-*_]{3,}\s*$/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/_([^_\n]+)_/g, "$1");
}

function limitEmojis(text, maxEmojis = MAX_EMOJIS) {
  const value = String(text || "");
  let seen = 0;
  return value.replace(/\p{Extended_Pictographic}(?:\uFE0F)?/gu, (emoji) => {
    seen += 1;
    return seen <= maxEmojis ? emoji : "";
  });
}

function normalizeDecorativeClutter(text) {
  return String(text || "")
    .replace(/[ \t]+/g, " ")
    .replace(/^[=~`^•*\-]{4,}$/gm, "")
    .replace(/([!?]){3,}/g, "$1$1")
    .replace(/\.{4,}/g, "...")
    .replace(/([_-])\1{3,}/g, "")
    .replace(/\n{3,}/g, "\n\n");
}

function stripDecorativeEdgeEmojis(line) {
  return String(line || "")
    .replace(/^(?:\p{Extended_Pictographic}(?:\uFE0F)?\s*)+/gu, "")
    .replace(/(?:\s*\p{Extended_Pictographic}(?:\uFE0F)?)+$/gu, "")
    .trim();
}

function isBulletLine(line) {
  return /^(\s*[-*•]\s+|\s*\d+[.)]\s+)/.test(String(line || ""));
}

function normalizeBulletLine(line) {
  const value = String(line || "").trim();
  if (!value) return "";
  return value
    .replace(/^[-*•]\s+/, "")
    .replace(/^\d+[.)]\s+/, "")
    .trim()
    .replace(/\s+/g, " ");
}

function applySafeBoldToLabel(line) {
  const value = stripDecorativeEdgeEmojis(line);
  if (!value) return "";

  const bulletPrefixMatch = value.match(/^([•]\s+)/);
  const bulletPrefix = bulletPrefixMatch ? bulletPrefixMatch[1] : "";
  const body = bulletPrefix ? value.slice(bulletPrefix.length).trim() : value;
  const colonIndex = body.indexOf(":");
  if (colonIndex <= 0 || colonIndex > 24) {
    return value;
  }

  const label = body.slice(0, colonIndex).trim();
  const rest = body.slice(colonIndex + 1).trim();
  if (!label || !rest) {
    return value;
  }
  if (label.length > 24 || /\bhttps?:\/\//i.test(label) || /[*_]/.test(label)) {
    return value;
  }

  const words = label.split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 4) {
    return value;
  }

  return `${bulletPrefix}*${label}:* ${rest}`;
}

function wrapLine(line, maxLineLength = DEFAULT_MAX_LINE_LENGTH) {
  const raw = String(line || "").trim();
  if (!raw) return [];
  if (raw.length <= maxLineLength) return [raw];

  const words = raw.split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const wrapped = [];
  let current = "";

  for (const word of words) {
    if (!current) {
      current = word;
      continue;
    }
    if (`${current} ${word}`.length <= maxLineLength) {
      current = `${current} ${word}`;
      continue;
    }
    wrapped.push(current);
    current = word;
  }

  if (current) wrapped.push(current);
  return wrapped;
}

function splitIntoLogicalLines(text, maxLineLength = DEFAULT_MAX_LINE_LENGTH) {
  const lines = normalizeNewlines(text).split("\n");
  const output = [];
  let previousWasBlank = false;

  for (const rawLine of lines) {
    const line = String(rawLine || "").replace(/\s+/g, " ").trim();
    if (!line) {
      if (!previousWasBlank && output.length) {
        output.push("");
      }
      previousWasBlank = true;
      continue;
    }

    previousWasBlank = false;

    if (isBulletLine(line)) {
      const bulletBody = normalizeBulletLine(line);
      const wrapped = wrapLine(bulletBody, Math.max(40, maxLineLength - 2));
      wrapped.forEach((segment, index) => {
        output.push(index === 0 ? `• ${segment}` : `  ${segment}`);
      });
      continue;
    }

    wrapLine(line, maxLineLength).forEach((segment) => output.push(segment));
  }

  while (output.length && !output[output.length - 1]) {
    output.pop();
  }

  return output;
}

function formatWhatsAppText(text, options = {}) {
  const maxLineLength = Math.max(40, Number(options.maxLineLength || DEFAULT_MAX_LINE_LENGTH) || DEFAULT_MAX_LINE_LENGTH);
  const stripped = stripUnsupportedMarkdown(text);
  const limitedEmojiText = limitEmojis(stripped, Number(options.maxEmojis || MAX_EMOJIS) || MAX_EMOJIS);
  const normalized = normalizeDecorativeClutter(limitedEmojiText);
  const formatted = splitIntoLogicalLines(normalized, maxLineLength)
    .map((line) => applySafeBoldToLabel(line))
    .join("\n");
  return formatted.replace(/\n{3,}/g, "\n\n").trim();
}

module.exports = {
  formatWhatsAppText,
};
