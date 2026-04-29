require("dotenv").config();

const app = require("./app");
const { connectDB } = require("./config/db");
const { port, mongoUri } = require("./config/env");

async function start() {
  await connectDB(mongoUri);
  app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`API listening on port ${port}`);
  });
}

start().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Failed to start server:", err);
  process.exit(1);
});

