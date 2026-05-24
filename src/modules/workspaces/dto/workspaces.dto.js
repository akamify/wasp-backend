function mapWorkspaceListItem(workspace) {
  return {
    id: String(workspace._id),
    name: workspace.name,
    plan: workspace.plan,
    createdAt: workspace.createdAt,
  };
}

function mapWorkspaceCreated(workspace) {
  return {
    id: String(workspace._id),
    name: workspace.name,
    plan: workspace.plan,
  };
}

module.exports = {
  mapWorkspaceListItem,
  mapWorkspaceCreated,
};

