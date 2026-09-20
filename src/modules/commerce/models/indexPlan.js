function getIndexPlan(models) {
  return Object.values(models).map((model) => ({
    collection: model.collection.collectionName,
    indexes: model.schema.indexes().map(([key, options]) => ({
      key,
      options: {
        name: options.name || Object.entries(key).map(([field, direction]) => `${field}_${direction}`).join("_"),
        ...(options.unique ? { unique: true } : {}),
        ...(options.partialFilterExpression ? { partialFilterExpression: options.partialFilterExpression } : {}),
        ...(options.expireAfterSeconds != null ? { expireAfterSeconds: options.expireAfterSeconds } : {}),
      },
    })),
  }));
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonical(value[key])])
  );
  return value;
}

function indexMatches(actual, expected) {
  // Compound key order matters; option object ordering does not.
  return JSON.stringify(actual.key) === JSON.stringify(expected.key)
    && Boolean(actual.unique) === Boolean(expected.options.unique)
    && Boolean(actual.sparse) === Boolean(expected.options.sparse)
    && !actual.hidden
    && (!actual.collation || actual.collation.locale === "simple")
    && actual.expireAfterSeconds === expected.options.expireAfterSeconds
    && JSON.stringify(canonical(actual.partialFilterExpression)) === JSON.stringify(canonical(expected.options.partialFilterExpression));
}

async function checkIndexes(db, plan) {
  const missing = [];
  for (const collection of plan) {
    let existing;
    try {
      existing = await db.collection(collection.collection).listIndexes().toArray();
    } catch (error) {
      if (error.code !== 26) throw error; // NamespaceNotFound
      existing = [];
    }
    for (const expected of collection.indexes) {
      if (!existing.some((actual) => indexMatches(actual, expected))) {
        missing.push({ collection: collection.collection, index: expected.options.name });
      }
    }
  }
  return missing;
}

async function applyIndexes(db, plan) {
  // Never use syncIndexes or startup deduplication: neither may drop data here.
  // Conflicting indexes/duplicates fail for explicit operator investigation.
  for (const collection of plan) {
    for (const index of collection.indexes) {
      await db.collection(collection.collection).createIndex(index.key, index.options);
    }
  }
}

module.exports = { getIndexPlan, indexMatches, checkIndexes, applyIndexes };

