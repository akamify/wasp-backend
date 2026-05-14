const { BRAND_NAME_FALLBACK } = require("./runtimeConstants");

function escapeHtml(v) {
  return String(v ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function wrapSimpleEmail({ title, preheader, bodyHtml }) {
  const brand = BRAND_NAME_FALLBACK();
  return `
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(preheader || "")}</div>
    <div style="font-family: Inter, Arial, sans-serif; max-width: 640px; margin: 0 auto; color: #0f172a; padding: 20px;">
      <div style="margin-bottom: 14px; font-weight: 800; letter-spacing: -0.02em;">${escapeHtml(brand)}</div>
      <h2 style="margin: 0 0 10px;">${escapeHtml(title || "")}</h2>
      <div style="border: 1px solid #e2e8f0; border-radius: 12px; padding: 16px 18px; background: #ffffff;">
        ${bodyHtml || ""}
      </div>
      <p style="margin-top: 14px; color: #64748b; font-size: 12px;">This is an automated message from ${escapeHtml(brand)}.</p>
    </div>
  `;
}

function buildTicketCreatedEmailHtml({ ticketId, name, email, phone, subject, message }) {
  return wrapSimpleEmail({
    title: "Support ticket received",
    preheader: `Ticket ${ticketId} created successfully`,
    bodyHtml: `
      <p style="margin:0 0 10px;color:#334155;">Hi ${escapeHtml(name)},</p>
      <p style="margin:0 0 14px;color:#334155;">We received your support request. Our team will get back to you soon.</p>
      <div style="font-size: 13px; line-height: 1.6; color: #0f172a;">
        <div><b>Ticket:</b> ${escapeHtml(ticketId)}</div>
        <div><b>Subject:</b> ${escapeHtml(subject)}</div>
        <div><b>Email:</b> ${escapeHtml(email)}</div>
        ${phone ? `<div><b>Phone:</b> ${escapeHtml(phone)}</div>` : ""}
        <div style="margin-top:10px;"><b>Message:</b><br/>${escapeHtml(message).replaceAll("\n", "<br/>")}</div>
      </div>
    `,
  });
}

function buildTicketResolvedEmailHtml({ ticketId, name, subject, resolutionNote }) {
  return wrapSimpleEmail({
    title: "Support ticket resolved",
    preheader: `Ticket ${ticketId} has been marked resolved`,
    bodyHtml: `
      <p style="margin:0 0 10px;color:#334155;">Hi ${escapeHtml(name)},</p>
      <p style="margin:0 0 14px;color:#334155;">Your support ticket has been marked as resolved.</p>
      <div style="font-size: 13px; line-height: 1.6; color: #0f172a;">
        <div><b>Ticket:</b> ${escapeHtml(ticketId)}</div>
        <div><b>Subject:</b> ${escapeHtml(subject)}</div>
        ${resolutionNote ? `<div style="margin-top:10px;"><b>Resolution:</b><br/>${escapeHtml(resolutionNote).replaceAll("\n", "<br/>")}</div>` : ""}
      </div>
    `,
  });
}

function buildCareerApplicationEmailHtml({ applicantName, applyingRole }) {
  return wrapSimpleEmail({
    title: "Application received",
    preheader: "We received your job application",
    bodyHtml: `
      <p style="margin:0 0 10px;color:#334155;">Hi ${escapeHtml(applicantName)},</p>
      <p style="margin:0;color:#334155;">Thanks for applying for <b>${escapeHtml(applyingRole)}</b>. We will review your application and contact you if shortlisted.</p>
    `,
  });
}

module.exports = {
  buildTicketCreatedEmailHtml,
  buildTicketResolvedEmailHtml,
  buildCareerApplicationEmailHtml,
};

