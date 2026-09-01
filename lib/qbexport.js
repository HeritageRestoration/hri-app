const { getTimecardsByWeek, getTimecardDetail, pool } = require('../db');

function fmtDate(d) {
  if (!d) return 'N/A';
  try {
    const s = d instanceof Date ? d.toISOString().split('T')[0] : String(d).split('T')[0];
    const date = new Date(s + 'T12:00:00');
    if (isNaN(date.getTime())) return 'N/A';
    return date.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
  } catch(e) { return 'N/A'; }
}

function fmtHrs(n) { return (parseFloat(n)||0).toFixed(2); }

async function buildExportRows(weekStart) {
  const timecards = await getTimecardsByWeek(weekStart);
  const rows = [];

  for (const tc of timecards) {
    if (tc.status !== 'submitted') continue;
    const detail = await getTimecardDetail(tc.id);
    const weekEnd = fmtDate(tc.week_end);
    const flaggedJobs = (detail.flags||[]).map(f => f.job_name);

    // Leave rows — TWEAK 1: exclude Lack of Work, flag KOS
    for (const lv of (detail.leave||[])) {
      if ((parseFloat(lv.hours)||0) <= 0) continue;
      // Lack of Work: skip entirely — not exported to QB
      if (lv.leave_type === 'Lack of Work') continue;
      const isKOS = lv.leave_type === 'KOS';
      rows.push({
        employee:    tc.employee_name,
        week_ending: weekEnd,
        location:    `— ${lv.leave_type || 'Leave'} —`,
        li_code:     '',
        pay_type:    lv.leave_type || 'Leave',
        sun: '', mon: '', tue: '', wed: '', thu: '', fri: '', sat: '',
        total_hrs:   fmtHrs(lv.hours),
        after_hrs:   '',
        flag:        isKOS ? 'KOS' : 'Clean',
        flag_type:   isKOS ? 'kos' : 'ok'
      });
    }

    // Job rows
    for (const r of (detail.rows||[])) {
      if ((parseFloat(r.total_hrs)||0) <= 0) continue;
      const DAYS = ['sun','mon','tue','wed','thu','fri','sat'];
      const dayVals = {};
      DAYS.forEach(d => { dayVals[d] = (parseFloat(r[d])||0) > 0 ? fmtHrs(r[d]) : ''; });

      // After hours summary
      let afterHrsSummary = '';
      try {
        const ah = typeof r.after_hours === 'string' ? JSON.parse(r.after_hours) : (r.after_hours||{});
        const ahDays = Object.keys(ah).filter(d => ah[d]);
        if (ahDays.length) afterHrsSummary = ahDays.map(d => `${d.charAt(0).toUpperCase()+d.slice(1)}`).join(', ');
      } catch(e) {}

      // Determine flag
      let flag = 'Clean', flagType = 'ok';
      if (r.is_new_job) { flag = 'New job'; flagType = 'newjob'; }
      else if (flaggedJobs.includes(r.job_name)) {
        const f = (detail.flags||[]).find(f => f.job_name === r.job_name);
        if (f) { flag = f.flag_type === 'unmatched' ? 'Not in board' : f.flag_type === 'closed' ? 'Job closed' : 'Not assigned'; flagType = f.flag_type; }
      }

      const payType = r.section === 'boardup' ? 'Board-Up' : r.is_possible ? 'Pre-Sale' : r.is_office ? 'Admin/Office' : r.is_nonbill ? 'Non-Billable' : 'Regular';

      // One row per LI code
      const codes = [];
      if (r.li_code_1) codes.push({ code: r.li_code_1, hrs: r.li_hrs_1 });
      if (r.li_code_2) codes.push({ code: r.li_code_2, hrs: r.li_hrs_2 });
      if (!codes.length) codes.push({ code: r.section === 'boardup' ? '0521' : '', hrs: r.total_hrs });

      for (const c of codes) {
        rows.push({
          employee:    tc.employee_name,
          week_ending: weekEnd,
          location:    r.job_name || '—',
          li_code:     c.code,
          pay_type:    payType,
          ...dayVals,
          total_hrs:   fmtHrs(c.hrs || r.total_hrs),
          after_hrs:   afterHrsSummary,
          flag,
          flag_type:   flagType
        });
      }
    }
  }
  return rows;
}

function rowsToCSV(rows) {
  const headers = ['Employee','Week Ending','Location / Job','L&I Code','Pay Type','Sun','Mon','Tue','Wed','Thu','Fri','Sat','Total Hrs','After Hrs','Flag'];
  const lines = [headers.join(',')];
  for (const r of rows) {
    const vals = [
      r.employee, r.week_ending, r.location, r.li_code, r.pay_type,
      r.sun||'', r.mon||'', r.tue||'', r.wed||'', r.thu||'', r.fri||'', r.sat||'',
      r.total_hrs, r.after_hrs, r.flag
    ].map(v => `"${String(v).replace(/"/g,'""')}"`);
    lines.push(vals.join(','));
  }
  return lines.join('\n');
}

module.exports = { buildExportRows, rowsToCSV };
