const { HttpError } = require("./httpError");

const AUTH_OTP_BUTTON = Object.freeze({
  type: "OTP",
  otp_type: "COPY_CODE",
  text: "Copy code",
});

function toTrimmedString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function toUpper(value) {
  return toTrimmedString(value).toUpperCase();
}

function toLower(value) {
  return toTrimmedString(value).toLowerCase();
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function ensureStringArray(value) {
  return ensureArray(value).map((item) => String(item ?? ""));
}

function invariant(condition, message) {
  if (!condition) {
    throw new HttpError(400, message);
  }
}

function maxPlaceholderIndex(text) {
  const source = String(text || "");
  const matches = source.matchAll(/\{\{(\d+)\}\}/g);
  let max = 0;

  for (const match of matches) {
    const index = Number(match[1]);
    if (Number.isFinite(index) && index > max) {
      max = index;
    }
  }

  return max;
}

function hasDynamicUrl(url) {
  return /\{\{\d+\}\}/.test(String(url || ""));
}

function normalizeAuthSecurityRecommendation(components) {
  const bodyComponent = ensureArray(components).find(
    (component) => toUpper(component?.type) === "BODY"
  );

  if (typeof bodyComponent?.add_security_recommendation === "boolean") {
    return bodyComponent.add_security_recommendation;
  }

  return true;
}

function normalizeButton(button, category) {
  const type = toUpper(button?.type);

  if (type === "URL") {
    const text = toTrimmedString(button?.text);
    const url = toTrimmedString(button?.url);

    invariant(text, "URL button text is required");
    invariant(url, "URL button URL is required");

    return {
      type: "URL",
      text,
      url,
    };
  }

  if (type === "QUICK_REPLY") {
    const text = toTrimmedString(button?.text);
    invariant(text, "Quick reply button text is required");

    return {
      type: "QUICK_REPLY",
      text,
    };
  }

  if (type === "PHONE_NUMBER") {
    const text = toTrimmedString(button?.text);
    const phoneNumber = toTrimmedString(button?.phone_number || button?.phoneNumber);
    invariant(text, "Phone button text is required");
    invariant(phoneNumber, "Phone button number is required");

    return {
      type: "PHONE_NUMBER",
      text,
      phone_number: phoneNumber,
    };
  }

  if (type === "OTP" && category === "authentication") {
    return { ...AUTH_OTP_BUTTON };
  }

  throw new HttpError(400, `Unsupported button type: ${button?.type || "unknown"}`);
}

function normalizeStandardComponents(category, components) {
  const normalized = [];
  let hasBody = false;

  for (const component of ensureArray(components)) {
    const type = toUpper(component?.type);

    if (type === "BODY") {
      const text = String(component?.text ?? "");
      invariant(text.trim(), "BODY text is required");
      hasBody = true;
      normalized.push({
        type: "BODY",
        text,
      });
      continue;
    }

    if (type === "HEADER") {
      const format = toUpper(component?.format || (component?.text ? "TEXT" : ""));

      if (format === "TEXT") {
        const text = String(component?.text ?? "");
        invariant(text.trim(), "HEADER text is required");
        normalized.push({
          type: "HEADER",
          format: "TEXT",
          text,
        });
        continue;
      }

      normalized.push({
        type: "HEADER",
        ...(format ? { format } : {}),
        ...(component?.example ? { example: component.example } : {}),
      });
      continue;
    }

    if (type === "BUTTONS") {
      const buttons = ensureArray(component?.buttons).map((button) =>
        normalizeButton(button, category)
      );

      if (buttons.length > 0) {
        normalized.push({
          type: "BUTTONS",
          buttons,
        });
      }
      continue;
    }

    if (type === "FOOTER") {
      const text = toTrimmedString(component?.text);
      if (text) {
        normalized.push({
          type: "FOOTER",
          text,
        });
      }
      continue;
    }

    if (!type) {
      continue;
    }

    throw new HttpError(400, `Unsupported component type: ${component?.type || "unknown"}`);
  }

  invariant(hasBody, "BODY component is required");

  const buttonComponent = normalized.find((component) => component.type === "BUTTONS");
  if (category === "utility" && buttonComponent?.buttons?.length > 1) {
    throw new HttpError(400, "Utility templates support at most one button");
  }

  return normalized;
}

function normalizeAuthenticationComponents(components) {
  return [
    {
      type: "BODY",
      add_security_recommendation: normalizeAuthSecurityRecommendation(components),
    },
    {
      type: "BUTTONS",
      buttons: [{ ...AUTH_OTP_BUTTON }],
    },
  ];
}

function normalizeTemplate(template) {
  const category = toLower(template?.category);

  invariant(
    ["marketing", "utility", "authentication"].includes(category),
    "Invalid template category"
  );

  const normalized = {
    ...template,
    name: toTrimmedString(template?.name),
    language: toTrimmedString(template?.language),
    category,
  };

  if (category === "authentication") {
    return {
      ...normalized,
      components: normalizeAuthenticationComponents(template?.components),
    };
  }

  return {
    ...normalized,
    components: normalizeStandardComponents(category, template?.components),
  };
}

function getButtonRuntimeValue(button, buttonValues, data) {
  const buttonIndex = Number(button.__runtimeIndex || 0);
  return toTrimmedString(buttonValues[buttonIndex] ?? data?.urlParam ?? "");
}

function validateBeforeSend(template, data = {}) {
  const variables = ensureStringArray(data.variables);
  const headerVariables = ensureStringArray(data.headerVariables);
  const buttonValues = ensureStringArray(data.buttonValues);

  for (const component of ensureArray(template?.components)) {
    if (toUpper(component?.type) === "HEADER" && toUpper(component?.format) === "TEXT") {
      const requiredVariables = maxPlaceholderIndex(component?.text);
      invariant(
        headerVariables.length >= requiredVariables,
        requiredVariables === 1
          ? "1 header variable is required"
          : `${requiredVariables} header variables are required`
      );
    }

    if (toUpper(component?.type) === "BODY") {
      const requiredVariables = maxPlaceholderIndex(component?.text);
      invariant(
        variables.length >= requiredVariables,
        requiredVariables === 1
          ? "1 body variable is required"
          : `${requiredVariables} body variables are required`
      );
    }

    if (toUpper(component?.type) === "BUTTONS") {
      ensureArray(component?.buttons).forEach((button, index) => {
        const buttonType = toUpper(button?.type);
        const runtimeValue = getButtonRuntimeValue(
          { ...button, __runtimeIndex: index },
          buttonValues,
          data
        );

        if (buttonType === "OTP") {
          invariant(toTrimmedString(data.otpCode || runtimeValue), "OTP required");
        }

        if (buttonType === "URL" && hasDynamicUrl(button?.url)) {
          invariant(runtimeValue, `Dynamic URL value required for button ${index + 1}`);
        }
      });
    }
  }
}

function buildButtonComponent(button, index, data) {
  const buttonType = toUpper(button?.type);
  const buttonValues = ensureStringArray(data.buttonValues);
  const runtimeValue = getButtonRuntimeValue(
    { ...button, __runtimeIndex: index },
    buttonValues,
    data
  );

  if (buttonType === "OTP") {
    return {
      type: "button",
      sub_type: button.otp_type,
      index: String(index),
      parameters: [
        {
          type: "text",
          text: toTrimmedString(data.otpCode || runtimeValue),
        },
      ],
    };
  }

  if (buttonType === "URL" && hasDynamicUrl(button?.url)) {
    return {
      type: "button",
      sub_type: "url",
      index: String(index),
      parameters: [
        {
          type: "text",
          text: runtimeValue,
        },
      ],
    };
  }

  if (buttonType === "QUICK_REPLY" && runtimeValue) {
    return {
      type: "button",
      sub_type: "quick_reply",
      index: String(index),
      parameters: [
        {
          type: "payload",
          payload: runtimeValue,
        },
      ],
    };
  }

  return null;
}

function buildComponentsFromTemplate(template, data = {}) {
  const normalizedTemplate = normalizeTemplate(template);
  validateBeforeSend(normalizedTemplate, data);

  const variables = ensureStringArray(data.variables);
  const headerVariables = ensureStringArray(data.headerVariables);
  const components = [];

  for (const component of ensureArray(normalizedTemplate.components)) {
    if (toUpper(component?.type) === "HEADER" && toUpper(component?.format) === "TEXT") {
      const requiredVariables = maxPlaceholderIndex(component?.text);

      if (requiredVariables > 0) {
        components.push({
          type: "header",
          parameters: headerVariables.slice(0, requiredVariables).map((value) => ({
            type: "text",
            text: value,
          })),
        });
      }
    }

    if (toUpper(component?.type) === "BODY") {
      const requiredVariables = maxPlaceholderIndex(component?.text);

      if (requiredVariables > 0) {
        components.push({
          type: "body",
          parameters: variables.slice(0, requiredVariables).map((value) => ({
            type: "text",
            text: value,
          })),
        });
      }
    }

    if (toUpper(component?.type) === "BUTTONS") {
      ensureArray(component?.buttons).forEach((button, index) => {
        const mappedButton = buildButtonComponent(button, index, data);
        if (mappedButton) {
          components.push(mappedButton);
        }
      });
    }
  }

  return components;
}

function replacePlaceholders(text, values) {
  return String(text || "").replace(/\{\{(\d+)\}\}/g, (_, index) => {
    const resolved = values[Number(index) - 1];
    return resolved !== undefined && resolved !== null && resolved !== ""
      ? String(resolved)
      : `{{${index}}}`;
  });
}

function renderTemplatePreview(template, data = {}) {
  const normalizedTemplate = normalizeTemplate(template);
  const body = ensureArray(normalizedTemplate.components).find(
    (component) => toUpper(component?.type) === "BODY" && typeof component?.text === "string"
  );

  if (body?.text) {
    return replacePlaceholders(body.text, ensureStringArray(data.variables)).slice(0, 280);
  }

  const header = ensureArray(normalizedTemplate.components).find(
    (component) =>
      toUpper(component?.type) === "HEADER" &&
      toUpper(component?.format) === "TEXT" &&
      typeof component?.text === "string"
  );

  if (header?.text) {
    return replacePlaceholders(header.text, ensureStringArray(data.headerVariables)).slice(
      0,
      280
    );
  }

  if (normalizedTemplate.category === "authentication") {
    const code = toTrimmedString(data.otpCode);
    return code ? `Authentication code: ${code}` : "Authentication template";
  }

  return normalizedTemplate.name || "Template message";
}

module.exports = {
  maxPlaceholderIndex,
  hasDynamicUrl,
  normalizeTemplate,
  validateBeforeSend,
  buildComponentsFromTemplate,
  renderTemplatePreview,
};
