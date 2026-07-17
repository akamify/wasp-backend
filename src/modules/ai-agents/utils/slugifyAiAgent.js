function slugifyAiAgent(value) {
  return String(value || "agent")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || "agent";
}

module.exports = { slugifyAiAgent };
