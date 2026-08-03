const { AiAgent } = require("@infra/database/AiAgent");

function list({ workspaceId, filter, skip, limit }) {
  return AiAgent.find({ workspaceId, deletedAt: null, ...filter })
    .sort({ updatedAt: -1, _id: -1 })
    .skip(skip)
    .limit(limit)
    .lean();
}

function count({ workspaceId, filter }) {
  return AiAgent.countDocuments({ workspaceId, deletedAt: null, ...filter });
}

function findById({ workspaceId, agentId }) {
  return AiAgent.findOne({ _id: agentId, workspaceId, deletedAt: null });
}

function findBySlug({ workspaceId, slug }) {
  return AiAgent.findOne({ workspaceId, slug, deletedAt: null });
}

function create(payload) {
  return AiAgent.create(payload);
}

function update({ workspaceId, agentId, updates, pushes = {}, unsets = {} }) {
  const patch = {};
  if (updates && Object.keys(updates).length) patch.$set = updates;
  if (pushes && Object.keys(pushes).length) patch.$push = pushes;
  if (unsets && Object.keys(unsets).length) patch.$unset = unsets;
  return AiAgent.findOneAndUpdate(
    { _id: agentId, workspaceId, deletedAt: null },
    patch,
    { returnDocument: "after", runValidators: true },
  );
}

function softDelete({ workspaceId, agentId, actorId, now }) {
  return AiAgent.findOneAndUpdate(
    { _id: agentId, workspaceId, deletedAt: null },
    {
      $set: {
        status: "archived",
        archivedAt: now,
        deletedAt: now,
        updatedBy: actorId || null,
      },
    },
    { returnDocument: "after", runValidators: true },
  );
}

module.exports = {
  list,
  count,
  findById,
  findBySlug,
  create,
  update,
  softDelete,
};
