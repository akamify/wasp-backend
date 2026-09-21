const service = require("../services/catalog.service");
const schemas = require("../validators/catalog.validators");
const { productDto } = require("../domain/catalog");
const { HttpError } = require("@shared/utils/httpError");
const { writeAuditLog } = require("@shared/services/auditLog.service");
const { uploadMediaAsset } = require("@modules/media/services/mediaAsset.service");
const Joi = require("joi");
const setup = require("../services/catalogSetup.service");
async function catalogSetupStatus(req, res) { res.json({ success: true, ...await setup.status(workspace(req)) }); }
async function createCatalog(req, res) {
  const catalog = await setup.create(workspace(req), body(schemas.catalogCreate, req));
  await audit(req, "commerce_catalog_created_and_connected", catalog);
  res.status(201).json({ success: true, catalog });
}

const workspace = (req) => req.workspace.id;
const id = (req) => schemas.parse(schemas.objectId.required(), req.params.productId);
const body = (schema, req) => schemas.parse(schema, req.body || {});
async function audit(req, action, result) {
  await writeAuditLog(req, { action, resourceType: "commerce_catalog", resourceId: result?.id,
    metadata: { workspaceId: workspace(req), revision: result?.revision } });
}
async function listCatalogs(req, res) {
  const query = schemas.parse(Joi.object({ cursor: Joi.string().max(2048) }), req.query, true);
  res.json({ success: true, ...await service.listCatalogs(workspace(req), query.cursor) });
}
async function getCatalog(req, res) { res.json({ success: true, catalog: await service.getCatalog(workspace(req)) }); }
async function bindCatalog(req, res) {
  const catalog = await service.bindCatalog(workspace(req), body(schemas.catalogBind, req));
  await audit(req, "commerce_catalog_connected", catalog);
  res.json({ success: true, catalog });
}
function changeCatalog(action) {
  return async (req, res) => {
    const input = body(action === "settings" ? schemas.commerceSettings : schemas.revisionBody, req);
    const catalog = await service.changeCatalog(workspace(req), input, action);
    await audit(req, `commerce_catalog_${action}`, catalog);
    res.json({ success: true, catalog });
  };
}
async function listProducts(req, res) {
  const query = schemas.parse(schemas.listQuery, req.query, true);
  res.json({ success: true, ...await service.listProducts(workspace(req), query) });
}
async function getProduct(req, res) {
  const { product } = await service.getProduct(workspace(req), id(req));
  res.json({ success: true, product: productDto(product) });
}
async function createProduct(req, res) {
  const product = await service.createProduct(workspace(req), body(schemas.createProduct, req));
  await audit(req, "commerce_product_created", product);
  res.status(201).json({ success: true, product });
}
function editProduct(archive = false) {
  return async (req, res) => {
    const input = body(archive ? schemas.revisionBody : schemas.updateProduct, req);
    const product = await service.editProduct(workspace(req), id(req), input, archive);
    await audit(req, archive ? "commerce_product_archived" : "commerce_product_updated", product);
    res.json({ success: true, product });
  };
}
async function retryProduct(req, res) {
  const product = await service.retryProduct(workspace(req), id(req), body(schemas.revisionBody, req));
  res.status(202).json({ success: true, product });
}
async function uploadImage(req, res) {
  try {
    const result = await uploadMediaAsset({ workspaceId: workspace(req), uploadedBy: req.user.id,
      mediaType: "image", displayName: req.file?.originalname, file: req.file });
    res.status(201).json({ success: true, asset: result.asset });
  } catch (error) {
    if (error.statusCode && error.statusCode < 500) throw error;
    throw new HttpError(502, "Product image upload failed. Retry shortly.");
  }
}
module.exports = { catalogSetupStatus, createCatalog, listCatalogs, getCatalog, bindCatalog, changeCatalog, listProducts, getProduct,
  createProduct, editProduct, retryProduct, uploadImage };
