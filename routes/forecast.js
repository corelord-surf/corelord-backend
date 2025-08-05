// routes/forecast.js
import express from 'express';
import { sql, poolPromise } from '../db.js';
import fetch from 'node-fetch';

const router = express.Router();
const cache = new Map();
const CACHE_MS = 5 * 60 * 1000;

function setCache(key, value) {
  cache.set(key, { value, at: Date.now() });
}
function getCache(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_MS) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

async function getBreakById(breakId) {
  const pool = await poolPromise;
  const result = await pool.request()
    .input('id', sql.Int, breakId)
    .query(`
      SELECT TOP 1 Id, Name, Region, SurflineSpotId, Latitude, Longitude
      FROM dbo.SurfBreaks WHERE Id = @id
    `);
  return result.recordset[0] || null;
}

function getTimeRange(hours) {
  const now = new Date();
  const end = new Date(now.getTime() + hours * 60 * 60 * 1000);
  return {
    start: now.toISOString(),
    end: end.toISOString()
  };
}

async function fetchStormglassData(lat, lng, hours) {
  const key = `stormglass:${lat}:${lng}:${hours}`;
  const cached = getCache(key);
  if (cached) return cached;

  const { start, end } = getTimeRange(hours);
  const url = `https://api.stormglass.io/v2/weather/point?lat=${lat}&lng=${lng}&params=waveHeight,windSpeed,windDirection,waterTemperature,swellHeight,swellDirection,swellPeriod&start=${start}&end=${end}`;

  const response = await fetch(url, {
    headers: { Authorization: process.env.STORMGLASS_API_KEY }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Stormglass ${response.status} ${text}`);
  }

  const json = await response.json();
  setCache(key, json);
  return json;
}

// 🧪 Surfline raw endpoint still available
router.get('/surfline/raw', async (req, res) => {
  try {
    const breakId = parseInt(req.query.breakId, 10);
    const typ = String(req.query.type || 'wave');
    const hours = parseInt(req.query.hours || '72', 10);

    if (!breakId) return res.status(400).json({ message: 'breakId is required' });
    if (!['wave', 'wind', 'tides'].includes(typ)) {
      return res.status(400).json({ message: 'type must be wave, wind, or tides' });
    }

    const brk = await getBreakById(breakId);
    if (!brk) return res.status(404).json({ message: 'break not found' });
    if (!brk.SurflineSpotId) {
      return res.status(400).json({ message: 'SurflineSpotId not set for break' });
    }

    const d = Math.ceil(Math.max(24, Math.min(168, hours)) / 24);
    let url;
    if (typ === 'wave') {
      url = `https://services.surfline.com/kbyg/spots/forecasts/wave?spotId=${encodeURIComponent(brk.SurflineSpotId)}&days=${d}&intervalHours=1`;
    } else if (typ === 'wind') {
      url = `https://services.surfline.com/kbyg/spots/forecasts/wind?spotId=${encodeURIComponent(brk.SurflineSpotId)}&days=${d}&intervalHours=1`;
    } else {
      url = `https://services.surfline.com/kbyg/spots/forecasts/tides?spotId=${encodeURIComponent(brk.SurflineSpotId)}&days=${d}`;
    }

    const key = `${typ}:${brk.SurflineSpotId}:${d}`;
    const hit = getCache(key);
    if (hit) return res.json({ break: brk, fromCache: true, data: hit });

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'corelord/alpha',
        'Accept': 'application/json',
        'Origin': 'https://www.surfline.com',
        'Referer': 'https://www.surfline.com/'
      }
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Surfline ${response.status} ${text}`);
    }

    const data = await response.json();
    setCache(key, data);
    return res.json({ break: brk, fromCache: false, data });
  } catch (err) {
    console.error('[GET /forecast/surfline/raw] Error:', err);
    return res.status(500).json({ message: String(err.message || err) });
  }
});

// ✅ Timeseries route using Stormglass
router.get('/timeseries', async (req, res) => {
  try {
    const breakId = parseInt(req.query.breakId, 10);
    const hours = parseInt(req.query.hours || '72', 10);
    if (!breakId) return res.status(400).json({ message: 'breakId is required' });

    const brk = await getBreakById(breakId);
    if (!brk) return res.status(404).json({ message: 'break not found' });

    const data = await fetchStormglassData(brk.Latitude, brk.Longitude, hours);

    const items = (data.hours || []).map(entry => ({
      ts: new Date(entry.time).getTime() / 1000,
      waveHeightM: entry.waveHeight?.noaa ?? null,
      windSpeedKt: entry.windSpeed?.noaa != null ? entry.windSpeed.noaa * 1.94384 : null,
      windDir: entry.windDirection?.noaa ?? null,
      swellHeightM: entry.swellHeight?.noaa ?? null,
      swellDir: entry.swellDirection?.noaa ?? null,
      swellPeriodS: entry.swellPeriod?.noaa ?? null,
      waterTempC: entry.waterTemperature?.noaa ?? null
    }));

    return res.json({ break: brk, hours: items.length, items });
  } catch (err) {
    console.error('[GET /forecast/timeseries] Error:', err);
    return res.status(500).json({ message: String(err.message || err) });
  }
});

export default router;
