const templatesMediaService = require("@modules/templates/services/templatesMedia.service");

async function uploadTemplateMedia(req, res) {
  res.json(await templatesMediaService.uploadTemplateMedia(req));
}

async function downloadTemplateMediaByHandle(req, res) {
  const result = await templatesMediaService.downloadTemplateMediaByHandle(req);
  Object.entries(result.headers || {}).forEach(([k, v]) => res.set(k, v));
  return res.status(200).send(result.buffer);
}

module.exports = { uploadTemplateMedia, downloadTemplateMediaByHandle };
