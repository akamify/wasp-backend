const liveDemoService = require("@modules/live-demo/services/liveDemo.service");

async function publicSlots(req, res) {
  const slots = await liveDemoService.listSlots({ date: req.query.date });
  return res.json({ success: true, slots });
}

async function publicCreate(req, res) {
  const enquiry = await liveDemoService.createEnquiry(req.body);
  return res.status(201).json({
    success: true,
    message: "LIVE_DEMO_ENQUIRY_CREATED",
    enquiry,
  });
}

async function adminList(req, res) {
  const data = await liveDemoService.listAdminEnquiries({
    page: req.query.page,
    limit: req.query.limit,
    q: req.query.q || req.query.search,
    status: req.query.status || req.query.filter,
    date: req.query.date,
  });
  return res.json({ success: true, ...data });
}

async function adminUpdateStatus(req, res) {
  const enquiry = await liveDemoService.updateStatus({
    id: req.params.id,
    status: req.body.status,
  });
  return res.json({
    success: true,
    message: "LIVE_DEMO_ENQUIRY_UPDATED",
    enquiry,
  });
}

module.exports = {
  publicSlots,
  publicCreate,
  adminList,
  adminUpdateStatus,
};
