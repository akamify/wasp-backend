const { Readable } = require("stream");
const axios = require("axios");
const cheerio = require("cheerio");
const csv = require("csv-parser");
const mammoth = require("mammoth");
const pdfParse = require("pdf-parse");
const { HttpError } = require("@shared/utils/httpError");
const { validatePublicMediaUrl } = require("@shared/utils/mediaValidation");

const MAX_EXTRACTED_CHARS = 50000;
const WEBSITE_TIMEOUT_MS = Number(process.env.AI_KB_WEBSITE_TIMEOUT_MS || 15000);
const WEBSITE_MAX_BYTES = Number(process.env.AI_KB_WEBSITE_MAX_BYTES || 1024 * 1024);

function truncateKnowledge(text) {
  return String(text || "").slice(0, MAX_EXTRACTED_CHARS);
}

function extensionOf(name) {
  const match = String(name || "").toLowerCase().match(/\.([a-z0-9]+)$/);
  return match ? `.${match[1]}` : "";
}

function detectFileType(file) {
  const mime = String(file?.mimetype || "").toLowerCase();
  const ext = extensionOf(file?.originalname);
  if (mime === "application/pdf" || ext === ".pdf") return "pdf";
  if (mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" || ext === ".docx") return "docx";
  if (["text/csv", "application/csv", "application/vnd.ms-excel", "text/comma-separated-values"].includes(mime) || ext === ".csv") return "csv";
  if (mime === "text/plain" || ext === ".txt") return "txt";
  throw new HttpError(400, "Unsupported knowledge file type");
}

async function extractPdf(buffer) {
  try {
    const data = await pdfParse(buffer);
    return truncateKnowledge(data.text || "");
  } catch (error) {
    throw new HttpError(400, "Could not read PDF. The file may be encrypted, corrupted, or unsupported.", {
      extractor: "pdf",
      cause: error?.message || "PDF parse failed",
    });
  }
}

async function extractDocx(buffer) {
  try {
    const result = await mammoth.extractRawText({ buffer });
    return truncateKnowledge(result.value || "");
  } catch (error) {
    throw new HttpError(400, "Could not read DOCX. Please upload a valid .docx document.", {
      extractor: "docx",
      cause: error?.message || "DOCX parse failed",
    });
  }
}

function extractCsv(buffer) {
  return new Promise((resolve, reject) => {
    const rows = [];
    Readable.from(buffer)
      .pipe(csv({ mapHeaders: ({ header }) => String(header || "").trim() }))
      .on("data", (row) => {
        if (rows.length >= 1000) return;
        const line = Object.entries(row)
          .map(([key, value]) => `${key}: ${String(value || "").trim()}`)
          .filter((item) => !item.endsWith(":"))
          .join(" | ");
        if (line) rows.push(line);
      })
      .on("error", reject)
      .on("end", () => resolve(truncateKnowledge(rows.join("\n"))));
  });
}

function extractTxt(buffer) {
  return truncateKnowledge(buffer.toString("utf8"));
}

async function extractFile(file) {
  if (!file?.buffer || !Buffer.isBuffer(file.buffer)) throw new HttpError(400, "Knowledge file is required");
  const type = detectFileType(file);
  let content = "";
  if (type === "pdf") content = await extractPdf(file.buffer);
  if (type === "docx") content = await extractDocx(file.buffer);
  if (type === "csv") {
    try {
      content = await extractCsv(file.buffer);
    } catch (error) {
      throw new HttpError(400, "Could not read CSV. Please upload a valid comma-separated CSV file.", {
        extractor: "csv",
        cause: error?.message || "CSV parse failed",
      });
    }
  }
  if (type === "txt") content = extractTxt(file.buffer);
  content = String(content || "").trim();
  if (!content) {
    const messageByType = {
      pdf: "Could not extract text from PDF. If this is a scanned/image-only PDF, OCR is required. Please upload a text-based PDF or paste the content as Plain Text.",
      docx: "Could not extract text from DOCX. The file may contain only images/shapes or no readable paragraphs.",
      csv: "Could not extract text from CSV. The file may be empty, header-only, or not a valid CSV.",
      txt: "Could not extract text from TXT. The file appears empty or uses an unsupported encoding.",
    };
    throw new HttpError(400, messageByType[type] || "Could not extract text from file", {
      extractor: type,
      originalName: file.originalname || "",
      mimeType: file.mimetype || "",
    });
  }
  return {
    type,
    title: String(file.originalname || `${type.toUpperCase()} Knowledge`).replace(/\.[^.]+$/, "").slice(0, 200),
    content,
    metadata: {
      originalName: String(file.originalname || ""),
      mimeType: String(file.mimetype || ""),
      sizeBytes: Number(file.size || file.buffer.length || 0),
      extractionMethod: type,
    },
  };
}

function htmlToText(html) {
  const $ = cheerio.load(String(html || ""));
  $("script, style, noscript, svg, canvas, iframe, nav, footer, header, form").remove();
  const title = $("title").first().text().trim();
  const bodyText = $("main").text().trim() || $("article").text().trim() || $("body").text().trim();
  return {
    title,
    content: truncateKnowledge(bodyText.replace(/\s+/g, " ").trim()),
  };
}

async function fetchWebsiteText(url) {
  const safeUrl = validatePublicMediaUrl(url);
  const response = await axios.get(safeUrl, {
    timeout: WEBSITE_TIMEOUT_MS,
    maxContentLength: WEBSITE_MAX_BYTES,
    maxBodyLength: WEBSITE_MAX_BYTES,
    responseType: "text",
    headers: {
      "User-Agent": "AiWizChatAIKnowledgeBot/1.0",
      Accept: "text/html,application/xhtml+xml",
    },
  });
  const contentType = String(response.headers?.["content-type"] || "").toLowerCase();
  if (contentType && !contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
    throw new HttpError(400, "URL did not return an HTML page");
  }
  const extracted = htmlToText(response.data);
  if (!extracted.content) throw new HttpError(400, "Could not extract useful text from URL");
  return {
    title: extracted.title,
    content: extracted.content,
    sourceUrl: safeUrl,
    metadata: { extractionMethod: "website_html" },
  };
}

module.exports = {
  extractFile,
  fetchWebsiteText,
  htmlToText,
  detectFileType,
};
