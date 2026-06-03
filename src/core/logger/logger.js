function createLogger() {
  const noop = () => {};
  const logger = {
    error: noop,
    warn: noop,
    info: noop,
    log: noop,
    debug: noop,
    child: () => createLogger(),
  };
  return logger;
}

const logger = createLogger();

module.exports = logger;
module.exports.logger = logger;
