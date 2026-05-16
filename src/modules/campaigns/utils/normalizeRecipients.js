const { assertNormalizedPhone } = require("@shared/services/contactService");

function normalizeRecipients(recipients) {
    const normalized = [];
    const seen = new Set();

    for (const r of recipients || []) {
        const raw = typeof r === "string" ? { to: r } : r || {};
        const to = assertNormalizedPhone(raw.to);
        if (!to) continue;
        if (seen.has(to)) continue;
        seen.add(to);
        normalized.push({
            to,
            variables: Array.isArray(raw.variables) ? raw.variables : undefined,
            headerVariables: Array.isArray(raw.headerVariables) ? raw.headerVariables : undefined,
            otpCode: raw.otpCode ? String(raw.otpCode) : undefined,
            buttonValues: Array.isArray(raw.buttonValues) ? raw.buttonValues : undefined,
            buttonTtlMinutes: Array.isArray(raw.buttonTtlMinutes) ? raw.buttonTtlMinutes : undefined,
            flowTokens: Array.isArray(raw.flowTokens) ? raw.flowTokens : undefined,
            flowActionData: Array.isArray(raw.flowActionData) ? raw.flowActionData : undefined,
        });
    }

    return normalized;
}

module.exports = { normalizeRecipients };

