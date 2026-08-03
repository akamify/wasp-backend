function sanitizeMetaError(err, fallback) {
  return (
    err?.response?.data?.error?.error_user_msg ||
    err?.response?.data?.error?.message ||
    err?.message ||
    fallback
  );
}

function normalizeMetaError(err, fallback = "Meta request failed") {
  return {
    message: sanitizeMetaError(err, fallback),
    type: err?.response?.data?.error?.type || null,
    code: err?.response?.data?.error?.code || null,
    subcode: err?.response?.data?.error?.error_subcode || null,
    fbtraceId: err?.response?.data?.error?.fbtrace_id || null,
    status: err?.response?.status || null,
  };
}

function isRetryableMetaError(err) {
  const status = Number(err?.response?.status || 0);
  const code = Number(err?.response?.data?.error?.code || 0);
  const subcode = Number(err?.response?.data?.error?.error_subcode || 0);
  if ([133016].includes(code) || [133016].includes(subcode)) return false;
  if ([408, 409, 423, 429, 500, 502, 503, 504].includes(status)) return true;
  if ([1, 2, 4, 17, 32, 341, 613, 80007].includes(code)) return true;
  return false;
}

module.exports = {
  isRetryableMetaError,
  normalizeMetaError,
  sanitizeMetaError,
};
