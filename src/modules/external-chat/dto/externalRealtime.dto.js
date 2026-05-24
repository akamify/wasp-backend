function externalReadyPayload() {
  return {
    connected: true,
    connectedAt: new Date().toISOString(),
  };
}

function externalPingPayload() {
  return {
    at: new Date().toISOString(),
  };
}

module.exports = { externalReadyPayload, externalPingPayload };
