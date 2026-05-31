require("module-alias/register");
require("@core/config/loadEnv").loadEnv();

const mongoose = require("mongoose");
const { mongoUri } = require("@core/config/env");
const { WhatsAppCredentials } = require("@infra/database/WhatsAppCredentials");
const { Template } = require("@infra/database/Template");
const { decryptString } = require("@shared/utils/crypto");

async function main() {
  await mongoose.connect(mongoUri);
  const workspaces = await Template.distinct("workspaceId");
  let staleOldWaba = 0;
  let staleMissingWaba = 0;

  for (const workspaceId of workspaces) {
    const active = await WhatsAppCredentials.findOne({
      workspaceId,
      isActive: { $ne: false },
      isValid: true,
    }).select("+businessAccountIdEnc wabaId businessAccountIdPlain");
    if (!active) continue;

    const activeWabaId = String(active.wabaId || active.businessAccountIdPlain || decryptString(active.businessAccountIdEnc) || "").trim();
    if (!activeWabaId) continue;

    const missing = await Template.updateMany(
      { workspaceId, $or: [{ wabaId: null }, { wabaId: "" }, { wabaId: { $exists: false } }] },
      { $set: { isActive: false, staleReason: "missing_waba_id" } }
    );
    staleMissingWaba += Number(missing.modifiedCount || 0);

    const old = await Template.updateMany(
      { workspaceId, wabaId: { $nin: [null, "", activeWabaId] } },
      { $set: { isActive: false, staleReason: "old_waba_connection" } }
    );
    staleOldWaba += Number(old.modifiedCount || 0);
  }

  console.log({ staleOldWaba, staleMissingWaba });
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
