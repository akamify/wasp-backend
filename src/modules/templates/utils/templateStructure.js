const { HttpError } = require("@shared/utils/httpError");

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

function placeholderIndexes(text) {
  const indexes = new Set();
  for (const match of String(text || "").matchAll(/\{\{(\d+)\}\}/g)) {
    const index = Number(match[1]);
    if (Number.isFinite(index) && index > 0) indexes.add(index);
  }
  return Array.from(indexes).sort((a, b) => a - b);
}

function assertSequentialPlaceholders(text, label) {
  const indexes = placeholderIndexes(text);
  for (let i = 0; i < indexes.length; i += 1) {
    const expected = i + 1;
    if (indexes[i] !== expected) {
      throw new HttpError(
        400,
        `${label} variables must be sequential and start from {{1}}. Use {{1}}, {{2}}, {{3}} inside ${label}; header/body/button numbering is separate.`
      );
    }
  }
}

function hasDynamicUrl(url) {
  return /\{\{\d+\}\}/.test(String(url || ""));
}

function dynamicUrlPrefix(url) {
  const source = String(url || "");
  const marker = source.indexOf("{{");
  if (marker <= 0) return "";
  return source.slice(0, marker);
}

function normalizeDynamicUrlRuntimeValue(templateUrl, runtimeValue) {
  const raw = toTrimmedString(runtimeValue);
  if (!raw) return "";

  const prefix = dynamicUrlPrefix(templateUrl);
  if (!prefix) return raw;

  if (!/^https?:\/\//i.test(raw)) return raw;

  // If user pasted a full URL that starts with the template URL prefix,
  // convert it to suffix automatically.
  if (raw.toLowerCase().startsWith(prefix.toLowerCase())) {
    return raw.slice(prefix.length);
  }

  return raw;
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

function normalizeAuthSupportedApps(button) {
  const supportedApps = Array.isArray(button?.supported_apps)
    ? button.supported_apps
    : toTrimmedString(button?.package_name || button?.packageName) || toTrimmedString(button?.signature_hash || button?.signatureHash)
      ? [
          {
            package_name: button?.package_name || button?.packageName,
            signature_hash: button?.signature_hash || button?.signatureHash,
          },
        ]
      : [];

  return supportedApps
    .map((app) => ({
      package_name: toTrimmedString(app?.package_name || app?.packageName),
      signature_hash: toTrimmedString(app?.signature_hash || app?.signatureHash),
    }))
    .filter((app) => app.package_name || app.signature_hash);
}

function normalizeButton(button, category) {
  const type = toUpper(button?.type);

  if (type === "URL") {
    const text = toTrimmedString(button?.text);
    const url = toTrimmedString(button?.url);
    const example = Array.isArray(button?.example) ? button.example : null;

    invariant(text, "URL button text is required");
    invariant(url, "URL button URL is required");

    const dynamic = /\{\{\d+\}\}/.test(url);
    if (dynamic) {
      const sample = toTrimmedString(example?.[0] || "");
      invariant(sample, "URL button sample is required for dynamic URLs");
      invariant(/^https:\/\//i.test(sample), "URL button sample must start with https://");
      // require a basic domain + tld (.co, .in, .co.in, etc.)
      let host = "";
      try {
        host = new URL(sample).hostname || "";
      } catch {
        host = "";
      }
      invariant(host && host.includes("."), "URL button sample must be a valid URL");
    }

    return {
      type: "URL",
      text,
      url,
      ...(dynamic && example ? { example } : {}),
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

  if (type === "VOICE_CALL") {
    const text = toTrimmedString(button?.text);
    invariant(text, "Call on WhatsApp button text is required");

    return {
      type: "VOICE_CALL",
      text,
    };
  }

  if (type === "FLOW") {
    const text = toTrimmedString(button?.text);
    const flowId = toTrimmedString(button?.flow_id || button?.flowId || button?.flow_id);
    const icon = toUpper(button?.icon || button?.flow_icon || "DEFAULT");
    invariant(text, "Flow button text is required");
    invariant(flowId, "Flow button flow_id is required");
    invariant(["DEFAULT", "DOCUMENT", "PROMOTION", "REVIEW"].includes(icon), "Invalid flow button icon");

    return {
      type: "FLOW",
      text,
      flow_id: flowId,
      icon,
    };
  }

  if (type === "COPY_CODE") {
    invariant(category === "marketing", "Copy Offer Code is supported only for marketing templates");

    const text = toTrimmedString(button?.text);
    invariant(text, "Copy offer code button text is required");

    return {
      type: "COPY_CODE",
      text,
    };
  }

  if ((type === "OTP" || button?.otp_type || button?.otpType) && category === "authentication") {
    const otpType = toUpper(button?.otp_type || button?.otpType || "COPY_CODE");
    invariant(["COPY_CODE", "ONE_TAP", "ZERO_TAP"].includes(otpType), "Invalid authentication otp_type");
    const supportedApps = normalizeAuthSupportedApps(button);

    if (otpType !== "COPY_CODE") {
      invariant(supportedApps.length > 0, "At least one supported app is required for autofill authentication");
      invariant(supportedApps.length <= 5, "Authentication templates support at most 5 apps");
    }
    supportedApps.forEach((app, index) => {
      invariant(app.package_name, `Package name is required for app ${index + 1}`);
      invariant(app.signature_hash, `Signature hash is required for app ${index + 1}`);
      invariant(app.signature_hash.length === 11, `Signature hash must be 11 characters for app ${index + 1}`);
    });
    if (otpType === "ZERO_TAP") {
      invariant(button?.zero_tap_terms_accepted !== false, "Zero-tap terms must be accepted");
    }
    const primaryApp = supportedApps[0];

    return {
      type: "OTP",
      otp_type: otpType,
      text: toTrimmedString(button?.text) || "Copy code",
      ...(otpType !== "COPY_CODE" ? { autofill_text: toTrimmedString(button?.autofill_text || button?.autofillText) || "Autofill" } : {}),
      ...(primaryApp ? { package_name: primaryApp.package_name, signature_hash: primaryApp.signature_hash } : {}),
      ...(supportedApps.length > 0 ? { supported_apps: supportedApps } : {}),
      ...(otpType === "ZERO_TAP" ? { zero_tap_terms_accepted: true } : {}),
    };
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
      assertSequentialPlaceholders(text, "BODY");
      hasBody = true;
      normalized.push({
        type: "BODY",
        text,
        ...(component?.example ? { example: component.example } : {}),
      });
      continue;
    }

    if (type === "HEADER") {
      const format = toUpper(component?.format || (component?.text ? "TEXT" : ""));

      if (format === "TEXT") {
        const text = String(component?.text ?? "");
        invariant(text.trim(), "HEADER text is required");
        // Meta restriction: header supports at most 1 variable placeholder.
        invariant(maxPlaceholderIndex(text) <= 1, "HEADER supports at most 1 variable placeholder");
        assertSequentialPlaceholders(text, "HEADER");
        normalized.push({
          type: "HEADER",
          format: "TEXT",
          text,
          ...(component?.example ? { example: component.example } : {}),
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
  if (buttonComponent?.buttons?.length > 10) {
    throw new HttpError(400, "Templates support at most 10 buttons");
  }
  if (buttonComponent?.buttons?.length) {
    const counts = new Map();
    for (const button of buttonComponent.buttons) {
      const t = toUpper(button?.type);
      counts.set(t, (counts.get(t) || 0) + 1);
    }

    if ((counts.get("URL") || 0) > 2) throw new HttpError(400, "Visit Website buttons support at most 2");
    if ((counts.get("QUICK_REPLY") || 0) > 10) throw new HttpError(400, "Quick Reply buttons support at most 10");

    const singleTypes = ["FLOW", "VOICE_CALL", "PHONE_NUMBER", "COPY_CODE"];
    for (const t of singleTypes) {
      if ((counts.get(t) || 0) > 1) throw new HttpError(400, `${t} button supports at most 1`);
    }
  }

  return normalized;
}

function normalizeAuthenticationComponents(components) {
  const bodyComponent = ensureArray(components).find(
    (component) => toUpper(component?.type) === "BODY"
  );
  const footerComponent = ensureArray(components).find(
    (component) => toUpper(component?.type) === "FOOTER"
  );
  const buttonsComponent = ensureArray(components).find(
    (component) => toUpper(component?.type) === "BUTTONS"
  );

  const addSecurity = normalizeAuthSecurityRecommendation(components);
  const otpButton = ensureArray(buttonsComponent?.buttons)[0];
  const hasExpiration =
    Object.prototype.hasOwnProperty.call(footerComponent || {}, "code_expiration_minutes") ||
    Object.prototype.hasOwnProperty.call(footerComponent || {}, "codeExpirationMinutes");
  const expires = hasExpiration
    ? Number(footerComponent?.code_expiration_minutes ?? footerComponent?.codeExpirationMinutes)
    : null;
  if (hasExpiration) {
    invariant(Number.isFinite(expires) && expires >= 1 && expires <= 90, "code_expiration_minutes must be between 1 and 90");
  }

  return [
    {
      type: "BODY",
      add_security_recommendation:
        typeof bodyComponent?.add_security_recommendation === "boolean"
          ? bodyComponent.add_security_recommendation
          : addSecurity,
    },
    ...(hasExpiration
      ? [
          {
            type: "FOOTER",
            code_expiration_minutes: expires,
          },
        ]
      : []),
    {
      type: "BUTTONS",
      buttons: [otpButton ? normalizeButton(otpButton, "authentication") : { ...AUTH_OTP_BUTTON }],
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
  const buttonTtlMinutes = ensureArray(data.buttonTtlMinutes);
  const flowTokens = ensureStringArray(data.flowTokens);
  const flowActionData = ensureArray(data.flowActionData);

  for (const component of ensureArray(template?.components)) {
    const compType = toUpper(component?.type);
    const headerFormat = toUpper(component?.format);

    if (compType === "HEADER" && headerFormat === "TEXT") {
      const requiredVariables = maxPlaceholderIndex(component?.text);
      invariant(
        headerVariables.length >= requiredVariables,
        requiredVariables === 1
          ? "1 header variable is required"
          : `${requiredVariables} header variables are required`
      );
    }

    if (compType === "HEADER" && (headerFormat === "IMAGE" || headerFormat === "VIDEO" || headerFormat === "DOCUMENT")) {
      invariant(
        toTrimmedString(headerVariables[0]),
        "Header media is required (provide a media URL or media ID)"
      );
    }

    if (compType === "BODY") {
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
          const normalizedRuntimeValue = normalizeDynamicUrlRuntimeValue(button?.url, runtimeValue);
          invariant(normalizedRuntimeValue, `Dynamic URL value required for button ${index + 1}`);
          const prefix = dynamicUrlPrefix(button?.url);
          if (/^https?:\/\//i.test(normalizedRuntimeValue) && prefix) {
            invariant(
              false,
              `Dynamic URL value for button ${index + 1} must be only the variable part (do not send full URL)`
            );
          }
        }

        if (buttonType === "VOICE_CALL") {
          const ttlRaw = buttonTtlMinutes[index] ?? runtimeValue ?? "";
          const ttl = Number(ttlRaw);
          invariant(
            Number.isFinite(ttl) && ttl >= 1 && ttl <= 43200,
            `Voice call validity (ttl_minutes) must be between 1 and 43200 for button ${index + 1}`
          );
        }

        if (buttonType === "FLOW") {
          const token = toTrimmedString(flowTokens[index] ?? "");
          const action = flowActionData[index];
          if (token) {
            // token is optional, but if present it must be non-empty string already trimmed.
            invariant(token.length <= 512, `Flow token too long for button ${index + 1}`);
          }
          if (action !== undefined && action !== null && typeof action !== "object") {
            invariant(false, `Flow action data must be an object for button ${index + 1}`);
          }
        }

        if (buttonType === "COPY_CODE") {
          invariant(runtimeValue, `Offer code required for button ${index + 1}`);
        }
      });
    }
  }
}

function buildButtonComponent(button, index, data) {
  const buttonType = toUpper(button?.type);
  const buttonValues = ensureStringArray(data.buttonValues);
  const buttonTtlMinutes = ensureArray(data.buttonTtlMinutes);
  const flowTokens = ensureStringArray(data.flowTokens);
  const flowActionData = ensureArray(data.flowActionData);
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
    const normalizedRuntimeValue = normalizeDynamicUrlRuntimeValue(button?.url, runtimeValue);
    const encodedRuntimeValue = encodeURIComponent(normalizedRuntimeValue);
    return {
      type: "button",
      sub_type: "url",
      index: String(index),
      parameters: [
        {
          type: "text",
          text: encodedRuntimeValue,
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

  if (buttonType === "VOICE_CALL") {
    const ttlRaw = buttonTtlMinutes[index] ?? runtimeValue ?? "";
    const ttl = Number(ttlRaw);
    if (!Number.isFinite(ttl) || ttl < 1 || ttl > 43200) return null;

    return {
      type: "button",
      sub_type: "voice_call",
      index: String(index),
      parameters: [
        {
          type: "ttl_minutes",
          ttl_minutes: ttl,
        },
      ],
    };
  }

  if (buttonType === "FLOW") {
    const token = toTrimmedString(flowTokens[index] ?? "");
    const action = flowActionData[index];

    const actionPayload = {};
    if (token) actionPayload.flow_token = token;
    if (action && typeof action === "object") actionPayload.flow_action_data = action;

    return {
      type: "button",
      sub_type: "flow",
      index: String(index),
      parameters: [
        {
          type: "action",
          ...(Object.keys(actionPayload).length > 0 ? { action: actionPayload } : {}),
        },
      ],
    };
  }

  if (buttonType === "COPY_CODE" && runtimeValue) {
    return {
      type: "button",
      sub_type: "copy_code",
      index: String(index),
      parameters: [
        {
          type: "coupon_code",
          coupon_code: runtimeValue,
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
    const compType = toUpper(component?.type);
    const headerFormat = toUpper(component?.format);

    if (compType === "HEADER" && headerFormat === "TEXT") {
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

    if (compType === "HEADER" && (headerFormat === "IMAGE" || headerFormat === "VIDEO" || headerFormat === "DOCUMENT")) {
      const value = toTrimmedString(headerVariables[0]);
      if (value) {
        const isLink = /^https?:\/\//i.test(value);
        const kind = headerFormat.toLowerCase();
        components.push({
          type: "header",
          parameters: [
            {
              type: kind,
              [kind]: isLink ? { link: value } : { id: value },
            },
          ],
        });
      }
    }

    if (compType === "BODY") {
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

function renderTemplatePreviewParts(template, data = {}) {
  const normalizedTemplate = normalizeTemplate(template);

  const header = ensureArray(normalizedTemplate.components).find(
    (component) =>
      toUpper(component?.type) === "HEADER" &&
      toUpper(component?.format) === "TEXT" &&
      typeof component?.text === "string"
  );
  const body = ensureArray(normalizedTemplate.components).find(
    (component) => toUpper(component?.type) === "BODY" && typeof component?.text === "string"
  );
  const footer = ensureArray(normalizedTemplate.components).find(
    (component) => toUpper(component?.type) === "FOOTER" && typeof component?.text === "string"
  );

  const headerText = header?.text
    ? replacePlaceholders(header.text, ensureStringArray(data.headerVariables)).slice(0, 300)
    : "";

  let bodyText = "";
  if (body?.text) {
    bodyText = replacePlaceholders(body.text, ensureStringArray(data.variables)).slice(0, 4096);
  } else if (normalizedTemplate.category === "authentication") {
    const code = toTrimmedString(data.otpCode);
    bodyText = code ? `Authentication code: ${code}` : "Authentication template";
  } else {
    bodyText = normalizedTemplate.name || "Template message";
  }

  const footerText = footer?.text ? footer.text.slice(0, 300) : "";

  return { header: headerText, body: bodyText, footer: footerText };
}

module.exports = {
  maxPlaceholderIndex,
  hasDynamicUrl,
  normalizeTemplate,
  validateBeforeSend,
  buildComponentsFromTemplate,
  renderTemplatePreview,
  renderTemplatePreviewParts,
};
