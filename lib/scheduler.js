const { getPeople, getTimecardsByWeek, getCrewForReminders } = require('../db');
const { sendMail, emailMondayReminder, emailMondayReminderEmployee } = require('./email');

function getWeekStart(date) {
  const d = new Date(date);
  d.setDate(d.getDate() - d.getDay());
  return d.toISOString().split('T')[0];
}

function getPrevWeekStart() {
  const d = new Date();
  d.setDate(d.getDate() - 7);
  return getWeekStart(d);
}

let lastFridayRun = null;
let lastMondayRun = null;

async function checkReminders() {
  const now = new Date();
  const day = now.getDay(); // 0=Sun, 1=Mon, 5=Fri
  const hour = now.getHours();
  const dateKey = now.toISOString().split('T')[0];

  // Friday 4pm — employees only, no manager summary
  if (day === 5 && hour >= 16 && hour < 17 && lastFridayRun !== dateKey) {
    lastFridayRun = dateKey;
    await runFridayEmployeeReminder();
  }

  // Monday 9am — employees + manager overdue summary
  if (day === 1 && hour >= 9 && hour < 10 && lastMondayRun !== dateKey) {
    lastMondayRun = dateKey;
    await runMondayReminder();
  }
}

// Friday: send reminder emails directly to employees only — no manager summary
async function runFridayEmployeeReminder() {
  try {
    const appUrl = process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : 'https://your-app.railway.app';
    const weekStart = getWeekStart(new Date());
    const submitted = await getTimecardsByWeek(weekStart);
    const submittedNames = submitted.filter(t => t.status === 'submitted').map(t => t.employee_name.toLowerCase());
    const crew = await getCrewForReminders();
    const missing = crew.filter(p =>
      !submittedNames.includes(p.name.toLowerCase()) &&
      !submittedNames.includes(p.nickname.toLowerCase())
    );

    if (!missing.length) { console.log('Friday reminder: all submitted — no emails needed'); return; }

    const managers = await getPeople('manager');
    const managerEmails = managers.filter(m => m.email).map(m => m.email);

    // Send directly to each employee who hasn't submitted — no manager summary
    for (const p of missing) {
      if (!p.email) continue;
      const html = emailMondayReminderEmployee(p.nickname, weekStart, appUrl);
      await sendMail(p.email, '⏰ Reminder — please submit your time card today', html, managerEmails);
    }

    console.log(`Friday employee reminders sent — ${missing.length} missing`);
  } catch (e) {
    console.error('Friday reminder error:', e.message);
  }
}

// Monday 9am: employees get overdue notice + managers get summary of who is late
async function runMondayReminder() {
  try {
    const appUrl = process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : 'https://your-app.railway.app';
    const prevWeek = getPrevWeekStart();
    const submitted = await getTimecardsByWeek(prevWeek);
    const submittedNames = submitted.filter(t => t.status === 'submitted').map(t => t.employee_name.toLowerCase());
    const crew = await getCrewForReminders();
    const missing = crew.filter(p =>
      !submittedNames.includes(p.name.toLowerCase()) &&
      !submittedNames.includes(p.nickname.toLowerCase())
    );

    if (!missing.length) { console.log('Monday reminder: all submitted — no emails needed'); return; }

    const managers = await getPeople('manager');
    const bookkeepers = await getPeople('bookkeeper');
    const managerEmails = managers.filter(m => m.email).map(m => m.email);
    const bookeeperEmails = bookkeepers.filter(b => b.email).map(b => b.email);
    const adminEmails = [...managerEmails, ...bookeeperEmails];

    // Admin summary — only sent Monday when timecards are actually late
    const missingNames = missing.map(p => `${p.nickname} (${p.name})`);
    const summaryHtml = emailMondayReminder(missingNames, appUrl);
    await sendMail(adminEmails, `🚨 OVERDUE — ${missing.length} time card${missing.length>1?'s':''} not submitted`, summaryHtml);

    // Individual overdue emails to each employee
    for (const p of missing) {
      if (!p.email) continue;
      const html = emailMondayReminderEmployee(p.nickname, prevWeek, appUrl);
      await sendMail(p.email, '⚠ Your time card is overdue', html, managerEmails);
    }

    console.log(`Monday overdue reminders sent — ${missing.length} missing`);
  } catch (e) {
    console.error('Monday reminder error:', e.message);
  }
}

function startScheduler() {
  setInterval(checkReminders, 30 * 60 * 1000);
  console.log('  Reminder scheduler started.');
}

module.exports = { startScheduler };
