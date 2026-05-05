require('dotenv').config();
const http    = require('http');
const fs      = require('fs');
const path    = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');
const db      = require('./db');
const { sendMail, emailSubmitted } = require('./lib/email');
const { startScheduler } = require('./lib/scheduler');
const { buildExportRows, rowsToCSV } = require('./lib/qbexport');

const app  = express();
const PORT = process.env.PORT || 8080;

// Railway proxy support — needed for WebSocket upgrades and correct host detection
app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const ADMIN_PW = process.env.ADMIN_PASSWORD || 'hri2024';

function appUrl() {
  return process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : `http://localhost:${PORT}`;
}

function requireAdmin(req, res, next) {
  const pw = req.query.pw || req.headers['x-admin-pw'];
  if (pw !== ADMIN_PW) return res.status(401).render('admin-login', { error: pw ? 'Wrong password' : null });
  next();
}

// ══════════════════════════════════════════════════════════════════════════════
//  JOB BOARD — serves the original index.html at /
// ══════════════════════════════════════════════════════════════════════════════
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'jobboard.html'));
});

// ══════════════════════════════════════════════════════════════════════════════
//  TIME CARD — employee form
// ══════════════════════════════════════════════════════════════════════════════
app.get('/timecard', async (req, res) => {
  try {
    const people  = await db.getPeople();
    const crew    = people.filter(p => p.role === 'crew' || p.role === 'manager');
    const boardData = await db.loadBoardData();
    const jobs    = boardData.jobs || [];
    res.render('timecard', { crew, jobs, error: null });
  } catch (e) {
    console.error(e);
    res.status(500).send('Error loading timecard');
  }
});

// Load draft for employee + week
app.get('/timecard/draft', async (req, res) => {
  const { name, week } = req.query;
  if (!name || !week) return res.json(null);
  try {
    const draft = await db.getDraftForEmployee(name, week);
    res.json(draft);
  } catch (e) {
    res.json(null);
  }
});

// Auto-save draft
app.post('/timecard/save', async (req, res) => {
  try {
    const tcId = await db.upsertTimecard({ ...req.body, status: 'draft' });
    res.json({ ok: true, id: tcId });
  } catch (e) {
    console.error('Save error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Check for mismatches before final submit
app.post('/timecard/check', async (req, res) => {
  try {
    const boardData = await db.loadBoardData();
    const jobs  = boardData.jobs || [];
    const flags = [];
    for (const row of (req.body.rows || [])) {
      if (!row.job_name || row.is_nonbill || row.is_office || row.is_new_job) continue;
      if ((parseFloat(row.total_hrs)||0) <= 0) continue;
      const match = jobs.find(j =>
        j.name && row.job_name.toLowerCase().includes(j.name.split(',')[0].toLowerCase())
      );
      if (!match) {
        flags.push({ flag_type: 'unmatched', job_name: row.job_name, hours: row.total_hrs,
          description: "Job name doesn't match anything in the Job Board" });
      } else if (parseInt(match.comp||0) >= 100) {
        flags.push({ flag_type: 'closed', job_name: row.job_name, hours: row.total_hrs,
          description: 'Job is marked complete in the Job Board' });
      }
      // Assignment check (crew names in board cells for that job)
      const empName = req.body.employee_name || '';
      const jobIdx  = jobs.indexOf(match);
      const allDays = ['Monday','Tuesday','Wednesday','Thursday','Friday','Sat/Sun'];
      let assigned  = false;
      for (const day of allDays) {
        const key = `${jobIdx}_${day}`;
        const cell = boardData.cells && boardData.cells[key];
        if (cell && cell.names && cell.names.some(n =>
          empName.toLowerCase().includes(n.toLowerCase()) || n.toLowerCase().includes(empName.split(' ')[0].toLowerCase())
        )) { assigned = true; break; }
      }
      if (!assigned && match && parseInt(match.comp||0) < 100) {
        // Only flag unassigned if not already flagged as unmatched/closed
        if (!flags.find(f => f.job_name === row.job_name)) {
          flags.push({ flag_type: 'unassigned', job_name: row.job_name, hours: row.total_hrs,
            description: 'This job is not assigned to you in the Job Board' });
        }
      }
    }
    res.json({ flags });
  } catch (e) {
    res.status(500).json({ flags: [], error: e.message });
  }
});

// Final submit
app.post('/timecard/submit', async (req, res) => {
  try {
    const { flags, ...data } = req.body;
    const tcId = await db.upsertTimecard({ ...data, status: 'submitted' });
    await db.submitTimecard(tcId, flags || []);
    const tc   = await db.getTimecardDetail(tcId);
    const mgrs = await db.getPeople('manager');
    const mgEmails = mgrs.filter(m => m.email).map(m => m.email);
    const bks  = await db.getPeople('bookkeeper');
    const bkEmails = bks.filter(b => b.email).map(b => b.email);
    const toEmails = [...mgEmails, ...bkEmails];
    if (toEmails.length) {
      sendMail(toEmails, `Time Card: ${tc.employee_name} — Week of ${fmtDateShort(tc.week_start)}`,
        emailSubmitted(tc, appUrl())).catch(e => console.error('Email error:', e.message));
    }
    res.json({ ok: true, id: tcId });
  } catch (e) {
    console.error('Submit error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Success page
app.get('/timecard/success', (req, res) => {
  res.render('success', { id: req.query.id, name: req.query.name, week: req.query.week, hrs: req.query.hrs });
});

// ══════════════════════════════════════════════════════════════════════════════
//  ADMIN DASHBOARD
// ══════════════════════════════════════════════════════════════════════════════
app.get('/admin', requireAdmin, async (req, res) => {
  try {
    const weeks = await db.getWeeksWithTimecards();
    const weekStart = req.query.week || (weeks[0] ? weeks[0].week_start.toISOString().split('T')[0] : null);
    let timecards = [], crew = [], crossref = [];
    if (weekStart) {
      timecards = await db.getTimecardsByWeek(weekStart);
      crew = await db.getPeople('crew');
      crossref = await db.getCrossRef(weekStart);
    }
    const submitted  = timecards.filter(t => t.status === 'submitted');
    const drafts     = timecards.filter(t => t.status === 'draft');
    const subNames   = timecards.map(t => t.employee_name.toLowerCase());
    const notStarted = crew.filter(p =>
      !subNames.includes(p.name.toLowerCase()) && !subNames.includes(p.nickname.toLowerCase())
    );
    res.render('admin', { pw: ADMIN_PW, weeks, selectedWeek: weekStart,
      submitted, drafts, notStarted, crossref, timecards });
  } catch (e) {
    console.error(e);
    res.status(500).send('Error loading admin');
  }
});

app.get('/admin/login', (req, res) => res.render('admin-login', { error: null }));
app.post('/admin/login', (req, res) => {
  if (req.body.pw === ADMIN_PW) return res.redirect(`/admin?pw=${ADMIN_PW}`);
  res.render('admin-login', { error: 'Wrong password' });
});

app.get('/admin/timecard/:id', requireAdmin, async (req, res) => {
  try {
    const tc = await db.getTimecardDetail(req.params.id);
    if (!tc) return res.status(404).send('Not found');
    res.render('admin-detail', { tc, pw: ADMIN_PW });
  } catch (e) { res.status(500).send('Error'); }
});

// ── TWEAK 4: Employee management ──────────────────────────────────────────────
app.get('/admin/employees', requireAdmin, async (req, res) => {
  try {
    const people = await db.getPeople();
    res.render('admin-employees', { pw: ADMIN_PW, people });
  } catch(e) { res.status(500).send('Error'); }
});

app.post('/admin/employees/add', requireAdmin, async (req, res) => {
  try {
    const person = await db.addPerson(req.body);
    // Sync new employee nickname to Job Board crew list
    const boardData = await db.loadBoardData();
    if (!boardData.crew.includes(person.nickname)) {
      boardData.crew.push(person.nickname);
      await db.saveBoardData(boardData);
      // Broadcast updated crew to all connected Job Board clients
      broadcastAll({ type: 'update_crew', crew: boardData.crew });
    }
    res.json({ ok: true, person });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/admin/employees/:id/update', requireAdmin, async (req, res) => {
  try {
    await db.updatePerson(req.params.id, req.body);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/admin/employees/:id/deactivate', requireAdmin, async (req, res) => {
  try {
    await db.deactivatePerson(req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/admin/person/:id/email', requireAdmin, async (req, res) => {
  await db.updatePersonEmail(req.params.id, req.body.email || '');
  res.json({ ok: true });
});

// ── TWEAK 5: Customer address/phone update ────────────────────────────────────
app.post('/admin/customer/update', requireAdmin, async (req, res) => {
  try {
    const { jobName, address, phone } = req.body;
    const boardData = await db.loadBoardData();
    const job = boardData.jobs.find(j => j.name === jobName);
    if (job) {
      job.address = address || '';
      job.phone   = phone   || '';
      await db.saveBoardData(boardData);
      // Update in-memory state and broadcast
      appData = boardData;
      broadcastAll({ type: 'full_refresh', data: appData });
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// QB Export
app.get('/admin/export', requireAdmin, async (req, res) => {
  try {
    const weeks  = await db.getWeeksWithTimecards();
    const weekStart = req.query.week || (weeks[0] ? weeks[0].week_start.toISOString().split('T')[0] : null);
    const rows   = weekStart ? await buildExportRows(weekStart) : [];
    res.render('qb-export', { pw: ADMIN_PW, weeks, selectedWeek: weekStart, rows });
  } catch (e) { res.status(500).send('Error'); }
});

app.get('/admin/export/csv', requireAdmin, async (req, res) => {
  const { week } = req.query;
  if (!week) return res.status(400).send('week required');
  const rows = await buildExportRows(week);
  const csv  = rowsToCSV(rows);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="HRI_Timecards_${week}.csv"`);
  res.send(csv);
});

// My assignments (employee self-check)
app.get('/my-assignments', async (req, res) => {
  try {
    const weeks = await db.getWeeksWithTimecards();
    const { name, week } = req.query;
    let myRows = [];
    if (name && week) {
      const all = await db.getCrossRef(week);
      myRows = all.filter(r => r.employee_name.toLowerCase().includes(name.toLowerCase()));
    }
    res.render('my-assignments', { weeks, selectedWeek: week||'', employeeName: name||'', myRows });
  } catch (e) { res.status(500).send('Error'); }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ══════════════════════════════════════════════════════════════════════════════
//  JOB BOARD WEBSOCKET (exact same logic as original)
// ══════════════════════════════════════════════════════════════════════════════
const httpServer = http.createServer(app);
const wss = new WebSocketServer({ 
  server: httpServer,
  perMessageDeflate: false // disable compression for Railway proxy compatibility
});

// Explicitly handle WebSocket upgrade requests (needed for some Railway configs)
httpServer.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});
const clients = new Set();
let appData = null;

function sortJobsByCode(jobs) {
  return [...jobs].sort((a, b) => {
    const ac = (a.code||'').trim().toUpperCase();
    const bc = (b.code||'').trim().toUpperCase();
    if (!ac && !bc) return 0; if (!ac) return 1; if (!bc) return -1;
    return ac < bc ? -1 : ac > bc ? 1 : 0;
  });
}

function broadcast(msg, exclude) {
  const txt = JSON.stringify(msg);
  clients.forEach(ws => { if (ws !== exclude && ws.readyState === 1) ws.send(txt); });
}
function broadcastAll(msg) {
  const txt = JSON.stringify(msg);
  clients.forEach(ws => { if (ws.readyState === 1) ws.send(txt); });
}

wss.on('connection', ws => {
  clients.add(ws);
  ws.send(JSON.stringify({ type: 'init', data: appData }));
// Find the line:  ws.on('message', async raw => {
// and replace the entire block (ending with the matching  }); ) with:
// ══════════════════════════════════════════════════════════════════════════════

  ws.on('message', async raw => {
    let msg; try { msg = JSON.parse(raw); } catch(e) { return; }

    if (msg.type === 'update_cell') {
      const wk = msg.weekKey || 'legacy';
      if (!appData.weeks) appData.weeks = {};
      if (!appData.weeks[wk]) appData.weeks[wk] = { cells:{}, pinnedCells:{}, label:'' };
      appData.weeks[wk].cells[msg.key] = msg.cell;
      if (!appData.cells) appData.cells = {};
      appData.cells[msg.key] = msg.cell;
      await db.saveBoardData(appData);
      broadcast({ type: 'update_cell', weekKey: wk, key: msg.key, cell: msg.cell }, ws);

    } else if (msg.type === 'update_pinned_cell') {
      const wk = msg.weekKey || 'legacy';
      if (!appData.weeks) appData.weeks = {};
      if (!appData.weeks[wk]) appData.weeks[wk] = { cells:{}, pinnedCells:{}, label:'' };
      appData.weeks[wk].pinnedCells[msg.key] = msg.cell;
      if (!appData.pinnedCells) appData.pinnedCells = {};
      appData.pinnedCells[msg.key] = msg.cell;
      await db.saveBoardData(appData);
      broadcast({ type: 'update_pinned_cell', weekKey: wk, key: msg.key, cell: msg.cell }, ws);

    } else if (msg.type === 'update_week_label') {
      if (!appData.weeks) appData.weeks = {};
      if (!appData.weeks[msg.weekKey]) appData.weeks[msg.weekKey] = { cells:{}, pinnedCells:{}, label:'' };
      appData.weeks[msg.weekKey].label = msg.value;
      await db.saveBoardData(appData);
      broadcast({ type: 'update_week_label', weekKey: msg.weekKey, value: msg.value }, ws);

    } else if (msg.type === 'migrate_weeks') {
      appData.weeks = msg.weeks;
      await db.saveBoardData(appData);

    } else if (msg.type === 'update_job') {
      if (appData.jobs[msg.idx]) {
        appData.jobs[msg.idx][msg.field] = msg.value;
        if (msg.field === 'code') {
          appData.jobs = sortJobsByCode(appData.jobs);
          await db.saveBoardData(appData);
          broadcastAll({ type: 'full_refresh', data: appData }); return;
        }
        await db.saveBoardData(appData);
        broadcast({ type: 'update_job', idx: msg.idx, field: msg.field, value: msg.value }, ws);
      }

    } else if (msg.type === 'update_week') {
      appData.weekLabel = msg.value;
      await db.saveBoardData(appData);
      broadcast({ type: 'update_week', value: msg.value }, ws);

    } else if (msg.type === 'update_crew') {
      appData.crew = msg.crew;
      await db.saveBoardData(appData);
      broadcast({ type: 'update_crew', crew: msg.crew }, ws);

    } else if (msg.type === 'add_job') {
      appData.jobs.push({ name: 'New Customer', code: '', ins: '', est: '', comp: '', notes: '' });
      appData.jobs = sortJobsByCode(appData.jobs);
      await db.saveBoardData(appData);
      broadcastAll({ type: 'full_refresh', data: appData });

    } else if (msg.type === 'delete_job') {
      appData.jobs.splice(msg.idx, 1);
      if (appData.weeks) {
        Object.keys(appData.weeks).forEach(wk => {
          const newCells = {};
          Object.keys(appData.weeks[wk].cells||{}).forEach(k => {
            const u=k.indexOf('_'); const ni=parseInt(k.substring(0,u)); const day=k.substring(u+1);
            if(ni<msg.idx) newCells[k]=appData.weeks[wk].cells[k];
            else if(ni>msg.idx) newCells[(ni-1)+'_'+day]=appData.weeks[wk].cells[k];
          });
          appData.weeks[wk].cells = newCells;
        });
      }
      const newCells={};
      Object.keys(appData.cells||{}).forEach(k=>{
        const u=k.indexOf('_');const ni=parseInt(k.substring(0,u));const day=k.substring(u+1);
        if(ni<msg.idx) newCells[k]=appData.cells[k];
        else if(ni>msg.idx) newCells[(ni-1)+'_'+day]=appData.cells[k];
      });
      appData.cells=newCells;
      await db.saveBoardData(appData);
      broadcastAll({ type: 'full_refresh', data: appData });
    }
  });
  ws.on('close', () => clients.delete(ws));
});

function fmtDateShort(d) {
  if (!d) return '—';
  return new Date(d+'T12:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric'});
}

// ── Start ─────────────────────────────────────────────────────────────────────
async function start() {
  try {
    await db.initDB();
    appData = await db.loadBoardData();
    startScheduler();
    httpServer.listen(PORT, () => {
      console.log('');
      console.log('  Fire Water Storm app running on port ' + PORT);
      console.log('  Job Board  →  /');
      console.log('  Time Card  →  /timecard');
      console.log('  Admin      →  /admin');
      console.log('');
    });
  } catch (e) {
    console.error('Startup error:', e);
    process.exit(1);
  }
}

start();
