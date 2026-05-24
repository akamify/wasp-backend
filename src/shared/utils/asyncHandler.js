const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch((err) => {
    if (typeof next === "function") return next(err);
    if (res && typeof res.status === "function") {
      return res.status(500).json({
        success: false,
        message: err?.message || "Internal server error",
      });
    }
    throw err;
  });
};

module.exports = { asyncHandler };

