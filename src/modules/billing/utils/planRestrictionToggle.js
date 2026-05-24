function isPlanRestrictionsEnabled() {
  const raw = String(process.env.BILLING_PLAN_RESTRICTIONS_ENABLED ?? "true").trim().toLowerCase();
  return !(raw === "false" || raw === "0" || raw === "off" || raw === "no");
}

module.exports = {
  isPlanRestrictionsEnabled,
};
