function mergeFeatureOverride(snapshotFeatures, overrideFeatures) {
  return Object.assign({}, snapshotFeatures || {}, overrideFeatures || {});
}

module.exports = { mergeFeatureOverride };

