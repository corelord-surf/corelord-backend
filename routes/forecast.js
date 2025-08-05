// routes/forecast.js
import express from 'express';
import { sql, poolPromise } from '../db.js';
import fetch from 'node-fetch';

const router = express.Router();

/**
 * Small in memory cache to reduce Surfline calls while testing.
 * Key: `${type}:${spotId}:${days}`
 */
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

function daysForHours(hours) {
  const h = Math.max(24, Math.min(168, Number(hours) || 72)); // clamp 1 to 7 days
  return Math.ceil(h / 24);
}

async function surflineFetchJson(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'corelord/alpha',
      'Accept': 'application/json',
      // some Surfline endpoints behave better with these headers
      'Origin': 'https://www.surfline.com',
      'Referer': 'https://www.surfline.com/'
    }
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Surfline ${res.status} ${url} ${text.slice(0, 200)}`);
  }
  return res.json();
}

/**
 * RAW proxy to inspect Surfline payloads for a spot.
 * GET /api/forecast/surfline/raw?breakId=123&type=wave|wind|tides&hours=72
 */
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

    const d = daysForHours(hours);
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

    const data = await surflineFetchJson(url);
    setCache(key, data);
    return res.json({ break: brk, fromCache: false, data });
  } catch (err) {
    console.error('[GET /forecast/surfline/raw] Error:', err);
    return res.status(500).json({ message: String(err.message || err) });
  }
});

/**
 * Normalised time series across wave, wind, tides.
 * GET /api/forecast/timeseries?breakId=123&hours=72
 * Returns [{ ts, waveMinM, waveMaxM, periodS, swellDir, windKt, windDir, tideM }]
 */
router.get('/timeseries', async (req, res) => {
  try {
    const breakId = parseInt(req.query.breakId, 10);
    const hours = parseInt(req.query.hours || '72', 10);
    if (!breakId) return res.status(400).json({ message: 'breakId is required' });

    const brk = await getBreakById(breakId);
    if (!brk) return res.status(404).json({ message: 'break not found' });
    if (!brk.SurflineSpotId) {
      return res.status(400).json({ message: 'SurflineSpotId not set for break' });
    }

    const d = daysForHours(hours);
    const spotId = encodeURIComponent(brk.SurflineSpotId);

    const [wave, wind, tides] = await Promise.all([
      surflineFetchJson(`https://services.surfline.com/kbyg/spots/forecasts/wave?spotId=${spotId}&days=${d}&intervalHours=1`),
      surflineFetchJson(`https://services.surfline.com/kbyg/spots/forecasts/wind?spotId=${spotId}&days=${d}&intervalHours=1`),
      surflineFetchJson(`https://services.surfline.com/kbyg/spots/forecasts/tides?spotId=${spotId}&days=${d}`)
    ]);

    const byTs = new Map();

    // Wave series
    const waveHours = wave?.data?.wave || wave?.data?.hours || wave?.data || [];
    waveHours.forEach(h => {
      const ts = (h?.timestamp ?? h?.ts ?? h?.time) || null;
      if (!ts) return;
      const rec = byTs.get(ts) || { ts };

      const s = h.surf || {};
      const minM = s?.min ?? s?.minHeight ?? h?.surfMin ?? null;
      const maxM = s?.max ?? s?.maxHeight ?? h?.surfMax ?? null;
      if (minM != null) rec.waveMinM = Number(minM);
      if (maxM != null) rec.waveMaxM = Number(maxM);

      if (Array.isArray(h.swells) && h.swells.length) {
        const p = h.swells[0];
        if (p?.period != null) rec.periodS = Number(p.period);
        if (p?.direction != null) rec.swellDir = Math.round(Number(p.direction));
      } else if (h?.period != null) {
        rec.periodS = Number(h.period);
      }

      byTs.set(ts, rec);
    });

    // Wind series
    const windHours = wind?.data?.wind || wind?.data?.hours || wind?.data || [];
    windHours.forEach(h => {
      const ts = (h?.timestamp ?? h?.ts ?? h?.time) || null;
      if (!ts) return;
      const rec = byTs.get(ts) || { ts };
      const sp = h?.speed ?? h?.wind ?? h?.speedKts ?? null;
      if (sp != null) rec.windKt = Number(sp);
      const dir = h?.direction ?? h?.dir ?? h?.bearing ?? null;
      if (dir != null) rec.windDir = Math.round(Number(dir));
      byTs.set(ts, rec);
    });

    // Tide series
    const tideHours = tides?.data?.tides || tides?.data?.hours || tides?.data || [];
    tideHours.forEach(h => {
      const ts = (h?.timestamp ?? h?.ts ?? h?.time) || null;
      if (!ts) return;
      const rec = byTs.get(ts) || { ts };
      const height = h?.height ?? h?.tide ?? null;
      if (height != null) rec.tideM = Number(height);
      byTs.set(ts, rec);
    });

    const items = Array.from(byTs.values())
      .sort((a, b) => a.ts - b.ts)
      .slice(0, hours);

    return res.json({ break: brk, hours: items.length, items });
  } catch (err) {
    console.error('[GET /forecast/timeseries] Error:', err);
    return res.status(500).json({ message: String(err.message || err) });
  }
});

export default router;
