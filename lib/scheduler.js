const { getPeople, getTimecardsByWeek, getCrewForReminders } = require('../db');
const { sendMail, emailAdminSummary, emailMondayReminderEmployee } = require('./email');

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

// Convert UTC time to Pacific time hour (handles PDT UTC-7 and PST UTC-8)
// Railway runs UTC — Pacific is UTC-7 (summer/PDT) or UTC-8 (winter/PST)
// We check both offsets so it fires correctly year-round
function getPacificHour(utcDate) {
  // Approximate: PDT is UTC-7 (Mar-Nov), PST is UTC-8 (Nov-Mar)
  const month = utcDate.getUTCMonth(); // 0=Jan
  const offsetHours = (month >= 2 && month <= 10) ? 7 : 8; // PDT or PST
  return (utcDate.getUTCHours() - offsetHours + 24) % 24;
}

function getPacificDay(utcDate) {
  const month = utcDate.getUTCMonth();
  const offsetHours = (month >= 2 && month <= 10) ? 7 : 8;
  // Shift date by offset to get Pacific calendar day
  const pacific = new Date(utcDate.getTime() - offsetHours * 60 * 60 * 1000);
  return pacific.getUTCDay(); // 0=Sun, 1=Mon, 5=Fri
}

let lastFridayRun = null;
let lastMondayRun = null;

async function checkReminders() {
  const now = new Date();
  const pacificDay  = getPacificDay(now);
  const pacificHour = getPacificHour(now);
  // Use Pacific date string as the dedup key so we only run once per day
  const offsetHours = (now.getUTCMonth() >= 2 && now.getUTCMonth() <= 10) ? 7 : 8;
  const pacificDate = new Date(now.getTime() - offsetHours * 60 * 60 * 1000);
  const dateKey = pacificDate.toISOString().split('T')[0];

  // Friday 6pm Pacific
  if (pacificDay === 5 && pacificHour >= 18 && pacificHour < 19 && lastFridayRun !== dateKey) {
    lastFridayRun = dateKey;
    console.log(`Running Friday 6pm Pacific reminder (UTC hour: ${now.getUTCHours()})`);
    await runFridayReminder();
  }

  // Monday 10am Pacific
  if (pacificDay === 1 && pacificHour >= 10 && pacificHour < 11 && lastMondayRun !== dateKey) {
    lastMondayRun = dateKey;
    console.log(`Running Monday 10am Pacific reminder (UTC hour: ${now.getUTCHours()})`);
    await runMondayReminder();
  }
}

// Friday 6pm: one admin summary email + individual employee reminders
async function runFridayReminder() {
  try {
    const appUrl = process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : 'https://hri-app-production.up.railway.app';
    const weekStart = getWeekStart(new Date());
    const submitted = await getTimecardsByWeek(weekStart);
    const submittedNames = submitted.filter(t => t.status === 'submitted').map(t => t.employee_name.toLowerCase());
    const crew = await getCrewForReminders();
    const missing = crew.filter(p =>
      !submittedNames.includes(p.name.toLowerCase()) &&
      !submittedNames.includes(p.nickname.toLowerCase())
    );

    if (!missing.length) { console.log('Friday 6pm: all submitted — no emails needed'); return; }

    const managers   = await getPeople('manager');
    const bookkeepers = await getPeople('bookkeeper');
    const managerEmails    = managers.filter(m => m.email).map(m => m.email);
    const bookeeperEmails  = bookkeepers.filter(b => b.email).map(b => b.email);
    const adminEmails = [...new Set([...managerEmails, ...bookeeperEmails])];

    // One condensed admin summary email
    const missingNames = missing.map(p => p.name);
    const html = emailAdminSummary(missingNames, 'friday', appUrl);
    await sendMail(
      adminEmails,
      `⏰ Time Cards Not Yet Submitted — ${missing.length} employee${missing.length > 1 ? 's' : ''} (Friday reminder)`,
      html
    );
    console.log(`Friday admin summary sent to ${adminEmails.length} admin(s) — ${missing.length} missing`);

    // Individual reminder to each employee
    for (const p of missing) {
      if (!p.email) continue;
      const empHtml = emailMondayReminderEmployee(p.nickname, weekStart, appUrl);
      await sendMail(p.email, '⏰ Reminder — please submit your time card today', empHtml, managerEmails);
    }
    console.log(`Friday employee reminders sent — ${missing.filter(p => p.email).length} with email`);
  } catch (e) {
    console.error('Friday reminder error:', e.message);
  }
}

// Monday 10am: one admin summary email + individual employee overdue notices
async function runMondayReminder() {
  try {
    const appUrl = process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : 'https://hri-app-production.up.railway.app';
    const prevWeek = getPrevWeekStart();
    const submitted = await getTimecardsByWeek(prevWeek);
    const submittedNames = submitted.filter(t => t.status === 'submitted').map(t => t.employee_name.toLowerCase());
    const crew = await getCrewForReminders();
    const missing = crew.filter(p =>
      !submittedNames.includes(p.name.toLowerCase()) &&
      !submittedNames.includes(p.nickname.toLowerCase())
    );

    if (!missing.length) { console.log('Monday 10am: all submitted — no emails needed'); return; }

    const managers    = await getPeople('manager');
    const bookkeepers = await getPeople('bookkeeper');
    const managerEmails   = managers.filter(m => m.email).map(m => m.email);
    const bookeeperEmails = bookkeepers.filter(b => b.email).map(b => b.email);
    const adminEmails = [...new Set([...managerEmails, ...bookeeperEmails])];

    // One condensed admin summary email
    const missingNames = missing.map(p => p.name);
    const html = emailAdminSummary(missingNames, 'monday', appUrl);
    await sendMail(
      adminEmails,
      `🚨 OVERDUE — ${missing.length} time card${missing.length > 1 ? 's' : ''} not submitted (Monday follow-up)`,
      html
    );
    console.log(`Monday admin summary sent to ${adminEmails.length} admin(s) — ${missing.length} overdue`);

    // Individual overdue notice to each employee
    for (const p of missing) {
      if (!p.email) continue;
      const empHtml = emailMondayReminderEmployee(p.nickname, prevWeek, appUrl);
      await sendMail(p.email, '⚠ Your time card is overdue — please submit now', empHtml, managerEmails);
    }
    console.log(`Monday employee overdue notices sent — ${missing.filter(p => p.email).length} with email`);
  } catch (e) {
    console.error('Monday reminder error:', e.message);
  }
}

function startScheduler() {
  setInterval(checkReminders, 30 * 60 * 1000);
  console.log('  Reminder scheduler started.');
}

module.exports = { startScheduler };
