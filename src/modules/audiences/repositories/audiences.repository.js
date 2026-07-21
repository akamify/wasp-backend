const { Audience } = require("@infra/database/Audience");

function listAudiences({ workspaceId, wabaId }) {
  return Audience.find({ workspaceId, wabaId }).sort({ updatedAt: -1, createdAt: -1 });
}

function getAudience({ id, workspaceId, wabaId }) {
  return Audience.findOne({ _id: id, workspaceId, wabaId });
}

function getAudienceLean({ id, workspaceId, wabaId }) {
  return Audience.findOne({ _id: id, workspaceId, wabaId }).lean();
}

function createAudience(payload) {
  return Audience.create(payload);
}

function deleteAudience({ id, workspaceId, wabaId }) {
  return Audience.deleteOne({ _id: id, workspaceId, wabaId });
}

module.exports = {
  listAudiences,
  getAudience,
  getAudienceLean,
  createAudience,
  deleteAudience,
};
