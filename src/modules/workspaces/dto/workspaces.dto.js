function mapWorkspaceListItem(workspace) {
  return {
    id: String(workspace._id),
    name: workspace.name,
    slug: workspace.slug || null,
    businessName: workspace.businessName || null,
    plan: workspace.plan,
    status: workspace.status || "active",
    defaultCurrency: workspace.defaultCurrency || "INR",
    timezone: workspace.timezone || "Asia/Calcutta",
    industry: workspace.industry || null,
    allowedApiPermissions: {
      campaignSend: Boolean(workspace?.allowedApiPermissions?.campaignSend),
      chatAccess: Boolean(workspace?.allowedApiPermissions?.chatAccess),
    },
    createdAt: workspace.createdAt,
  };
}

function mapWorkspaceCreated(workspace) {
  return {
    id: String(workspace._id),
    name: workspace.name,
    slug: workspace.slug || null,
    businessName: workspace.businessName || null,
    plan: workspace.plan,
  };
}

module.exports = {
  mapWorkspaceListItem,
  mapWorkspaceCreated,
};

