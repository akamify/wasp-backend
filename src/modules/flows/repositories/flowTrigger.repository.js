const { Flow } = require("@infra/database/Flow");

async function findActiveFlowVersions({ workspaceId }) {
  return Flow.find({
    workspaceId,
    status: "active",
    deletedAt: null,
    activeVersionId: { $ne: null },
  })
    .select("_id name activeVersionId")
    .populate({
      path: "activeVersionId",
      match: { workspaceId, status: "active" },
      select:
        "workspaceId flowId status trigger nodes edges fallbackNodeId handoverNodeId",
    })
    .sort({ updatedAt: -1, _id: -1 })
    .lean();
}

module.exports = {
  findActiveFlowVersions,
};
