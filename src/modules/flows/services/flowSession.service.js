const mongoose = require("mongoose");
const { HttpError } = require("@shared/utils/httpError");
const flowsRepository = require("@modules/flows/repositories/flows.repository");
const flowSessionRepository = require("@modules/flows/repositories/flowSession.repository");

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

function assertValidObjectId(value, label) {
  if (!mongoose.Types.ObjectId.isValid(String(value || ""))) {
    throw new HttpError(400, `Invalid ${label}`);
  }
}

function findStartNode(version) {
  return (Array.isArray(version?.nodes) ? version.nodes : []).find(
    (node) => node?.type === "start" && String(node?.id || "").trim()
  );
}

async function findActiveSession({ workspaceId, contactId, now = new Date() }) {
  return flowSessionRepository.findActiveSession({
    workspaceId,
    contactId,
    now,
  });
}

async function shouldSkipForHandover({ workspaceId, contact }) {
  if (!workspaceId || !contact?.phone) return false;
  return Boolean(
    await flowSessionRepository.findPausedConversation({
      workspaceId,
      wabaId: contact.wabaId || null,
      phone: contact.phone,
    })
  );
}

async function startSession({
  workspaceId,
  contactId,
  flow,
  version,
  initialContext = {},
  now = new Date(),
}) {
  const startNode = findStartNode(version);
  if (!startNode) {
    throw new HttpError(409, "Published flow version has no start node");
  }

  let session;
  try {
    session = await flowSessionRepository.createSession({
      workspaceId,
      contactId,
      flowId: flow._id,
      flowVersionId: version._id,
      status: "active",
      currentNodeId: String(startNode.id).trim(),
      context: initialContext,
      fallbackCount: 0,
      startedAt: now,
      lastMessageAt: now,
      expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
    });

    await flowSessionRepository.createFlowStartedEvent({
      workspaceId,
      flowId: flow._id,
      flowVersionId: version._id,
      sessionId: session._id,
      contactId,
      eventType: "flow_started",
      nodeId: String(startNode.id).trim(),
      data: null,
    });
  } catch (error) {
    if (session?._id) {
      await flowSessionRepository
        .deleteSession({ workspaceId, sessionId: session._id })
        .catch(() => {});
    }
    throw error;
  }

  return session;
}

async function manualStart({
  workspaceId,
  flowId,
  contactId,
  initialContext,
  force,
}) {
  assertValidObjectId(flowId, "flow id");
  assertValidObjectId(contactId, "contact id");

  const [flow, contact] = await Promise.all([
    flowsRepository.findFlowById({ workspaceId, flowId }),
    flowSessionRepository.findContactById({ workspaceId, contactId }),
  ]);
  if (!flow) throw new HttpError(404, "Flow not found");
  if (flow.status !== "active" || !flow.activeVersionId) {
    throw new HttpError(409, "Flow must be active and published");
  }
  if (!contact) throw new HttpError(404, "Contact not found");

  const version = await flowsRepository.findFlowVersionById({
    workspaceId,
    flowId,
    versionId: flow.activeVersionId,
  });
  if (!version || version.status !== "active") {
    throw new HttpError(409, "Active flow version could not be resolved");
  }

  const now = new Date();
  const existingSession = await findActiveSession({
    workspaceId,
    contactId,
    now,
  });
  if (existingSession && !force) {
    throw new HttpError(409, "Contact already has an active flow session", {
      sessionId: String(existingSession._id),
    });
  }
  if (existingSession && force) {
    await flowSessionRepository.expireSession({
      workspaceId,
      sessionId: existingSession._id,
      completedAt: now,
    });
  }

  return startSession({
    workspaceId,
    contactId,
    flow,
    version,
    initialContext,
    now,
  });
}

module.exports = {
  findActiveSession,
  shouldSkipForHandover,
  startSession,
  manualStart,
};
