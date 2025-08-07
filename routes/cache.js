// routes/cache.js
import express from 'express';
import { sql, poolPromise } from '../db.js';
import fetch from 'node-fetch';

const router = express.Router();
const STORMGLASS_PARAMS = [
  'waveHeight',
  'windSpeed',
  'windDirection',
  'waterTemperature',
  'swellHeight',
  'swellDirection',
  'swellPeriod'
];

const API_BASE = 'https://corelord-backend-etgpd9dfdufragfb.westeurope-01.azurewebsites.net';
const HOURS = 168;

function getTimeRange(hours) {
  const now = new Date();
  const end = new Date(now.getTime() + hours * 60 * 60 * 1000);
  return {
    start: now.toISOString(),
    end: end.toISOString()
  };
}

async function getBreakById(breakId) {
  const pool = await poolPromise;
  const result = await pool.request()
    .input('id', sql.Int, breakId)
    .query(`
      SELECT TOP 1 Id, Name, Region, Latitude, Longitude
      FROM dbo.SurfBreaks
      WHERE Id = @id
    `);
  return result.recordset[0] || null;
}

async function getAllBreaks() {
  const pool = await poolPromise;
  const result = await pool.request().query(`
    SELECT Id, Name, Region FROM dbo.SurfBreaks
    WHERE Latitude IS NOT NULL AND Longitude IS NOT NULL
  `);
  return result.recordset;
}

async function storeCachedForecast(breakId, hours, json) {
  const pool = await poolPromise;
  await pool.request()
    .input('BreakId', sql.Int, breakId)
    .input('Hours', sql.Int, hours)
    .input('DataJson', sql.NVarChar(sql.MAX), JSON.stringify(json))
    .query(`
      INSERT INTO dbo.ForecastCache (BreakId, Hours, DataJson)
      VALUES (@BreakId, @Hours, @DataJson)
    `);
}

async function fetchStormglassData(lat, lng, hours) {
  const { start, end } = getTimeRange(hours);
  const url = `https://api.stormglass.io/v2/weather/point?lat=${lat}&lng=${lng}&params=${STORMGLASS_PARAMS.join(',')}&start=${start}&end=${end}`;

  const response = await fetch(url, {
    headers: { Authorization: process.env.STORMGLASS_API_KEY }
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Stormglass ${response.status}: ${text}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`Invalid JSON from Stormglass: ${err.message}`);
  }

  return parsed;
}

// Existing daily route (single break via query)
router.get('/daily', async (req, res) => {
  try {
    const breakId = parseInt(req.query.breakId, 10);
    const hours = parseInt(req.query.hours || '168', 10);
    if (!breakId) return res.status(400).json({ message: 'breakId is required' });

    const brk = await getBreakById(breakId);
    if (!brk) return res.status(404).json({ message: 'break not found' });

    const json = await fetchStormglassData(brk.Latitude, brk.Longitude, hours);
    await storeCachedForecast(breakId, hours, json);

    const items = json.hours || [];
    return res.status(200).json({ message: 'cached', break: brk.Name, hours: items.length, items });
  } catch (err) {
    console.error('[GET /api/cache/daily] Error:', err.message);
    return res.status(500).json({ message: 'Cache failed', detail: err.message });
  }
});

// NEW: Logic App friendly batch route
router.get('/daily-batch', async (_req, res) => {
  try {
    const breaks = await getAllBreaks();
    const results = [];

    for (const brk of breaks) {
      const url = `${API_BASE}/api/cache/daily?breakId=${brk.Id}`;
      try {
        const response = await fetch(url);
        const json = await response.json();
        results.push({
          break: brk.Name,
          region: brk.Region,
          status: response.status,
          message: json.message || null,
          error: json.detail || null
        });
      } catch (err) {
        results.push({
          break: brk.Name,
          region: brk.Region,
          status: 500,
          message: 'Fetch failed',
          error: err.message
        });
      }
    }

    return res.json({ status: 'ok', count: results.length, results });
  } catch (err) {
    console.error('[GET /api/cache/daily-batch] Error:', err.message);
    return res.status(500).json({ message: 'Batch caching failed', detail: err.message });
  }
});

export default router;
