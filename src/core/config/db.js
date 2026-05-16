const mongoose = require("mongoose");

const staleIndexesByCollection = {
  contacts: ["userId_1_phone_1"],
  conversations: ["userId_1_phone_1"],
  templates: ["userId_1_name_1"],
  messages: ["userId_1_whatsappMessageId_1"],
  whatsappcredentials: ["userId_1"],
};

async function cleanupLegacyIndexes(db) {
  for (const [collectionName, indexNames] of Object.entries(staleIndexesByCollection)) {
    const collection = db.collection(collectionName);
    const existing = await collection.indexes();
    const existingNames = new Set(existing.map((index) => index.name));

    for (const indexName of indexNames) {
      if (!existingNames.has(indexName)) continue;
      try {
        await collection.dropIndex(indexName);
      } catch (err) {
        if (err?.codeName !== "IndexNotFound") {
          throw err;
        }
      }
    }
  }
}

async function dedupeByKey(db, collectionName, keyFields) {
  const collection = db.collection(collectionName);
  const pipeline = [
    {
      $group: {
        _id: keyFields.reduce((acc, field) => ({ ...acc, [field]: `$${field}` }), {}),
        ids: { $push: "$_id" },
        count: { $sum: 1 },
      },
    },
    { $match: { count: { $gt: 1 } } },
  ];

  const duplicates = await collection.aggregate(pipeline).toArray();
  if (!duplicates.length) return;

  for (const duplicate of duplicates) {
    const ids = duplicate.ids.map((id) => String(id));
    const docs = await collection
      .find({ _id: { $in: duplicate.ids } }, { projection: { _id: 1, updatedAt: 1, createdAt: 1 } })
      .sort({ updatedAt: -1, createdAt: -1, _id: 1 })
      .toArray();

    const keepId = docs[0]?._id;
    const removeIds = docs.slice(1).map((doc) => doc._id);
    if (keepId && removeIds.length) {
      await collection.deleteMany({ _id: { $in: removeIds } });
    } else if (!keepId && ids.length > 1) {
      await collection.deleteMany({ _id: { $in: duplicate.ids.slice(1) } });
    }
  }
}

async function createUniqueIndexSafe(db, collectionName, key, options = {}) {
  try {
    await db.collection(collectionName).createIndex(key, options);
  } catch (err) {
    if (err?.codeName !== "DuplicateKey") throw err;
    const keyFields = Object.keys(key);
    await dedupeByKey(db, collectionName, keyFields);
    await db.collection(collectionName).createIndex(key, options);
  }
}

async function ensureWorkspaceIndexes(db) {
  await createUniqueIndexSafe(db, "contacts", { workspaceId: 1, phone: 1 }, { unique: true });
  await createUniqueIndexSafe(db, "conversations", { workspaceId: 1, phone: 1 }, { unique: true });
  await createUniqueIndexSafe(db, "templates", { workspaceId: 1, name: 1 }, { unique: true });
  await createUniqueIndexSafe(
    db,
    "messages",
    { workspaceId: 1, whatsappMessageId: 1 },
    {
      unique: true,
      partialFilterExpression: { whatsappMessageId: { $type: "string" } },
    }
  );
  await createUniqueIndexSafe(db, "whatsappcredentials", { workspaceId: 1 }, { unique: true });
}

async function connectDB(mongoUri) {
  const uri = String(mongoUri || "").trim();
  if (!uri || !/^mongodb(\+srv)?:\/\//i.test(uri)) {
    throw new Error(
      'MONGODB_URI is missing/invalid. Set a valid Mongo connection string in backend/.env.local (recommended) or backend/.env (e.g. "mongodb+srv://...").'
    );
  }
  mongoose.set("strictQuery", true);
  await mongoose.connect(uri);
  await cleanupLegacyIndexes(mongoose.connection.db);
  await ensureWorkspaceIndexes(mongoose.connection.db);
}

module.exports = { connectDB };

