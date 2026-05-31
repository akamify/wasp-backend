const { Template } = require("@infra/database/Template");

async function createTemplate(data) {
  return Template.create(data);
}

async function listTemplates(filter) {
  return Template.find(filter).sort({ createdAt: -1 });
}

async function getTemplate({ id, workspaceId, wabaId }) {
  return Template.findOne({ _id: id, workspaceId, ...(wabaId ? { wabaId } : {}) });
}

async function deleteTemplate({ id, workspaceId, wabaId }) {
  return Template.deleteOne({ _id: id, workspaceId, ...(wabaId ? { wabaId } : {}) });
}

async function findTemplateForMetaSync({ workspaceId, wabaId, name, metaTemplateId }) {
  return Template.findOne({
    workspaceId,
    $or: [
      { wabaId, ...(metaTemplateId ? { metaTemplateId } : { name }) },
      { wabaId, name },
      { wabaId: null, ...(metaTemplateId ? { metaTemplateId } : { name }) },
      { wabaId: null, name },
      { name },
    ],
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
