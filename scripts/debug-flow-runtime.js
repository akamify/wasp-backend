require("module-alias/register");
require("@core/config/loadEnv").loadEnv();

const mongoose = require("mongoose");
const { mongoUri } = require("@core/config/env");
const { Contact } = require("@infra/database/Contact");
const { FlowSession } = require("@infra/database/FlowSession");
const { FlowEvent } = require("@infra/database/FlowEvent");
const { FlowVersion } = require("@infra/database/FlowVersion");
const { Flow } = require("@infra/database/Flow");
const { Message } = require("@infra/database/Message");
const { normalizePhone } = require("@shared/services/contactService");
const {
  startSession,
} = require("@modules/flows/services/flowSession.service");
const {
  executeSession,
  continueSession,
} = require("@modules/flows/services/flowRuntime.service");

function argument(name) {
  const prefix = `--${name}=`;
  const found = process.argv.find((value) => value.startsWith(prefix));
  return found ? found.slice(prefix.length).trim() : "";
}

async function main() {
  const phone = normalizePhone(argument("phone"));
  const workspaceId = argument("workspace-id");
  const startFlowId = argument("start-flow-id");
  const buttonReplyId = argument("button-reply");
  const expireSessions = process.argv.includes("--expire-sessions");
  if (!phone) throw new Error("--phone is required");
  if (workspaceId && !mongoose.Types.ObjectId.isValid(workspaceId)) {
    throw new Error("--workspace-id must be a valid ObjectId");
  }

  await mongoose.connect(mongoUri, {
    serverSelectionTimeoutMS: 10000,
  });
  const contactFilter = {
    phone,
    ...(workspaceId ? { workspaceId } : {}),
  };
  const contacts = await Contact.find(contactFilter)
    .select("_id workspaceId phone name")
    .lean();
  if (!contacts.length) {
    process.stdout.write(`${JSON.stringify({ phone, contacts: [] }, null, 2)}\n`);
    return;
  }
  if (contacts.length > 1 && !workspaceId) {
    process.stdout.write(
      `${JSON.stringify(
        {
          phone,
          matches: contacts.map((item) => ({
            contactId: String(item._id),
            workspaceId: String(item.workspaceId),
            name: item.name || "",
          })),
          next: "Pass --workspace-id for the intended workspace.",
        },
        null,
        2
      )}\n`
    );
    return;
  }

  const contact = contacts[0];
  if (expireSessions) {
    const result = await FlowSession.updateMany(
      {
        workspaceId: contact.workspaceId,
        contactId: contact._id,
        status: "active",
      },
      {
        $set: {
          status: "expired",
          completedAt: new Date(),
          waitingFor: { type: null, attributeKey: null, nodeId: null },
          lockedUntil: null,
          lockedBy: null,
        },
      }
    );
    process.stdout.write(
      `${JSON.stringify({ expiredSessions: result.modifiedCount }, null, 2)}\n`
    );
  }

  if (startFlowId) {
    if (!mongoose.Types.ObjectId.isValid(startFlowId)) {
      throw new Error("--start-flow-id must be a valid ObjectId");
    }
    const flow = await Flow.findOne({
      _id: startFlowId,
      workspaceId: contact.workspaceId,
      status: "active",
      deletedAt: null,
      activeVersionId: { $ne: null },
    });
    if (!flow) throw new Error("Active flow not found in this workspace");
    const version = await FlowVersion.findOne({
      _id: flow.activeVersionId,
      workspaceId: contact.workspaceId,
      flowId: flow._id,
      status: "active",
    });
    if (!version) throw new Error("Active flow version not found");
    const activeSession = await FlowSession.findOne({
      workspaceId: contact.workspaceId,
      contactId: contact._id,
      status: "active",
      expiresAt: { $gt: new Date() },
    });
    if (activeSession) {
      throw new Error(
        `Active session ${activeSession._id} exists; expire it before starting a test`
      );
    }
    const session = await startSession({
      workspaceId: contact.workspaceId,
      contactId: contact._id,
      flow,
      version,
      initialContext: { debugFlowRuntime: true },
      now: new Date(),
    });
    const runtimeResult = await executeSession({
      workspaceId: contact.workspaceId,
      sessionId: session._id,
      inboundMessage: {
        type: "text",
        text: "Hi",
        from: contact.phone,
      },
    });
    process.stdout.write(
      `${JSON.stringify(
        {
          testStart: {
            flowId: String(flow._id),
            flowVersionId: String(version._id),
            sessionId: String(session._id),
            runtimeStatus: runtimeResult.status,
            sessionStatus: runtimeResult.session?.status || null,
            waitingFor: runtimeResult.session?.waitingFor || null,
            error: runtimeResult.session?.error || null,
          },
        },
        null,
        2
      )}\n`
    );
  }

  if (buttonReplyId) {
    const activeSession = await FlowSession.findOne({
      workspaceId: contact.workspaceId,
      contactId: contact._id,
      status: "active",
      expiresAt: { $gt: new Date() },
    }).sort({ startedAt: -1 });
    if (!activeSession) throw new Error("No active session found for button reply");
    const runtimeResult = await continueSession({
      workspaceId: contact.workspaceId,
      session: activeSession,
      inboundMessage: {
        type: "button_reply",
        from: contact.phone,
        buttonReply: {
          id: buttonReplyId,
          title: argument("button-title"),
        },
      },
    });
    process.stdout.write(
      `${JSON.stringify(
        {
          testButtonReply: {
            sessionId: String(activeSession._id),
            buttonId: buttonReplyId,
            runtimeStatus: runtimeResult.status,
            sessionStatus: runtimeResult.session?.status || null,
            currentNodeId: runtimeResult.session?.currentNodeId || null,
            error: runtimeResult.session?.error || null,
          },
        },
        null,
        2
      )}\n`
    );
  }

  const sessions = await FlowSession.find({
    workspaceId: contact.workspaceId,
    contactId: contact._id,
  })
    .sort({ createdAt: -1 })
    .limit(5)
    .lean();
  const sessionIds = sessions.map((session) => session._id);
  const events = await FlowEvent.find({
    workspaceId: contact.workspaceId,
    sessionId: { $in: sessionIds },
  })
    .sort({ createdAt: -1 })
    .limit(20)
    .lean();
  const versionIds = sessions.map((session) => session.flowVersionId);
  const versions = await FlowVersion.find({
    workspaceId: contact.workspaceId,
    _id: { $in: versionIds },
  }).lean();
  const messages = await Message.find({
    workspaceId: contact.workspaceId,
    phone: contact.phone,
  })
    .sort({ createdAt: -1 })
    .limit(10)
    .select(
      "_id direction type text buttons status whatsappMessageId error payload createdAt"
    )
    .lean();
  const buttonNodes = versions.flatMap((version) =>
    (version.nodes || [])
      .filter((node) => node?.type === "text_buttons")
      .map((node) => ({
        flowVersionId: String(version._id),
        versionNumber: version.versionNumber,
        nodeId: node.id,
        text: node.config?.text || "",
        buttonsCount: Array.isArray(node.config?.buttons)
          ? node.config.buttons.length
          : 0,
        buttons: node.config?.buttons || [],
        outgoingEdges: (version.edges || [])
          .filter((edge) => String(edge?.source) === String(node.id))
          .map((edge) => ({
            sourceHandle: edge.sourceHandle || null,
            target: edge.target,
            targetNode: (version.nodes || []).find(
              (candidate) => String(candidate?.id) === String(edge.target)
            ) || null,
          })),
      }))
  );

  process.stdout.write(
    `${JSON.stringify(
      {
        contact,
        sessions: sessions.map((session) => ({
          _id: session._id,
          status: session.status,
          currentNodeId: session.currentNodeId,
          waitingFor: session.waitingFor,
          fallbackCount: session.fallbackCount,
          error: session.error,
        })),
        events,
        messages,
        buttonNodes,
      },
      null,
      2
    )}\n`
  );
}

main()
  .catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });
