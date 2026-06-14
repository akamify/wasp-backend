const mediaAssetService = require("@modules/media/services/mediaAsset.service");

async function upload(req, res) {
  const result = await mediaAssetService.uploadMediaAsset({
    workspaceId: req.workspace.id,
    uploadedBy: req.user?.id || null,
    mediaType: req.body?.mediaType,
    file: req.file,
  });
  res.status(201).json(result.asset);
}

async function list(req, res) {
  res.json(
    await mediaAssetService.listMediaAssets({
      workspaceId: req.workspace.id,
      mediaType: req.query.type,
    })
  );
}

async function remove(req, res) {
  res.json(
    await mediaAssetService.deleteMediaAsset({
      workspaceId: req.workspace.id,
      mediaAssetId: req.params.id,
    })
  );
}

module.exports = { list, remove, upload };
