require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const fetch    = require('node-fetch');
const { Pool } = require('pg');
const path     = require('path');
 
const app  = express();
const PORT = process.env.PORT || 3000;
 
// ─────────────────────────────────────────────
//  DATABASE SETUP
// ─────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
    ? { rejectUnauthorized: false }
    : false,
});
 
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS participants (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
 
    CREATE TABLE IF NOT EXISTS entries (
      id           TEXT PRIMARY KEY,
      participant  TEXT NOT NULL DEFAULT 'humberto',
      date         TEXT NOT NULL,
      fields       JSONB NOT NULL DEFAULT '{}',
      messages     JSONB NOT NULL DEFAULT '[]',
      visits       INTEGER NOT NULL DEFAULT 1,
      finalized    BOOLEAN NOT NULL DEFAULT FALSE,
      finalized_at TIMESTAMPTZ,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
 
    CREATE TABLE IF NOT EXISTS today_state (
      participant  TEXT PRIMARY KEY,
      date         TEXT NOT NULL,
      state        JSONB NOT NULL,
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  console.log('Database tables ready.');
}
 
initDB().catch(err => {
  console.error('Failed to initialize database:', err);
});
 
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
        'Content-Type':      'application/json',
        'x-api-key':         apiKey,
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
//  TODAY STATE
// ─────────────────────────────────────────────
app.get('/api/state/:participant', requireAuth, async (req, res) => {
  const { participant } = req.params;
  try {
    const result = await pool.query(
      'SELECT * FROM today_state WHERE participant = $1', [participant]
    );
    if (!result.rows.length) return res.json({ exists: false });
 
    const row   = result.rows[0];
    const state = row.state;
    const today = new Date().toISOString().split('T')[0];
 
    if (state.date !== today) return res.json({ exists: false });
 
    res.json({ exists: true, state });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});
 
app.put('/api/state/:participant', requireAuth, async (req, res) => {
  const { participant } = req.params;
  const { state } = req.body;
 
  if (!state) return res.status(400).json({ error: 'state required' });
 
  try {
    await pool.query(`
      INSERT INTO today_state (participant, date, state, updated_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (participant) DO UPDATE SET
        date       = EXCLUDED.date,
        state      = EXCLUDED.state,
        updated_at = NOW()
    `, [participant, state.date, state]);
 
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});
 
// ─────────────────────────────────────────────
//  JOURNAL ENTRIES
// ─────────────────────────────────────────────
app.get('/api/entries/:participant', requireAuth, async (req, res) => {
  const { participant } = req.params;
  try {
    const result = await pool.query(`
      SELECT id, date, fields, visits, finalized, finalized_at, created_at, updated_at
      FROM entries
      WHERE participant = $1 AND finalized = TRUE
      ORDER BY date DESC
    `, [participant]);
 
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});
 
app.get('/api/entries/:participant/:date', requireAuth, async (req, res) => {
  const { participant, date } = req.params;
  try {
    const result = await pool.query(
      'SELECT * FROM entries WHERE participant = $1 AND date = $2',
      [participant, date]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Entry not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});
 
app.post('/api/entries/:participant', requireAuth, async (req, res) => {
  const { participant } = req.params;
  const { date, fields, messages, visits } = req.body;
 
  if (!date || !fields) return res.status(400).json({ error: 'date and fields required' });
 
  const id = `${participant}-${date}`;
 
  try {
    await pool.query(`
      INSERT INTO entries (id, participant, date, fields, messages, visits, finalized, finalized_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, TRUE, NOW(), NOW())
      ON CONFLICT (id) DO UPDATE SET
        fields       = EXCLUDED.fields,
        messages     = EXCLUDED.messages,
        visits       = EXCLUDED.visits,
        finalized    = TRUE,
        finalized_at = NOW(),
        updated_at   = NOW()
    `, [id, participant, date, fields, messages || [], visits || 1]);
 
    res.json({ ok: true, id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});
 
// ─────────────────────────────────────────────
//  RESEARCH EXPORT
// ─────────────────────────────────────────────
app.get('/api/export/:participant', requireAuth, async (req, res) => {
  const { participant } = req.params;
  try {
    const result = await pool.query(`
      SELECT * FROM entries WHERE participant = $1 AND finalized = TRUE ORDER BY date ASC
    `, [participant]);
 
    const entries = result.rows.map(r => ({
      date:         r.date,
      visits:       r.visits,
      finalized_at: r.finalized_at,
      fields:       r.fields,
    }));
 
    const metrics = computeMetrics(entries);
 
    res.json({
      participant,
      exported_at:   new Date().toISOString(),
      total_entries: entries.length,
      metrics,
      entries,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});
 
function computeMetrics(entries) {
  if (!entries.length) return {};
  const f = entries.map(e => e.fields);
 
  const doseAdherence = pct(f, e => e.DOSE_1_TAKEN === 'yes' && e.DOSE_2_TAKEN === 'yes');
  const exerciseRate  = pct(f, e => e.DOSE_1_EXERCISE === 'yes' || e.DOSE_2_EXERCISE === 'yes');
  const gapCompliance = pct(
    f.filter(e => e.DOSE_1_EXERCISE === 'yes'),
    e => e.DOSE_1_GAP_OK === 'yes'
  );
  const avgMood   = avg(f, e => parseFloat(e.MOOD));
  const avgEnergy = avg(f, e => parseFloat(e.ENERGY));
  const avgSleep  = avg(f, e => parseFloat(e.SLEEP_HRS));
 
  const psaReadings = f
    .filter(e => e.PSA && e.PSA !== 'none' && e.PSA !== 'N/A')
    .map(e => ({ date: e.DATE, value: parseFloat(e.PSA) }))
    .filter(e => !isNaN(e.value));
 
  return {
    total_days:         entries.length,
    dose_adherence_pct: doseAdherence,
    exercise_rate_pct:  exerciseRate,
    gap_compliance_pct: gapCompliance,
    avg_mood:           avgMood,
    avg_energy:         avgEnergy,
    avg_sleep_hours:    avgSleep,
    psa_readings:       psaReadings,
    psa_count:          psaReadings.length,
    psa_first:          psaReadings[0]?.value ?? null,
    psa_last:           psaReadings[psaReadings.length - 1]?.value ?? null,
    psa_delta:          psaReadings.length >= 2
                          ? psaReadings[psaReadings.length - 1].value - psaReadings[0].value
                          : null,
  };
}
 
function pct(arr, fn) {
  if (!arr.length) return null;
  return Math.round((arr.filter(fn).length / arr.length) * 100);
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
//  SERVE APP
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
 
