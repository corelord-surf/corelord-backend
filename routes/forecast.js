// routes/forecast.js
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
  'swellPeriod',
  'tide'
];

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
    .query(`SELECT TOP 1 Id, Name, Region, Latitude, Longitude FROM dbo.SurfBreaks WHERE Id = @id`);
  return result.recordset[0] || null;
}

async function getCachedForecast(breakId, hours) {
  const pool = await poolPromise;
  const result = await pool.request()
    .input('BreakId', sql.Int, breakId)
    .input('Hours', sql.Int, hours)
    .query(`
      SELECT TOP 1 DataJson, FetchedAt
      FROM dbo.ForecastCache
      WHERE BreakId = @BreakId AND Hours = @Hours
        AND FetchedAt > DATEADD(DAY, -7, SYSUTCDATETIME())
      ORDER BY FetchedAt DESC
    `);
  const record = result.recordset[0];
  if (!record) return null;
  return JSON.parse(record.DataJson);
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

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Stormglass ${response.status}: ${text}`);
  }

  return await response.json();
}

// ✅ Primary forecast endpoint
router.get('/timeseries', async (req, res) => {
  try {
    const breakId = parseInt(req.query.breakId, 10);
    const hours = parseInt(req.query.hours || '72', 10);
    if (!breakId) return res.status(400).json({ message: 'breakId is required' });

    const brk = await getBreakById(breakId);
    if (!brk) return res.status(404).json({ message: 'break not found' });

    let json = await getCachedForecast(breakId, hours);
    let fromCache = true;

    if (!json) {
      json = await fetchStormglassData(brk.Latitude, brk.Longitude, hours);
      await storeCachedForecast(breakId, hours, json);
      fromCache = false;
    }

    const items = (json.hours || []).map(entry => ({
      ts: new Date(entry.time).getTime() / 1000,
      waveHeightM: entry.waveHeight?.noaa ?? null,
      windSpeedKt: entry.windSpeed?.noaa != null ? entry.windSpeed.noaa * 1.94384 : null,
      windDir: entry.windDirection?.noaa ?? null,
      swellHeightM: entry.swellHeight?.noaa ?? null,
      swellDir: entry.swellDirection?.noaa ?? null,
      swellPeriodS: entry.swellPeriod?.noaa ?? null,
      waterTempC: entry.waterTemperature?.noaa ?? null,
      tideM: entry.tide?.sg ?? null
    }));

    return res.json({ break: brk, hours: items.length, fromCache, items });
  } catch (err) {
    console.error('[GET /forecast/timeseries] Error:', err);
    return res.status(500).json({ message: String(err.message || err) });
  }
});

// ✅ Enhanced: Pre-cache route with error tracking
router.get('/precache', async (req, res) => {
  try {
    const pool = await poolPromise;
    const result = await pool.request().query(`
      SELECT Id, Latitude, Longitude
      FROM dbo.SurfBreaks
    `);
    const breaks = result.recordset;
    const hours = 168; // 7 days
    const failures = [];

    for (const brk of breaks) {
      try {
        const data = await fetchStormglassData(brk.Latitude, brk.Longitude, hours);
        await storeCachedForecast(brk.Id, hours, data);
      } catch (err) {
        console.error(`[precache] Failed for break ${brk.Id}:`, err.message);
        failures.push({ breakId: brk.Id, error: err.message });
      }
    }

    res.status(200).json({
      message: 'Precache complete',
      totalBreaks: breaks.length,
      failed: failures.length,
      failures
    });
  } catch (err) {
    console.error('[GET /forecast/precache] Error:', err);
    res.status(500).json({ error: 'Precache failed', details: err.message });
  }
});

export default router;
