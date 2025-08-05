// routes/forecast.js
import express from 'express';
import { sql, poolPromise } from '../db.js';

const router = express.Router();

/**
 * Small in memory cache to reduce Surfline calls while testing.
 * Key: `${type}:${spotId}:${hours}`
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

// Basic Surfline helpers
function daysForHours(hours) {
  const h = Math.max(24, Math.min(168, Number(hours) || 72)); // 1 to 7 days
  return Math.ceil(h / 24);
}

async function surflineFetchJson(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'corelord/alpha',
      'Accept': 'application/json'
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
      // tides endpoint does not accept intervalHours and returns events plus hourly in some regions
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
    return res.status(500).json({ message: 'Failed to fetch Surfline data' });
  }
});

/**
 * Normalised timeseries across wave, wind, tides.
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

    // fetch in parallel
    const [wave, wind, tides] = await Promise.all([
      surflineFetchJson(`https://services.surfline.com/kbyg/spots/forecasts/wave?spotId=${spotId}&days=${d}&intervalHours=1`),
      surflineFetchJson(`https://services.surfline.com/kbyg/spots/forecasts/wind?spotId=${spotId}&days=${d}&intervalHours=1`),
      surflineFetchJson(`https://services.surfline.com/kbyg/spots/forecasts/tides?spotId=${spotId}&days=${d}`)
    ]);

    // Build a map of ts -> record
    const byTs = new Map();

    // Wave payload usually has .data.wave or .data.hours
    const waveHours =
      wave?.data?.wave || wave?.data?.hours || wave?.data || [];
    waveHours.forEach(h => {
      const ts = (h?.timestamp ?? h?.ts ?? h?.time) || null;
      if (!ts) return;
      const rec = byTs.get(ts) || { ts };
      // surf min max metres sometimes present at h.surf.min/max or h.surf.minHeight etc
      const s = h.surf || {};
      const minM = s?.min || s?.minHeight || h?.surfMin || null;
      const maxM = s?.max || s?.maxHeight || h?.surfMax || null;
      rec.waveMinM = minM != null ? Number(minM) : rec.waveMinM ?? null;
      rec.waveMaxM = maxM != null ? Number(maxM) : rec.waveMaxM ?? null;

      // primary swell period and direction if available
      if (Array.isArray(h.swells) && h.swells.length) {
        const p = h.swells[0];
        rec.periodS = p?.period != null ? Number(p.period) : rec.periodS ?? null;
        rec.swellDir = p?.direction != null ? Math.round(Number(p.direction)) : rec.swellDir ?? null;
      } else if (h?.period) {
        rec.periodS = Number(h.period);
      }
      byTs.set(ts, rec);
    });

    // Wind
    const windHours =
      wind?.data?.wind || wind?.data?.hours || wind?.data || [];
    windHours.forEach(h => {
      const ts = (h?.timestamp ?? h?.ts ?? h?.time) || null;
      if (!ts) return;
      const rec = byTs.get(ts) || { ts };
      const sp = h?.speed ?? h?.wind ?? h?.speedKts ?? null;
      rec.windKt = sp != null ? Number(sp) : rec.windKt ?? null;
      const dir = h?.direction ?? h?.dir ?? h?.bearing ?? null;
      rec.windDir = dir != null ? Math.round(Number(dir)) : rec.windDir ?? null;
      byTs.set(ts, rec);
    });

    // Tides events sometimes need interpolation; for now attach nearest event height if provided
    const tideHours =
      tides?.data?.tides || tides?.data?.hours || tides?.data || [];
    tideHours.forEach(h => {
      const ts = (h?.timestamp ?? h?.ts ?? h?.time) || null;
      if (!ts) return;
      const rec = byTs.get(ts) || { ts };
      const height = h?.height ?? h?.tide ?? null;
      rec.tideM = height != null ? Number(height) : rec.tideM ?? null;
      byTs.set(ts, rec);
    });

    // Return sorted array, limit to requested hours
    const items = Array.from(byTs.values())
      .sort((a, b) => a.ts - b.ts)
      .slice(0, hours);

    return res.json({ break: brk, hours: items.length, items });
  } catch (err) {
    console.error('[GET /forecast/timeseries] Error:', err);
    return res.status(500).json({ message: 'Failed to build timeseries' });
  }
});

export default router;
