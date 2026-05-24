function bindPhoneParamFromBody(field = "to") {
  return (req, res, next) => {
    const value = req.body?.[field];
    if (value && (!req.params || !req.params.phone)) {
      req.params = req.params || {};
      req.params.phone = value;
    }
    return next();
  };
}

module.exports = { bindPhoneParamFromBody };

