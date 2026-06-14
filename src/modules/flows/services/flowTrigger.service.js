const flowTriggerRepository = require("@modules/flows/repositories/flowTrigger.repository");

function normalizeComparable(value) {
  return String(value || "").trim().toLowerCase();
}

function isSafeRegexPattern(pattern) {
  const value = String(pattern || "");
  if (!value || value.length > 200) return false;

  // Reject common nested-quantifier shapes that can cause catastrophic backtracking.
  return !/(\([^)]*[+*][^)]*\)|\[[^\]]+\][+*])[+*{]/.test(value);
}

function matchesKeywordTrigger(trigger, inboundMessage) {
  if (inboundMessage?.type !== "text") return false;
  const incomingText = normalizeComparable(inboundMessage.text);
  if (!incomingText) return false;

  const keywords = Array.isArray(trigger?.keywords) ? trigger.keywords : [];
  if (trigger.matchMode === "exact") {
    return keywords.some(
      (keyword) => incomingText === normalizeComparable(keyword)
    );
  }
  if (trigger.matchMode === "contains") {
    return keywords.some((keyword) => {
      const normalizedKeyword = normalizeComparable(keyword);
      return normalizedKeyword && incomingText.includes(normalizedKeyword);
    });
  }
  if (trigger.matchMode === "regex") {
    return keywords.some((keyword) => {
      const pattern = String(keyword || "").trim();
      if (!isSafeRegexPattern(pattern)) return false;
      try {
        return new RegExp(pattern, "i").test(
          String(inboundMessage.text || "").slice(0, 4096)
        );
      } catch {
        return false;
      }
    });
  }
  return false;
}

function matchesTemplateButtonTrigger(trigger, inboundMessage) {
  if (inboundMessage?.type !== "button_reply") return false;
  const replyId = String(inboundMessage?.buttonReply?.id || "").trim();
  if (!replyId) return false;
  return (trigger?.templateButtonPayloads || []).some(
    (payload) => String(payload || "").trim() === replyId
  );
}

function getCtwaPayloadCandidates(inboundMessage) {
  const referral = inboundMessage?.rawPayload?.referral;
  if (!referral || typeof referral !== "object") return [];
  return [
    referral.source_id,
    referral.source_url,
    referral.ctwa_clid,
    referral.headline,
    referral.body,
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
}

function matchesCtwaTrigger(trigger, inboundMessage) {
  const candidates = new Set(getCtwaPayloadCandidates(inboundMessage));
  if (!candidates.size) return false;
  return (trigger?.ctwaPayloads || []).some((payload) =>
    candidates.has(String(payload || "").trim())
  );
}

function matchesTrigger(trigger, inboundMessage) {
  if (!trigger || trigger.type === "manual") return false;
  if (trigger.type === "keyword") {
    return matchesKeywordTrigger(trigger, inboundMessage);
  }
  if (trigger.type === "template_button") {
    return matchesTemplateButtonTrigger(trigger, inboundMessage);
  }
  if (trigger.type === "ctwa") {
    return matchesCtwaTrigger(trigger, inboundMessage);
  }
  return false;
}

async function findMatchingFlowVersion({ workspaceId, inboundMessage }) {
  const flows = await flowTriggerRepository.findActiveFlowVersions({
    workspaceId,
  });

  for (const flow of flows) {
    const version = flow.activeVersionId;
    if (!version || String(version.flowId) !== String(flow._id)) continue;
    if (matchesTrigger(version.trigger, inboundMessage)) {
      return { flow, version };
    }
  }
  return null;
}

module.exports = {
  findMatchingFlowVersion,
};
