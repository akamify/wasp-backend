const { createWorker } = require("@infra/queues/queueFactory");
const { QUEUE_NAMES } = require("@infra/queues/queueNames");
const { logger } = require("@core/logger/logger");
const { detectAndAssignLead } = require("@modules/crm/services/leadDetection.service");

function startCrmLeadAssignmentWorker() {
  return createWorker(
    QUEUE_NAMES.CRM_LEAD_ASSIGNMENT,
    async (job) => {
      const name = String(job?.name || "");
      if (name !== "crm.lead.detect_and_assign") return null;
      const { workspaceId, phone, inboundAt } = job.data || {};
      if (!workspaceId || !phone) return null;
      return detectAndAssignLead({ workspaceId, phone, inboundAt });
    },
    {
      concurrency: 5,
    }
  );
}

module.exports = { startCrmLeadAssignmentWorker };

