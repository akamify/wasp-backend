function listResponse({ items, total, page, limit }) {
  return { success: true, items, page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) };
}

module.exports = { listResponse };

