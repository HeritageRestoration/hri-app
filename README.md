# Fire Water Storm — Job Board + Time Card App

One Railway deployment. One URL. Two tools for your crew.

- `/` — Job Board (real-time, unchanged from existing)
- `/timecard` — Employee Time Card
- `/admin` — Manager dashboard
- `/my-assignments` — Employee self-check

---

## Deploy to Railway

### 1 — Upload to GitHub
1. Create a new repo at github.com named `hri-app`
2. Unzip this file and upload all contents
3. Commit

### 2 — Deploy on Railway
1. Go to railway.app → New Project → Deploy from GitHub → select `hri-app`
2. Railway detects Node.js automatically

### 3 — Add PostgreSQL
In Railway project → + New → Database → PostgreSQL
`DATABASE_URL` is set automatically.

### 4 — Migrate from existing Job Board
If you have an existing Job Board database on Railway:
- Go to Railway → your existing Job Board service → Variables → copy `DATABASE_URL`
- Paste it as `DATABASE_URL` in this new service
- Your Job Board data (jobs, crew assignments) will carry over automatically

### 5 — Set environment variables
Railway → your service → Variables:

| Variable | Value |
|---|---|
| `MS_TENANT_ID` | Azure App Registration → Directory (tenant) ID |
| `MS_CLIENT_ID` | Azure App Registration → Application (client) ID |
| `MS_CLIENT_SECRET` | Azure App Registration → Certificates & secrets |
| `MS_SENDER_EMAIL` | M365 sender mailbox (e.g. timecards@firewaterstorm.com) |
| `ADMIN_PASSWORD` | Choose a strong password for /admin |
| `COMPANY_NAME` | Fire Water Storm |

---

## Email reminders
- **Friday 4pm** — manager email listing crew who haven't submitted
- **Monday 9am** — direct email to each crew member + CC managers + bookkeeper

Powered by Microsoft 365 Graph API (see Azure setup in timecard app README).

---

## People pre-loaded
All 16 crew members, managers, and bookkeeper are seeded on first startup.
Emails can be updated in the admin dashboard or by employees on their timecard.

---

## Updating job names
Edit the `jobs` array in the Job Board directly (it's editable in the UI).
The timecard dropdown pulls live from the Job Board's database.

---

## Local development
```bash
npm install
cp .env.example .env   # fill in credentials
npm run dev            # http://localhost:3000
```
