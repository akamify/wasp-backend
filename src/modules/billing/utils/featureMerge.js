function mergeFeatures(baseFeatures, overrideFeatures) {
  return Object.assign({}, baseFeatures || {}, overrideFeatures || {});
}

function mergeLimits(baseLimits, overrideLimits) {
  return Object.assign({}, baseLimits || {}, overrideLimits || {});
}

module.exports = { mergeFeatures, mergeLimits };

