const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
    ? { rejectUnauthorized: false } : false
});

const PEOPLE = [
  { name: 'Kevin Godfrey',              nickname: 'Kevin',   role: 'manager',    email: 'kevin@firewaterstorm.com',        phone: '' },
  { name: 'Todd Custer',                nickname: 'Todd',    role: 'manager',    email: 'todd@firewaterstorm.com',          phone: '360-508-0796' },
  { name: 'Laura Payne',                nickname: 'Laura',   role: 'bookkeeper', email: 'laura@firewaterstorm.com',         phone: '434-270-1509' },
  { name: 'Aaron Elkins',               nickname: 'Aaron',   role: 'crew',       email: 'pvtelkins42@gmail.com',           phone: '360-506-1203' },
  { name: 'Alberto Gonzalez',           nickname: 'Alberto', role: 'crew',       email: 'noahezra9@gmail.com',             phone: '360-999-2362' },
  { name: 'Angela Perschon',            nickname: 'Angie',   role: 'crew',       email: 'angieperschon@gmail.com',         phone: '360-520-1518' },
  { name: 'Bennett Yanajai',            nickname: 'Bennett', role: 'crew',       email: 'yanajaib@gmail.com',              phone: '480-414-5011' },
  { name: 'Eduardo Herrera Montealegre',nickname: 'Lalo',    role: 'crew',       email: 'healdsburg1984@gmail.com',        phone: '707-596-1402' },
  { name: 'Gerardo Bautista Dominguez', nickname: 'Gerardo', role: 'crew',       email: 'bautista_ma@hotmail.com',         phone: '503-975-0071' },
  { name: 'Joshua Kunkel',              nickname: 'Joshua',  role: 'crew',       email: 'MrJoshuaK45@gmail.com',           phone: '360-508-3907' },
  { name: 'Kelie Wurden',               nickname: 'Kelie',   role: 'crew',       email: 'Keliewurden@gmail.com',           phone: '' },
  { name: 'Kelly Hoel',                 nickname: 'Kelly',   role: 'crew',       email: 'hoel.kelly@gmail.com',            phone: '360-239-5522' },
  { name: 'Nicholas Godfrey',           nickname: 'Nick',    role: 'crew',       email: 'godfreyn2004@gmail.com',          phone: '360-827-5356' },
  { name: 'Patrick Moniz',              nickname: 'Rick',    role: 'crew',       email: 'mon4195@gmail.com',               phone: '253-921-1993' },
  { name: 'Theodore Huestis',           nickname: 'Ted',     role: 'crew',       email: 'tedndeb@ymail.com',               phone: '360-880-8845' },
  { name: 'Zachary Burgess',            nickname: 'Zack',    role: 'crew',       email: 'zachanamber1998@centurylink.net', phone: '360-388-1504' },
];

// TWEAK 2+3: All L&I codes in two groups — available on every job row
const LI_CODES = [
  { code: '0521',    label: 'Painting / Paint Prep',      section: 'field' },
  { code: '0513',    label: 'Interior Finish Carpentry',  section: 'field' },
  { code: '0516',    label: 'Building Repair & Remodel',  section: 'field' },
  { code: '6602',    label: 'Cleaning',                   section: 'field' },
  { code: '4904',    label: 'Clerical',                   section: 'office' },
  { code: '4900',    label: 'Project Manager',            section: 'office' },
  { code: '4911',    label: 'Estimator',                  section: 'office' },
  { code: '6303',    label: 'Sales',                      section: 'office' },
  { code: '9999',    label: 'Legal',                      section: 'office' }, // TWEAK 3
  { code: '0521-BU', label: 'Board-Up',                   section: 'boardup' },
];

// TWEAK 1+2: Leave types including KOS and Lack of Work
const LEAVE_TYPES = [
  { value: 'Vacation',      label: 'Vacation',         paid: true  },
  { value: 'Sick',          label: 'Sick',             paid: true  },
  { value: 'Holiday',       label: 'Holiday',          paid: true  },
  { value: 'KOS',           label: 'KOS (Kept on Salary)', paid: true  },
  { value: 'Lack of Work',  label: 'Lack of Work',     paid: false }, // excluded from totals & QB
];

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS board_state (
      id   INTEGER PRIMARY KEY DEFAULT 1,
      data JSONB NOT NULL,
      CHECK (id = 1)
    )
  `);

  // TWEAK 4: Add address column to people table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS people (
      id         SERIAL PRIMARY KEY,
      name       TEXT NOT NULL,
      nickname   TEXT NOT NULL,
      role       TEXT NOT NULL,
      email      TEXT,
      phone      TEXT,
      address    TEXT,
      active     BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // Add columns if upgrading existing DB
  await pool.query(`ALTER TABLE people ADD COLUMN IF NOT EXISTS address TEXT`).catch(()=>{});
  await pool.query(`ALTER TABLE people ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT TRUE`).catch(()=>{});

  // TWEAK 5: Add address/phone to jobs inside board_state JSON (no schema change needed)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS timecards (
      id               SERIAL PRIMARY KEY,
      employee_name    TEXT NOT NULL,
      employee_email   TEXT,
      week_start       DATE NOT NULL,
      week_end         DATE NOT NULL,
      status           TEXT NOT NULL DEFAULT 'draft',
      notes            TEXT,
      total_reg_hrs    NUMERIC(6,2) DEFAULT 0,
      total_bu_hrs     NUMERIC(6,2) DEFAULT 0,
      total_leave_hrs  NUMERIC(6,2) DEFAULT 0,
      total_office_hrs NUMERIC(6,2) DEFAULT 0,
      total_kos_hrs    NUMERIC(6,2) DEFAULT 0,
      total_combined   NUMERIC(6,2) DEFAULT 0,
      has_mismatch     BOOLEAN DEFAULT FALSE,
      submitted_at     TIMESTAMPTZ,
      created_at       TIMESTAMPTZ DEFAULT NOW(),
      updated_at       TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE timecards ADD COLUMN IF NOT EXISTS total_kos_hrs NUMERIC(6,2) DEFAULT 0`).catch(()=>{});

  await pool.query(`
    CREATE TABLE IF NOT EXISTS timecard_leave (
      id           SERIAL PRIMARY KEY,
      timecard_id  INTEGER REFERENCES timecards(id) ON DELETE CASCADE,
      day_name     TEXT NOT NULL,
      hours        NUMERIC(5,2) DEFAULT 0,
      leave_type   TEXT,
      is_paid      BOOLEAN DEFAULT TRUE
    )
  `);
  await pool.query(`ALTER TABLE timecard_leave ADD COLUMN IF NOT EXISTS is_paid BOOLEAN DEFAULT TRUE`).catch(()=>{});

  await pool.query(`
    CREATE TABLE IF NOT EXISTS timecard_rows (
      id           SERIAL PRIMARY KEY,
      timecard_id  INTEGER REFERENCES timecards(id) ON DELETE CASCADE,
      section      TEXT NOT NULL,
      job_name     TEXT,
      is_new_job   BOOLEAN DEFAULT FALSE,
      is_office    BOOLEAN DEFAULT FALSE,
      is_nonbill   BOOLEAN DEFAULT FALSE,
      sun NUMERIC(5,2) DEFAULT 0, mon NUMERIC(5,2) DEFAULT 0,
      tue NUMERIC(5,2) DEFAULT 0, wed NUMERIC(5,2) DEFAULT 0,
      thu NUMERIC(5,2) DEFAULT 0, fri NUMERIC(5,2) DEFAULT 0,
      sat NUMERIC(5,2) DEFAULT 0, total_hrs NUMERIC(5,2) DEFAULT 0,
      li_code_1 TEXT, li_hrs_1 NUMERIC(5,2) DEFAULT 0,
      li_code_2 TEXT, li_hrs_2 NUMERIC(5,2) DEFAULT 0,
      after_hours JSONB DEFAULT '{}'
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS timecard_oncall (
      id SERIAL PRIMARY KEY,
      timecard_id INTEGER REFERENCES timecards(id) ON DELETE CASCADE,
      day_name TEXT NOT NULL
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS timecard_flags (
      id SERIAL PRIMARY KEY,
      timecard_id INTEGER REFERENCES timecards(id) ON DELETE CASCADE,
      flag_type TEXT NOT NULL, job_name TEXT,
      hours NUMERIC(5,2), description TEXT, resolved BOOLEAN DEFAULT FALSE
    )
  `);

  // Seed people if empty
  const { rows } = await pool.query('SELECT COUNT(*) FROM people');
  if (parseInt(rows[0].count) === 0) {
    for (const p of PEOPLE) {
      await pool.query(
        'INSERT INTO people (name, nickname, role, email, phone) VALUES ($1,$2,$3,$4,$5)',
        [p.name, p.nickname, p.role, p.email, p.phone]
      );
    }
    console.log('  People seeded.');
  }

  // Seed Job Board if empty
  const jb = await pool.query('SELECT COUNT(*) FROM board_state');
  if (parseInt(jb.rows[0].count) === 0) {
    await pool.query(
      'INSERT INTO board_state (id, data) VALUES (1, $1) ON CONFLICT (id) DO NOTHING',
      [JSON.stringify(getDefaultBoardState())]
    );
    console.log('  Job Board seeded.');
  }

  // TWEAK 1: Migrate cell keys from index-based to name-based
  await migrateCellKeys();

  console.log('  Database ready.');
}

// TWEAK 1: Re-key board cells from "rowIndex_Day" → "jobName_Day"
// Safe to run on every startup — detects if already migrated
async function migrateCellKeys() {
  try {
    const r = await pool.query('SELECT data FROM board_state WHERE id=1');
    if (!r.rows[0]) return;
    const data = r.rows[0].data;
    const jobs = data.jobs || [];
    let changed = false;

    function migrateMap(cells) {
      if (!cells) return {};
      const newCells = {};
      for (const [key, val] of Object.entries(cells)) {
        const under = key.indexOf('_');
        const prefix = key.substring(0, under);
        const day = key.substring(under + 1);
        // If prefix is a number, it's the old index-based format
        if (/^\d+$/.test(prefix)) {
          const idx = parseInt(prefix);
          const jobName = jobs[idx] && jobs[idx].name ? jobs[idx].name : `Job${idx}`;
          const newKey = `${jobName}_${day}`;
          newCells[newKey] = val;
          changed = true;
        } else {
          // Already name-based
          newCells[key] = val;
        }
      }
      return newCells;
    }

    // Migrate top-level cells and pinnedCells (legacy)
    data.cells = migrateMap(data.cells || {});
    data.pinnedCells = data.pinnedCells || {};

    // Migrate weeks structure
    if (data.weeks) {
      for (const wk of Object.keys(data.weeks)) {
        data.weeks[wk].cells = migrateMap(data.weeks[wk].cells || {});
      }
    }

    if (changed) {
      await pool.query('UPDATE board_state SET data=$1 WHERE id=1', [JSON.stringify(data)]);
      console.log('  Cell keys migrated to name-based format.');
    }
  } catch(e) {
    console.error('Cell key migration error (non-fatal):', e.message);
  }
}

function getDefaultBoardState() {
  return {
    weekLabel: '', crew: ['Gerardo','Zack','Todd','Aaron','Nick','Alberto','Lalo','Kelly','Ted','Angie','Joshua','Bennett','Kelie','Rick'],
    jobs: [
      {name:'Stanford, Sharon',         code:'', ins:'', est:'', comp:'', notes:'', address:'', phone:''},
      {name:'Riverside',                code:'', ins:'', est:'', comp:'', notes:'Kitchen Fire', address:'', phone:''},
      {name:'Carter, Destiny',          code:'', ins:'', est:'', comp:'20', notes:'Tree Gig Harbor', address:'', phone:''},
      {name:'Westhill',                 code:'', ins:'', est:'', comp:'', notes:'', address:'', phone:''},
      {name:'Iovanne, Tom',             code:'', ins:'', est:'', comp:'', notes:'', address:'', phone:''},
      {name:'McKerricher, John Shelly', code:'', ins:'', est:'', comp:'', notes:'Oly Wtr', address:'', phone:''},
      {name:'HomesFirst Tri',           code:'', ins:'', est:'', comp:'35', notes:'Triplex fire', address:'', phone:''},
      {name:'Coronel, Ramon',           code:'', ins:'', est:'', comp:'45', notes:'', address:'', phone:''},
      {name:'Dominguez, Diego Linda',   code:'', ins:'', est:'', comp:'', notes:'Fire Winlock', address:'', phone:''},
      {name:'Quality Inn Jack',         code:'', ins:'', est:'', comp:'', notes:'Awning rebuild Lacey', address:'', phone:''},
      {name:'Arney, Debbie',            code:'', ins:'', est:'', comp:'', notes:'', address:'', phone:''},
      {name:'Callen, Jeffery',          code:'', ins:'', est:'', comp:'', notes:'Tree Shelton', address:'', phone:''},
      {name:'Martin Way 1',             code:'', ins:'', est:'', comp:'', notes:'', address:'', phone:''},
      {name:'Martin Way 2',             code:'', ins:'', est:'', comp:'', notes:'', address:'', phone:''},
      {name:'Street, Rick',             code:'', ins:'', est:'', comp:'', notes:'', address:'', phone:''},
      {name:'Fedorko, Tanner',          code:'', ins:'', est:'', comp:'', notes:'Fire Lacey', address:'', phone:''},
    ],
    pinnedCells: {}, cells: {}, weeks: {}
  };
}

async function upsertTimecard(data) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let tcId = data.id;
    if (tcId) {
      await client.query(
        `UPDATE timecards SET employee_name=$1, employee_email=$2, week_start=$3, week_end=$4,
           notes=$5, status=$6, updated_at=NOW() WHERE id=$7`,
        [data.employee_name, data.employee_email||'', data.week_start, data.week_end, data.notes||'', data.status||'draft', tcId]
      );
    } else {
      const r = await client.query(
        `INSERT INTO timecards (employee_name, employee_email, week_start, week_end, notes, status)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [data.employee_name, data.employee_email||'', data.week_start, data.week_end, data.notes||'', data.status||'draft']
      );
      tcId = r.rows[0].id;
    }

    // Replace leave rows — track paid vs unpaid (Lack of Work = unpaid)
    await client.query('DELETE FROM timecard_leave WHERE timecard_id=$1', [tcId]);
    for (const lv of (data.leave||[])) {
      if ((parseFloat(lv.hours)||0) > 0) {
        const isPaid = lv.leave_type !== 'Lack of Work';
        await client.query(
          'INSERT INTO timecard_leave (timecard_id, day_name, hours, leave_type, is_paid) VALUES ($1,$2,$3,$4,$5)',
          [tcId, lv.day_name, parseFloat(lv.hours)||0, lv.leave_type||'', isPaid]
        );
      }
    }

    // Replace job rows
    await client.query('DELETE FROM timecard_rows WHERE timecard_id=$1', [tcId]);
    const DAYS = ['sun','mon','tue','wed','thu','fri','sat'];
    for (const row of (data.rows||[])) {
      const dayVals = DAYS.map(d => parseFloat(row[d])||0);
      const total = dayVals.reduce((a,b)=>a+b, 0);
      await client.query(
        `INSERT INTO timecard_rows
          (timecard_id, section, job_name, is_new_job, is_office, is_nonbill,
           sun, mon, tue, wed, thu, fri, sat, total_hrs,
           li_code_1, li_hrs_1, li_code_2, li_hrs_2, after_hours)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
        [tcId, row.section||'regular', row.job_name||'',
         row.is_new_job===true||row.is_new_job==='true',
         row.is_office===true||row.is_office==='true',
         row.is_nonbill===true||row.is_nonbill==='true',
         ...dayVals, total,
         row.li_code_1||'', parseFloat(row.li_hrs_1)||0,
         row.li_code_2||'', parseFloat(row.li_hrs_2)||0,
         JSON.stringify(row.after_hours||{})]
      );
    }

    // On-call days
    await client.query('DELETE FROM timecard_oncall WHERE timecard_id=$1', [tcId]);
    for (const day of (data.oncall_days||[])) {
      await client.query('INSERT INTO timecard_oncall (timecard_id, day_name) VALUES ($1,$2)', [tcId, day]);
    }

    // Recalc totals — Lack of Work excluded from paid leave total
    const paidLeave = (data.leave||[]).filter(l=>l.leave_type!=='Lack of Work').reduce((s,l)=>s+(parseFloat(l.hours)||0), 0);
    const kosHrs    = (data.leave||[]).filter(l=>l.leave_type==='KOS').reduce((s,l)=>s+(parseFloat(l.hours)||0), 0);
    const regHrs    = (data.rows||[]).filter(r=>r.section==='regular'&&!r.is_office&&!r.is_nonbill).reduce((s,r)=>s+(parseFloat(r.total_hrs)||0), 0);
    const buHrs     = (data.rows||[]).filter(r=>r.section==='boardup').reduce((s,r)=>s+(parseFloat(r.total_hrs)||0), 0);
    const offHrs    = (data.rows||[]).filter(r=>r.is_office).reduce((s,r)=>s+(parseFloat(r.total_hrs)||0), 0);
    const combined  = regHrs + buHrs + paidLeave + offHrs;
    await client.query(
      `UPDATE timecards SET total_reg_hrs=$1, total_bu_hrs=$2, total_leave_hrs=$3,
         total_office_hrs=$4, total_kos_hrs=$5, total_combined=$6, updated_at=NOW() WHERE id=$7`,
      [regHrs, buHrs, paidLeave, offHrs, kosHrs, combined, tcId]
    );

    await client.query('COMMIT');
    return tcId;
  } catch(e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function submitTimecard(tcId, flags) {
  await pool.query(
    `UPDATE timecards SET status='submitted', submitted_at=NOW(), has_mismatch=$1, updated_at=NOW() WHERE id=$2`,
    [flags && flags.length > 0, tcId]
  );
  if (flags && flags.length) {
    await pool.query('DELETE FROM timecard_flags WHERE timecard_id=$1', [tcId]);
    for (const f of flags) {
      await pool.query(
        'INSERT INTO timecard_flags (timecard_id, flag_type, job_name, hours, description) VALUES ($1,$2,$3,$4,$5)',
        [tcId, f.flag_type, f.job_name, parseFloat(f.hours)||0, f.description||'']
      );
    }
  }
}

async function getTimecardDetail(id) {
  const tc    = await pool.query('SELECT * FROM timecards WHERE id=$1', [id]);
  const rows  = await pool.query('SELECT * FROM timecard_rows WHERE timecard_id=$1 ORDER BY id', [id]);
  const leave = await pool.query('SELECT * FROM timecard_leave WHERE timecard_id=$1', [id]);
  const oc    = await pool.query('SELECT day_name FROM timecard_oncall WHERE timecard_id=$1', [id]);
  const flags = await pool.query('SELECT * FROM timecard_flags WHERE timecard_id=$1', [id]);
  if (!tc.rows[0]) return null;
  return { ...tc.rows[0], rows: rows.rows, leave: leave.rows, oncall_days: oc.rows.map(r=>r.day_name), flags: flags.rows };
}

async function getDraftForEmployee(name, weekStart) {
  const r = await pool.query(
    `SELECT id FROM timecards WHERE employee_name=$1 AND week_start=$2 AND status='draft' LIMIT 1`,
    [name, weekStart]
  );
  if (!r.rows[0]) return null;
  return getTimecardDetail(r.rows[0].id);
}

async function getTimecardsByWeek(weekStart) {
  const r = await pool.query(
    'SELECT * FROM timecards WHERE week_start=$1 ORDER BY employee_name, submitted_at DESC',
    [weekStart]
  );
  return r.rows;
}

async function getWeeksWithTimecards() {
  const r = await pool.query(
    `SELECT DISTINCT week_start, week_end, COUNT(*) AS count
     FROM timecards GROUP BY week_start, week_end ORDER BY week_start DESC LIMIT 20`
  );
  return r.rows;
}

async function getCrossRef(weekStart) {
  const r = await pool.query(
    `SELECT t.employee_name, t.id AS timecard_id, tr.job_name,
       tr.total_hrs, tr.li_code_1, tr.li_code_2, tr.is_new_job, b.data AS board_data
     FROM timecards t
     JOIN timecard_rows tr ON tr.timecard_id=t.id
       AND tr.section='regular' AND tr.total_hrs > 0
       AND tr.is_nonbill=FALSE AND tr.is_new_job=FALSE
     CROSS JOIN board_state b WHERE t.week_start=$1`,
    [weekStart]
  );
  const results = [];
  for (const row of r.rows) {
    const jobs = row.board_data.jobs || [];
    const jobMatch = jobs.find(j => j.name && row.job_name &&
      row.job_name.toLowerCase().includes(j.name.split(',')[0].toLowerCase()));
    let status = 'ok', desc = '';
    if (!jobMatch) { status='unmatched'; desc="Job name doesn't match anything in the Job Board"; }
    else if (jobMatch.comp && parseInt(jobMatch.comp) >= 100) { status='closed'; desc='Job is marked complete in the Job Board'; }
    results.push({ ...row, check_status: status, description: desc });
  }
  return results;
}

async function getPeople(role) {
  const q = role
    ? 'SELECT * FROM people WHERE role=$1 AND active=TRUE ORDER BY name'
    : 'SELECT * FROM people WHERE active=TRUE ORDER BY role, name';
  const r = await pool.query(q, role ? [role] : []);
  return r.rows;
}

async function addPerson(data) {
  const r = await pool.query(
    'INSERT INTO people (name, nickname, role, email, phone, address) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
    [data.name, data.nickname, data.role, data.email||'', data.phone||'', data.address||'']
  );
  return r.rows[0];
}

async function updatePerson(id, data) {
  await pool.query(
    'UPDATE people SET name=$1, nickname=$2, role=$3, email=$4, phone=$5, address=$6 WHERE id=$7',
    [data.name, data.nickname, data.role, data.email||'', data.phone||'', data.address||'', id]
  );
}

async function deactivatePerson(id) {
  await pool.query('UPDATE people SET active=FALSE WHERE id=$1', [id]);
}

async function updatePersonEmail(id, email) {
  await pool.query('UPDATE people SET email=$1 WHERE id=$2', [email, id]);
}

async function loadBoardData() {
  const r = await pool.query('SELECT data FROM board_state WHERE id=1');
  const data = r.rows[0].data;
  if (!data.pinnedCells) data.pinnedCells = {};
  if (!data.weeks) data.weeks = {};
  // Ensure all jobs have address/phone fields (TWEAK 5)
  data.jobs.forEach(j => {
    if (j.code === undefined) j.code = '';
    if (j.address === undefined) j.address = '';
    if (j.phone === undefined) j.phone = '';
  });
  return data;
}

async function saveBoardData(data) {
  await pool.query('UPDATE board_state SET data=$1 WHERE id=1', [JSON.stringify(data)]);
}

module.exports = {
  pool, initDB, PEOPLE, LI_CODES, LEAVE_TYPES,
  upsertTimecard, submitTimecard, getTimecardDetail, getDraftForEmployee,
  getTimecardsByWeek, getWeeksWithTimecards, getCrossRef,
  getPeople, addPerson, updatePerson, deactivatePerson, updatePersonEmail,
  loadBoardData, saveBoardData
};
