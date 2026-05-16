const { Server } = require("socket.io");
const { corsOrigins } = require("@core/config/env");
const { logger } = require("@core/logger/logger");

function createSocketServer(httpServer) {
    const isProd = String(process.env.NODE_ENV || "").toLowerCase() === "production";
    const io = new Server(httpServer, {
        cors: {
            origin: isProd ? corsOrigins : true,
            methods: ["GET", "POST"],
            credentials: true,
        },
    });

    io.on("connection", (socket) => {
        logger.info("Socket connected", { socketId: socket.id });
        socket.on("disconnect", (reason) => {
            logger.info("Socket disconnected", { socketId: socket.id, reason });
        });
    });

    return io;
}

module.exports = { createSocketServer };

