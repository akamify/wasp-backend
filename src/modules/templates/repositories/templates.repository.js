const { Template } = require("@infra/database/Template");

async function createTemplate(data) {
  return Template.create(data);
}

async function listTemplates(filter) {
  return Template.find(filter).sort({ createdAt: -1 });
}

async function getTemplate({ id, workspaceId }) {
  return Template.findOne({ _id: id, workspaceId });
}

async function deleteTemplate({ id, workspaceId }) {
  return Template.deleteOne({ _id: id, workspaceId });
}

async function findTemplateForMetaSync({ workspaceId, name, metaTemplateId }) {
  return Template.findOne({
    workspaceId,
    $or: [...(metaTemplateId ? [{ metaTemplateId }] : []), { name }],
  });
}

async function countTemplatesCreatedBetween({ workspaceId, start, end }) {
  return Template.countDocuments({
    workspaceId,
    createdAt: { $gte: start, $lt: end },
  });
}

module.exports = {
  createTemplate,
  listTemplates,
  getTemplate,
  deleteTemplate,
  findTemplateForMetaSync,
  countTemplatesCreatedBetween,
};
