// routes/forecast.js
import express from 'express';
import fetch from 'node-fetch';
import { sql, poolPromise } from '../db.js';

const router = express.Router();

function getTimeRange(hours) {
  const now = new Date();
  const end = new Date(now.getTime() + hours * 3600 * 1000);
  return { start: now.toISOString(), end: end.toISOString() };
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

  try {
    return JSON.parse(record.DataJson);
  } catch (err) {
    console.error(
      `[getCachedForecast] Failed to parse cached JSON for BreakId ${breakId}:`,
      err.message
    );
    return null;
  }
}

// Optional live tide fetch if needed
async function fetchTideMap(lat, lng, hours) {
  const { start, end } = getTimeRange(hours);
  const url = `https://api.stormglass.io/v2/tide/sea-level/point?lat=${lat}&lng=${lng}&start=${start}&end=${end}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const resp = await fetch(url, {
      headers: { Authorization: process.env.STORMGLASS_API_KEY },
      signal: controller.signal
    });

    const text = await resp.text();
    if (!resp.ok) {
      console.error(`[Stormglass tide] ${resp.status}: ${text.slice(0, 200)}`);
      throw new Error(`Stormglass tide error ${resp.status}`);
    }

    const json = JSON.parse(text);
    const arr = Array.isArray(json?.data) ? json.data : [];

    const map = new Map();
    for (const p of arr) {
      const iso = new Date(p.time).toISOString();
      const hourKey = iso.slice(0, 13); // YYYY-MM-DDTHH
      const val =
        typeof p.noaa === 'number'
          ? p.noaa
          : (typeof p.sg === 'number' ? p.sg : null);
      if (val != null) map.set(hourKey, val);
    }
    return map;
  } finally {
    clearTimeout(timeout);
  }
}

router.get('/timeseries', async (req, res) => {
  try {
    const breakId = parseInt(req.query.breakId, 10);
    const hours = parseInt(req.query.hours || '72', 10);
    if (!breakId) return res.status(400).json({ message: 'breakId is required' });

    const brk = await getBreakById(breakId);
    if (!brk) return res.status(404).json({ message: 'break not found' });
    if (brk.Latitude == null || brk.Longitude == null) {
      return res.status(400).json({ message: 'Break has no coordinates' });
    }

    const json = await getCachedForecast(breakId, hours);
    if (!json) {
      return res
        .status(503)
        .json({ message: 'Forecast data is not yet available. Please check back later.' });
    }
    if (!json.hours || !Array.isArray(json.hours)) {
      return res.status(500).json({ message: 'Invalid forecast data: missing hours array' });
    }

    // Decide if we need to fetch tide live
    let tideByHour = null;
    const includeTide = (req.query.includeTide ?? '1') !== '0';

    // Check if cached tide exists in JSON
    const tideFromCache = json.hours.some(h => typeof h.tideHeight === 'number');

    if (!tideFromCache && includeTide) {
      try {
        tideByHour = await fetchTideMap(brk.Latitude, brk.Longitude, hours);
      } catch (e) {
        console.warn(`[timeseries] Tide fetch failed for BreakId=${breakId}: ${e.message}`);
      }
    }

    const items = json.hours.map(entry => {
      const iso = new Date(entry.time).toISOString();
      const hourKey = iso.slice(0, 13);

      return {
        ts: new Date(entry.time).getTime() / 1000,
        waveHeightM: entry.waveHeight?.noaa ?? null,
        windSpeedKt:
          entry.windSpeed?.noaa != null ? entry.windSpeed.noaa * 1.94384 : null,
        windDir: entry.windDirection?.noaa ?? null,
        swellHeightM: entry.swellHeight?.noaa ?? null,
        swellDir: entry.swellDirection?.noaa ?? null,
        swellPeriodS: entry.swellPeriod?.noaa ?? null,
        waterTempC: entry.waterTemperature?.noaa ?? null,
        tideM:
          entry.tideHeight ??
          tideByHour?.get(hourKey) ??
          null
      };
    });

    return res.json({
      break: { id: brk.Id, name: brk.Name, region: brk.Region },
      hours: items.length,
      fromCache: true,
      items
    });
  } catch (err) {
    console.error('[GET /forecast/timeseries] Error:', err);
    return res.status(500).json({ message: String(err.message || err) });
  }
});

export default router;
