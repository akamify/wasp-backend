const { HttpError } = require("@shared/utils/httpError");

function validate(schema, property = "body") {
  return (req, res, next) => {
    const { error, value } = schema.validate(req[property], {
      abortEarly: false,
      stripUnknown: true,
    });

    if (error) {
      return next(
        new HttpError(
          400,
          "Validation error",
          error.details.map((d) => d.message)
        )
      );
    }

    req[property] = value;
    return next();
  };
}

module.exports = { validate };

