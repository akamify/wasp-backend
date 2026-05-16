function mapPlanSummaryItem(i) {
  return { plan: i._id || "unknown", count: i.count };
}

function mapWorkspaceSubscriptionItem(workspace, owner) {
  return {
    id: String(workspace._id),
    name: workspace.name,
    plan: workspace.plan,
    isActive: workspace.isActive,
    createdAt: workspace.createdAt,
    owner: owner ? { id: String(owner._id), email: owner.email, name: owner.name || "" } : null,
  };
}

module.exports = { mapPlanSummaryItem, mapWorkspaceSubscriptionItem };

