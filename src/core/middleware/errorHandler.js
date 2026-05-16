const { HttpError } = require("@shared/utils/httpError");

function notFound(req, res, next) {
  next(new HttpError(404, "Route not found"));
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  let statusCode = err.statusCode || 500;
  let message = err.message || "Internal server error";

  if (err?.code === 11000) {
    statusCode = 409;
    message = "Duplicate key error";
  }

  if (err?.name === "CastError") {
    statusCode = 400;
    message = "Invalid identifier";
  }

  if (statusCode >= 500) {
    // Avoid logging secrets; keep it concise but useful.
    // eslint-disable-next-line no-console
    console.error("Unhandled error:", err);
  }

  res.status(statusCode).json({
    success: false,
    message,
    ...(err.details ? { details: err.details } : {}),
  });
}

module.exports = { notFound, errorHandler };
