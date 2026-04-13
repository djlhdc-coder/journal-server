require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const fetch    = require('node-fetch');
const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────────
//  DATABASE SETUP
// ─────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'journal.db'));

// Create tables on first run
db.exec(`
  CREATE TABLE IF NOT EXISTS participants (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS entries (
    id           TEXT PRIMARY KEY,
    participant  TEXT NOT NULL DEFAULT 'humberto',
    date         TEXT NOT NULL,
    fields       TEXT NOT NULL DEFAULT '{}',
    messages     TEXT NOT NULL DEFAULT '[]',
    visits       INTEGER NOT NULL DEFAULT 1,
    finalized    INTEGER NOT NULL DEFAULT 0,
    finalized_at TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS today_state (
    participant  TEXT PRIMARY KEY,
    date         TEXT NOT NULL,
    state        TEXT NOT NULL,
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// ─────────────────────────────────────────────
//  MIDDLEWARE
// ─────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Simple auth — checks for app secret in header
function requireAuth(req, res, next) {
  const secret = process.env.APP_SECRET;
  if (!secret || secret === 'change-this-to-a-random-secret-string') {
    // No secret configured — allow all (development mode)
    return next();
  }
  const provided = req.headers['x-app-secret'];
  if (provided !== secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ─────────────────────────────────────────────
//  ANTHROPIC API PROXY
//  The key lives on the server — never exposed to the browser
// ─────────────────────────────────────────────
app.post('/api/claude', requireAuth, async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey || apiKey === 'YOUR_API_KEY_HERE') {
    return res.status(503).json({
      error: 'API key not configured on server. Add ANTHROPIC_API_KEY to your environment variables.'
    });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':    'application/json',
        'x-api-key':       apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(req.body),
    });

    const data = await response.json();
    res.status(response.status).json(data);

  } catch (err) {
    console.error('Claude API error:', err);
    res.status(500).json({ error: 'Failed to reach Anthropic API', detail: err.message });
  }
});

// ─────────────────────────────────────────────
//  TODAY STATE — persists the running daily log
// ─────────────────────────────────────────────

// GET current day state
app.get('/api/state/:participant', requireAuth, (req, res) => {
  const { participant } = req.params;
  const row = db.prepare('SELECT * FROM today_state WHERE participant = ?').get(participant);

  if (!row) return res.json({ exists: false });

  const today = new Date().toISOString().split('T')[0];
  const state = JSON.parse(row.state);

  // If state is from a previous day, return nothing (fresh day)
  if (state.date !== today) return res.json({ exists: false });

  res.json({ exists: true, state });
});

// PUT update day state (called on every message exchange)
app.put('/api/state/:participant', requireAuth, (req, res) => {
  const { participant } = req.params;
  const { state } = req.body;

  if (!state) return res.status(400).json({ error: 'state required' });

  db.prepare(`
    INSERT INTO today_state (participant, date, state, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(participant) DO UPDATE SET
      date       = excluded.date,
      state      = excluded.state,
      updated_at = excluded.updated_at
  `).run(participant, state.date, JSON.stringify(state));

  res.json({ ok: true });
});

// ─────────────────────────────────────────────
//  JOURNAL ENTRIES
// ─────────────────────────────────────────────

// GET all finalized entries for a participant
app.get('/api/entries/:participant', requireAuth, (req, res) => {
  const { participant } = req.params;
  const rows = db.prepare(`
    SELECT id, date, fields, visits, finalized, finalized_at, created_at, updated_at
    FROM entries
    WHERE participant = ? AND finalized = 1
    ORDER BY date DESC
  `).all(participant);

  const entries = rows.map(r => ({
    ...r,
    fields:    JSON.parse(r.fields),
    finalized: !!r.finalized,
  }));

  res.json(entries);
});

// GET a single entry with full message history
app.get('/api/entries/:participant/:date', requireAuth, (req, res) => {
  const { participant, date } = req.params;
  const row = db.prepare(`
    SELECT * FROM entries WHERE participant = ? AND date = ?
  `).get(participant, date);

  if (!row) return res.status(404).json({ error: 'Entry not found' });

  res.json({
    ...row,
    fields:    JSON.parse(row.fields),
    messages:  JSON.parse(row.messages),
    finalized: !!row.finalized,
  });
});

// POST finalize and save a completed entry
app.post('/api/entries/:participant', requireAuth, (req, res) => {
  const { participant } = req.params;
  const { date, fields, messages, visits } = req.body;

  if (!date || !fields) return res.status(400).json({ error: 'date and fields required' });

  const id = `${participant}-${date}`;

  db.prepare(`
    INSERT INTO entries (id, participant, date, fields, messages, visits, finalized, finalized_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      fields       = excluded.fields,
      messages     = excluded.messages,
      visits       = excluded.visits,
      finalized    = 1,
      finalized_at = excluded.finalized_at,
      updated_at   = excluded.updated_at
  `).run(
    id, participant, date,
    JSON.stringify(fields),
    JSON.stringify(messages || []),
    visits || 1
  );

  res.json({ ok: true, id });
});

// ─────────────────────────────────────────────
//  RESEARCH EXPORT
//  Returns all entries as structured JSON for analysis
// ─────────────────────────────────────────────
app.get('/api/export/:participant', requireAuth, (req, res) => {
  const { participant } = req.params;
  const rows = db.prepare(`
    SELECT * FROM entries WHERE participant = ? AND finalized = 1 ORDER BY date ASC
  `).all(participant);

  const entries = rows.map(r => ({
    date:         r.date,
    visits:       r.visits,
    finalized_at: r.finalized_at,
    fields:       JSON.parse(r.fields),
  }));

  // Compute summary metrics
  const metrics = computeMetrics(entries);

  res.json({
    participant,
    exported_at:    new Date().toISOString(),
    total_entries:  entries.length,
    metrics,
    entries,
  });
});

function computeMetrics(entries) {
  if (!entries.length) return {};

  const f = entries.map(e => e.fields);

  const doseAdherence = pct(f, e =>
    e.DOSE_1_TAKEN === 'yes' && e.DOSE_2_TAKEN === 'yes');

  const exerciseRate = pct(f, e =>
    e.DOSE_1_EXERCISE === 'yes' || e.DOSE_2_EXERCISE === 'yes');

  const gapCompliance = pct(
    f.filter(e => e.DOSE_1_EXERCISE === 'yes'),
    e => e.DOSE_1_GAP_OK === 'yes'
  );

  const avgMood    = avg(f, e => parseFloat(e.MOOD));
  const avgEnergy  = avg(f, e => parseFloat(e.ENERGY));
  const avgSleep   = avg(f, e => parseFloat(e.SLEEP_HRS));

  const psaReadings = f
    .filter(e => e.PSA && e.PSA !== 'none' && e.PSA !== 'N/A')
    .map(e => ({ date: e.DATE, value: parseFloat(e.PSA) }))
    .filter(e => !isNaN(e.value));

  return {
    total_days:          entries.length,
    dose_adherence_pct:  doseAdherence,
    exercise_rate_pct:   exerciseRate,
    gap_compliance_pct:  gapCompliance,
    avg_mood:            avgMood,
    avg_energy:          avgEnergy,
    avg_sleep_hours:     avgSleep,
    psa_readings:        psaReadings,
    psa_count:           psaReadings.length,
    psa_first:           psaReadings[0]?.value ?? null,
    psa_last:            psaReadings[psaReadings.length - 1]?.value ?? null,
    psa_delta:           psaReadings.length >= 2
                           ? psaReadings[psaReadings.length - 1].value - psaReadings[0].value
                           : null,
  };
}

function pct(arr, fn) {
  if (!arr.length) return null;
  const count = arr.filter(fn).length;
  return Math.round((count / arr.length) * 100);
}

function avg(arr, fn) {
  const vals = arr.map(fn).filter(v => !isNaN(v));
  if (!vals.length) return null;
  return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10;
}

// ─────────────────────────────────────────────
//  HEALTH CHECK
// ─────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  const apiConfigured = !!(process.env.ANTHROPIC_API_KEY &&
    process.env.ANTHROPIC_API_KEY !== 'YOUR_API_KEY_HERE');
  res.json({
    status:         'ok',
    api_configured: apiConfigured,
    time:           new Date().toISOString(),
  });
});

// ─────────────────────────────────────────────
//  SERVE APP — all non-API routes return index.html
// ─────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─────────────────────────────────────────────
//  START
// ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Journal server running on port ${PORT}`);
  console.log(`API key configured: ${!!(process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY !== 'YOUR_API_KEY_HERE')}`);
});
