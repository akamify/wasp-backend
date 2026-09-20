const COMMERCE_PERMISSIONS = Object.freeze([
  "commerce.catalog.view", "commerce.catalog.manage", "commerce.products.view", "commerce.products.manage",
  "commerce.orders.view", "commerce.orders.manage", "commerce.payments.view", "commerce.payments.manage",
  "commerce.messages.send", "commerce.gateway.manage",
]);
const COMMERCE_READ_PERMISSIONS = COMMERCE_PERMISSIONS.filter((key) => key.endsWith(".view"));
const COMMERCE_MANAGER_PERMISSIONS = COMMERCE_PERMISSIONS.filter((key) => !["commerce.gateway.manage", "commerce.payments.manage"].includes(key));
const COMMERCE_AGENT_PERMISSIONS = ["commerce.catalog.view", "commerce.products.view", "commerce.orders.view", "commerce.messages.send"];
module.exports = { COMMERCE_PERMISSIONS, COMMERCE_READ_PERMISSIONS, COMMERCE_MANAGER_PERMISSIONS, COMMERCE_AGENT_PERMISSIONS };
