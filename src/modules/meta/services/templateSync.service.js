const templatesService = require("@modules/templates/services/templates.service");

async function syncTemplatesForWorkspace({ workspace, connection }) {
  await templatesService.syncMetaTemplates({ workspace, body: {}, metaConnectionOverride: connection || null });
}

module.exports = { syncTemplatesForWorkspace };
