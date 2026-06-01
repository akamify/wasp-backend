require("../src/core/startup/registerAliases");
const mongoose = require("mongoose");
const { mongoUri } = require("@core/config/env");
const { Contact } = require("@infra/database/Contact");
const { Conversation } = require("@infra/database/Conversation");
const { Message } = require("@infra/database/Message");
const { Campaign } = require("@infra/database/Campaign");

async function main() {
  await mongoose.connect(mongoUri);
  for (const model of [Contact, Conversation, Message, Campaign]) {
    const dropped = await model.syncIndexes();
    console.log(`[waba-indexes] ${model.modelName} synced`, { dropped });
  }
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error("[waba-indexes] sync failed", err?.message || err);
  await mongoose.disconnect().catch(() => {});
  process.exitCode = 1;
});
