const https = require('https');

async function getGraphToken() {
  const { MS_TENANT_ID: tid, MS_CLIENT_ID: cid, MS_CLIENT_SECRET: sec } = process.env;
  if (!tid || !cid || !sec) throw new Error('Microsoft 365 credentials not configured');
  // Use URLSearchParams which properly encodes all special characters
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: cid,
    client_secret: sec,
    scope: 'https://graph.microsoft.com/.default'
  }).toString();
  return new Promise((res, rej) => {
    const req = https.request({
      hostname: 'login.microsoftonline.com',
      path: `/${encodeURIComponent(tid)}/oauth2/v2.0/token`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body)
      }
    }, r => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => {
        try {
          const p = JSON.parse(d);
          p.access_token ? res(p.access_token) : rej(new Error(p.error_description || p.error || d));
        } catch(e) { rej(new Error('Token parse error: ' + d)); }
      });
    });
    req.on('error', rej); req.write(body); req.end();
  });
}

async function sendMail(to, subject, html, cc) {
  if (!process.env.MS_SENDER_EMAIL) { console.log('Email skipped — MS_SENDER_EMAIL not set'); return; }
  const token = await getGraphToken();
  // Clean the subject — remove any characters that could cause path issues
  const cleanSubject = String(subject).replace(/[\r\n]/g, ' ');
  const payload = JSON.stringify({
    message: {
      subject: cleanSubject,
      body: { contentType: 'HTML', content: html },
      toRecipients: [].concat(to).filter(Boolean).map(a => ({ emailAddress: { address: a.trim() } })),
      ccRecipients: cc ? [].concat(cc).filter(Boolean).map(a => ({ emailAddress: { address: a.trim() } })) : []
    },
    saveToSentItems: true
  });
  const senderPath = `/v1.0/users/${encodeURIComponent(process.env.MS_SENDER_EMAIL.trim())}/sendMail`;
  await new Promise((res, rej) => {
    const req = https.request({
      hostname: 'graph.microsoft.com',
      path: senderPath,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, r => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => {
        if (r.statusCode === 202 || r.statusCode === 200) {
          res();
        } else {
          rej(new Error(`Graph ${r.statusCode}: ${d}`));
        }
      });
    });
    req.on('error', rej); req.write(payload); req.end();
  });
}

// ── Email templates ───────────────────────────────────────────────────────────

function wrap(title, body) {
  return `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;font-size:13px;color:#1e2d40;max-width:680px;margin:0 auto;padding:16px">
    <div style="background:#1a2e4a;color:#fff;padding:14px 20px;border-radius:8px 8px 0 0">
      <div style="font-size:16px;font-weight:700">Fire Water Storm — ${title}</div>
    </div>
    <div style="background:#fff;border:1px solid #dde3ec;border-top:none;padding:16px 20px;border-radius:0 0 8px 8px">
      ${body}
    </div>
  </body></html>`;
}

function emailSubmitted(tc, appUrl) {
  const rows = (tc.rows||[]).filter(r => parseFloat(r.total_hrs)>0);
  const rowsHtml = rows.map(r => `
    <tr style="border-bottom:1px solid #f0f4f8">
      <td style="padding:6px 10px">${r.job_name||'—'}${r.is_new_job?'<span style="margin-left:6px;background:#ede9fe;color:#5b21b6;font-size:10px;padding:1px 6px;border-radius:8px;font-weight:600">New job</span>':''}</td>
      <td style="padding:6px 10px;text-align:center">${r.li_code_1||'—'}</td>
      <td style="padding:6px 10px;text-align:right;font-weight:600">${parseFloat(r.total_hrs).toFixed(1)}</td>
    </tr>`).join('');
  const flags = (tc.flags||[]);
  const flagsHtml = flags.length ? `
    <div style="margin-top:12px;background:#fffbf0;border-left:4px solid #d97706;padding:10px 14px;border-radius:4px">
      <div style="font-size:12px;font-weight:700;color:#92400e;margin-bottom:6px">⚠ ${flags.length} mismatch flag${flags.length>1?'s':''} — review needed</div>
      ${flags.map(f=>`<div style="font-size:12px;color:#92400e;margin-bottom:3px">• ${f.job_name}: ${f.description}</div>`).join('')}
    </div>` : '';
  return wrap('Time Card Submitted', `
    <p style="margin-bottom:12px"><strong>${tc.employee_name}</strong> submitted their time card for the week of ${fmtDate(tc.week_start)}.</p>
    <div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:14px">
      <div><span style="font-size:11px;color:#8fa0b8">TOTAL HRS</span><br><strong style="font-size:18px">${parseFloat(tc.total_combined).toFixed(1)}</strong></div>
      <div><span style="font-size:11px;color:#8fa0b8">REGULAR</span><br><strong>${parseFloat(tc.total_reg_hrs).toFixed(1)}</strong></div>
      <div><span style="font-size:11px;color:#8fa0b8">BOARD-UP</span><br><strong>${parseFloat(tc.total_bu_hrs).toFixed(1)}</strong></div>
      <div><span style="font-size:11px;color:#8fa0b8">OFFICE</span><br><strong>${parseFloat(tc.total_office_hrs).toFixed(1)}</strong></div>
      <div><span style="font-size:11px;color:#8fa0b8">LEAVE</span><br><strong>${parseFloat(tc.total_leave_hrs).toFixed(1)}</strong></div>
    </div>
    <table style="width:100%;border-collapse:collapse;font-size:12px">
      <thead><tr style="background:#f8f9fb"><th style="padding:6px 10px;text-align:left">Location / Job</th><th style="padding:6px 10px;text-align:center">L&I Code</th><th style="padding:6px 10px;text-align:right">Hours</th></tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>
    ${flagsHtml}
    <p style="margin-top:14px;font-size:11px;color:#8fa0b8">View full detail: ${appUrl}/admin</p>
  `);
}

function emailFridayReminder(notSubmitted, appUrl) {
  const list = notSubmitted.map(n => `<li style="padding:3px 0">${n}</li>`).join('');
  return wrap('Friday Reminder — Time Cards Due', `
    <p style="margin-bottom:12px">It's Friday afternoon. The following crew members have <strong>not yet submitted</strong> their time card for this week:</p>
    <ul style="margin:0 0 14px;padding-left:20px;font-size:13px">${list}</ul>
    <p style="font-size:12px;color:#4a5e78">Please follow up with them before end of day so payroll can be processed on time.</p>
    <p style="margin-top:12px;font-size:11px;color:#8fa0b8">Admin dashboard: ${appUrl}/admin</p>
  `);
}

function emailMondayReminder(notSubmitted, appUrl) {
  const list = notSubmitted.map(n => `<li style="padding:3px 0">${n}</li>`).join('');
  return wrap('OVERDUE — Time Cards Not Submitted', `
    <p style="margin-bottom:10px;color:#991b1b;font-weight:600">⚠ The following crew members have still not submitted their time card for last week:</p>
    <ul style="margin:0 0 14px;padding-left:20px;font-size:13px">${list}</ul>
    <p style="font-size:12px;color:#4a5e78">Payroll is being processed. Please collect their time cards immediately.</p>
    <p style="margin-top:12px;font-size:11px;color:#8fa0b8">Admin dashboard: ${appUrl}/admin</p>
  `);
}

function emailMondayReminderEmployee(name, weekStart, appUrl) {
  return wrap('Your Time Card is Overdue', `
    <p style="margin-bottom:12px">Hi ${name},</p>
    <p style="margin-bottom:12px">Your time card for the week of <strong>${fmtDate(weekStart)}</strong> has not been submitted yet.</p>
    <p style="margin-bottom:14px">Please submit it as soon as possible so payroll can be processed.</p>
    <a href="${appUrl}/timecard" style="background:#1a2e4a;color:#fff;padding:10px 20px;border-radius:7px;text-decoration:none;font-weight:600;font-size:13px">Submit My Time Card →</a>
    <p style="margin-top:14px;font-size:11px;color:#8fa0b8">Questions? Contact your supervisor.</p>
  `);
}

function fmtDate(d) {
  if (!d) return '—';
  try {
    const date = d instanceof Date ? d : new Date(typeof d === 'string' && d.length === 10 ? d + 'T12:00:00' : d);
    if (isNaN(date.getTime())) return '—';
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch(e) { return '—'; }
}

module.exports = { sendMail, emailSubmitted, emailFridayReminder, emailMondayReminder, emailMondayReminderEmployee };
