const { Template } = require("@infra/database/Template");

function getTemplateById({ id, workspaceId, select }) {
    return Template.findOne({ _id: id, workspaceId }).select(select || undefined);
}

module.exports = { getTemplateById };
