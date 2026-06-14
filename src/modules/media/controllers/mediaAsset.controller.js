const mediaAssetService = require("@modules/media/services/mediaAsset.service");

async function upload(req, res) {
  const result = await mediaAssetService.uploadMediaAsset({
    workspaceId: req.workspace.id,
    uploadedBy: req.user?.id || null,
    mediaType: req.body?.mediaType,
    displayName: req.body?.displayName,
    file: req.file,
  });
  res.status(201).json(result);
}

async function list(req, res) {
  res.json(
    await mediaAssetService.listMediaAssets({
      workspaceId: req.workspace.id,
      mediaType: req.query.mediaType || req.query.type,
      search: req.query.search,
      page: req.query.page,
      limit: req.query.limit,
    })
  );
}

async function get(req, res) {
  res.json(
    await mediaAssetService.getMediaAsset({
      workspaceId: req.workspace.id,
      mediaAssetId: req.params.id,
    })
  );
}

async function update(req, res) {
  res.json(
    await mediaAssetService.updateMediaAsset({
      workspaceId: req.workspace.id,
      mediaAssetId: req.params.id,
      displayName: req.body.displayName,
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

module.exports = { get, list, remove, update, upload };
