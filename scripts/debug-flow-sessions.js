require("module-alias/register");
require("@core/config/loadEnv").loadEnv();

const mongoose = require("mongoose");
const { mongoUri } = require("@core/config/env");
const { Contact } = require("@infra/database/Contact");
const { FlowSession } = require("@infra/database/FlowSession");
const { FlowEvent } = require("@infra/database/FlowEvent");
const { normalizePhone } = require("@shared/services/contactService");
const {
  expireActiveSession,
} = require("@modules/flows/services/flowSession.service");

function argument(...names) {
  for (const name of names) {
    const prefix = `--${name}=`;
    const found = process.argv.find((value) => value.startsWith(prefix));
    if (found) return found.slice(prefix.length).trim();
  }
  return "";
}

async function main() {
  const phone = normalizePhone(argument("phone"));
  const workspaceId = argument("workspaceId", "workspace-id");
  const expireActive = process.argv.includes("--expire-active");
  if (!phone) throw new Error("--phone is required");
  if (workspaceId && !mongoose.Types.ObjectId.isValid(workspaceId)) {
    throw new Error("--workspaceId must be a valid ObjectId");
  }

  await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 10000 });
  const contacts = await Contact.find({
    phone,
    ...(workspaceId ? { workspaceId } : {}),
  })
    .select("_id workspaceId phone name lastInboundAt")
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
          matches: contacts.map((contact) => ({
            contactId: String(contact._id),
            workspaceId: String(contact.workspaceId),
            name: contact.name || "",
          })),
          next: "Pass --workspaceId for the intended workspace.",
        },
        null,
        2
      )}\n`
    );
    return;
  }

  const contact = contacts[0];
  if (expireActive) {
    const activeSessions = await FlowSession.find({
      workspaceId: contact.workspaceId,
      contactId: contact._id,
      status: "active",
    });
    let expired = 0;
    for (const session of activeSessions) {
      const result = await expireActiveSession({
        workspaceId: contact.workspaceId,
        session,
        reason: "manual",
        now: new Date(),
      });
      if (result) expired += 1;
    }
    process.stdout.write(`${JSON.stringify({ expiredActive: expired }, null, 2)}\n`);
  }

  const sessions = await FlowSession.find({
    workspaceId: contact.workspaceId,
    contactId: contact._id,
  })
    .sort({ createdAt: -1 })
    .limit(20)
    .lean();
  const events = await FlowEvent.find({
    workspaceId: contact.workspaceId,
    sessionId: { $in: sessions.map((session) => session._id) },
  })
    .sort({ createdAt: -1 })
    .limit(50)
    .lean();

  process.stdout.write(
    `${JSON.stringify(
      {
        contact,
        sessions: sessions.map((session) => ({
          sessionId: String(session._id),
          flowId: String(session.flowId),
          flowVersionId: String(session.flowVersionId),
          status: session.status,
          currentNodeId: session.currentNodeId,
          waitingFor: session.waitingFor,
          expiresAt: session.expiresAt,
          expiredAt: session.expiredAt,
          expiryReason: session.expiryReason,
          completedAt: session.completedAt,
          lastPromptSentAt: session.lastPromptSentAt,
          lastPromptNodeId: session.lastPromptNodeId,
          lastPromptMessageStatus: session.lastPromptMessageStatus,
          lastPromptFailureReason: session.lastPromptFailureReason,
          fallbackCount: session.fallbackCount,
          error: session.error,
        })),
        events: events.map((event) => ({
          eventId: String(event._id),
          sessionId: String(event.sessionId),
          eventType: event.eventType,
          nodeId: event.nodeId,
          data: event.data,
          createdAt: event.createdAt,
        })),
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
