const { HttpError } = require("@shared/utils/httpError");

function validate(schema, property = "body") {
  return (req, res, next) => {
    const { error, value } = schema.validate(req[property], {
      abortEarly: false,
      stripUnknown: true,
    });

    if (error) {
      const validationError = new HttpError(
        400,
        "Validation error",
        error.details.map((d) => d.message)
      );
      if (typeof next !== "function") {
        return res.status(400).json({
          success: false,
          message: validationError.message,
          details: validationError.details,
        });
      }
      return next(
        validationError
      );
    }

    req[property] = value;
    if (typeof next !== "function") {
      return res.status(500).json({
        success: false,
        message: "Middleware invocation error",
      });
    }
    return next();
  };
}

module.exports = { validate };

