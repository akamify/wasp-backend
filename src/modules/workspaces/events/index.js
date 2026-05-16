const { EventEmitter } = require("events");
const WORKSPACE_EVENTS = require("@modules/workspaces/constants/workspaces.events");

const emitter = new EventEmitter();

function emitWorkspaceCreated(payload) {
  emitter.emit(WORKSPACE_EVENTS.WORKSPACE_CREATED, payload);
}

function emitMemberAdded(payload) {
  emitter.emit(WORKSPACE_EVENTS.MEMBER_ADDED, payload);
}

function emitInviteSent(payload) {
  emitter.emit(WORKSPACE_EVENTS.INVITE_SENT, payload);
}

module.exports = {
  emitter,
  WORKSPACE_EVENTS,
  emitWorkspaceCreated,
  emitMemberAdded,
  emitInviteSent,
};

