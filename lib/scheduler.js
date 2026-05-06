const { getPeople, getTimecardsByWeek, getCrewForReminders } = require('../db');
const { sendMail, emailFridayReminder, emailMondayReminder, emailMondayReminderEmployee } = require('./email');

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

  // Friday 4pm (hour 16)
  if (day === 5 && hour >= 16 && hour < 17 && lastFridayRun !== dateKey) {
    lastFridayRun = dateKey;
    await runFridayReminder();
  }

  // Monday 9am (hour 9)
  if (day === 1 && hour >= 9 && hour < 10 && lastMondayRun !== dateKey) {
    lastMondayRun = dateKey;
    await runMondayReminder();
  }
}

async function runFridayReminder() {
  try {
    const appUrl = process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : 'https://your-app.railway.app';
    const weekStart = getWeekStart(new Date());
    const submitted = await getTimecardsByWeek(weekStart);
    const submittedNames = submitted.filter(t => t.status === 'submitted').map(t => t.employee_name.toLowerCase());
    const crew = await getCrewForReminders();
    const notSubmitted = crew
      .filter(p => !submittedNames.includes(p.name.toLowerCase()) && !submittedNames.includes(p.nickname.toLowerCase()))
      .map(p => `${p.nickname} (${p.name})`);

    if (!notSubmitted.length) { console.log('Friday reminder: all crew submitted — no email needed'); return; }

    const managers = await getPeople('manager');
    const managerEmails = managers.filter(m => m.email).map(m => m.email);
    const html = emailFridayReminder(notSubmitted, appUrl);
    await sendMail(managerEmails, `⏰ Friday Reminder — ${notSubmitted.length} crew haven't submitted time cards`, html);
    console.log(`Friday reminder sent — ${notSubmitted.length} missing`);
  } catch (e) {
    console.error('Friday reminder error:', e.message);
  }
}

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

    if (!missing.length) { console.log('Monday reminder: all crew submitted — no email needed'); return; }

    const managers = await getPeople('manager');
    const bookkeepers = await getPeople('bookkeeper');
    const managerEmails = managers.filter(m => m.email).map(m => m.email);
    const bookeeperEmails = bookkeepers.filter(b => b.email).map(b => b.email);
    const ccEmails = [...managerEmails, ...bookeeperEmails];

    // Manager + bookkeeper summary
    const missingNames = missing.map(p => `${p.nickname} (${p.name})`);
    const summaryHtml = emailMondayReminder(missingNames, appUrl);
    await sendMail(ccEmails, `🚨 OVERDUE — ${missing.length} time card${missing.length>1?'s':''} not submitted`, summaryHtml);

    // Individual emails to each crew member who has an email
    for (const p of missing) {
      if (!p.email) continue;
      const html = emailMondayReminderEmployee(p.nickname, prevWeek, appUrl);
      await sendMail(p.email, '⚠ Your time card is overdue', html, managerEmails);
    }

    console.log(`Monday reminder sent — ${missing.length} missing`);
  } catch (e) {
    console.error('Monday reminder error:', e.message);
  }
}

function startScheduler() {
  // Check every 30 minutes
  setInterval(checkReminders, 30 * 60 * 1000);
  console.log('  Reminder scheduler started.');
}

module.exports = { startScheduler };
