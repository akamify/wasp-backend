function uniqueStrings(input) {
  if (!Array.isArray(input)) return [];
  return Array.from(new Set(input.map((x) => String(x || "").trim()).filter(Boolean)));
}

function normalizeAdminPermissions(role, permissions) {
  const pages = uniqueStrings(permissions?.pages);
  const components = uniqueStrings(permissions?.components);
  const actions = uniqueStrings(permissions?.actions);

  if (String(role || "") !== "admin") return { pages, components, actions };

  const hasAny = pages.length || components.length || actions.length;
  if (hasAny) return { pages, components, actions };

  return {
    pages: ["/admin/dashboard", "/admin/profile"],
    components: ["dashboard.view", "profile.view", "profile.edit", "profile.sessions"],
    actions: ["profile.manage"],
  };
}

module.exports = { normalizeAdminPermissions };

