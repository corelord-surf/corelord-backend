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
    SELECT Id, Name, Region, Latitude, Longitude
    FROM dbo.SurfBreaks
    WHERE Latitude IS NOT NULL AND Longitude IS NOT NULL
  `);
  return result.recordset;
}

async function storeCachedForecast(breakId, hours, json) {
  const pool = await poolPromise;
  const jsonString = JSON.stringify(json);
  console.log(`[SQL] Storing forecast: BreakId=${breakId}, Size=${jsonString.length}, Hours=${hours}`);

  await pool.request()
    .input('BreakId', sql.Int, breakId)
    .input('Hours', sql.Int, hours)
    .input('DataJson', sql.NVarChar(sql.MAX), jsonString)
    .query(`
      INSERT INTO dbo.ForecastCache (BreakId, Hours, DataJson)
      VALUES (@BreakId, @Hours, @DataJson)
    `);
}

async function fetchStormglassData(lat, lng, hours) {
  const { start, end } = getTimeRange(hours);
  const url = `https://api.stormglass.io/v2/weather/point?lat=${lat}&lng=${lng}&params=${STORMGLASS_PARAMS.join(',')}&start=${start}&end=${end}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(url, {
      headers: { Authorization: process.env.STORMGLASS_API_KEY },
      signal: controller.signal
    });

    const text = await response.text();

    if (!response.ok) {
      console.error(`[Stormglass] Error ${response.status}: ${text}`);
      throw new Error(`Stormglass ${response.status}: ${text}`);
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new Error(`Invalid JSON: ${err.message}`);
    }

    console.log(`[Stormglass] Received ${parsed.hours?.length || 0} records`);
    return parsed;
  } finally {
    clearTimeout(timeout);
  }
}

// Single break (used by Logic App or manual test)
router.get('/daily', async (req, res) => {
  try {
    const breakId = parseInt(req.query.breakId, 10);
    const hours = parseInt(req.query.hours || '168', 10);
    if (!breakId) return res.status(400).json({ message: 'breakId is required' });

    const brk = await getBreakById(breakId);
    if (!brk) return res.status(404).json({ message: 'break not found' });

    console.log(`[Daily] Fetching forecast for ${brk.Name} (${brk.Id})`);

    const json = await fetchStormglassData(brk.Latitude, brk.Longitude, hours);
    await storeCachedForecast(breakId, hours, json);

    const items = json.hours || [];
    console.log(`[Daily] Stored ${items.length} hours for ${brk.Name}`);
    return res.status(200).json({ message: 'cached', break: brk.Name, hours: items.length });
  } catch (err) {
    console.error('[GET /api/cache/daily] Error:', err.message);
    return res.status(500).json({ message: 'Cache failed', detail: err.message });
  }
});

// Batch for Logic App
router.get('/daily-batch', async (_req, res) => {
  try {
    const breaks = await getAllBreaks();
    const results = [];

    for (const brk of breaks) {
      console.log(`[Batch] Processing ${brk.Name} (${brk.Id})`);
      const url = `${API_BASE}/api/cache/daily?breakId=${brk.Id}`;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

      try {
        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(timeout);

        const text = await response.text();
        let json;

        try {
          json = JSON.parse(text);
        } catch (parseErr) {
          console.error(`[Batch] Invalid JSON from ${brk.Name}: ${parseErr.message}`);
          json = { message: 'Invalid JSON', detail: text.slice(0, 200) };
        }

        results.push({
          break: brk.Name,
          region: brk.Region,
          status: response.status,
          message: json.message || null,
          error: json.detail || null
        });
      } catch (err) {
        clearTimeout(timeout);
        console.error(`[Batch] ${brk.Name} failed: ${err.message}`);
        results.push({
          break: brk.Name,
          region: brk.Region,
          status: 500,
          message: 'Fetch failed',
          error: err.message
        });
      }
    }

    console.log(`[Batch] Complete: ${results.length} breaks processed`);
    return res.json({ status: 'ok', count: results.length, results });
  } catch (err) {
    console.error('[GET /api/cache/daily-batch] Error:', err.message);
    return res.status(500).json({ message: 'Batch caching failed', detail: err.message });
  }
});

export default router;
