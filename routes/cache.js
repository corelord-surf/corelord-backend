// routes/cache.js
import express from "express";
import { sql, poolPromise } from "../db.js";
import fetch from "node-fetch";

const router = express.Router();

const STORMGLASS_PARAMS = [
  "waveHeight",
  "windSpeed",
  "windDirection",
  "waterTemperature",
  "swellHeight",
  "swellDirection",
  "swellPeriod",
];

const API_BASE =
  "https://corelord-backend-etgpd9dfdufragfb.westeurope-01.azurewebsites.net";
const HOURS = 168;

// budget per run. set to 10 for the free tier. you can lift this when you upgrade
const MAX_CALLS_PER_RUN = 10;

// rotation seed date. changing this simply shifts the daily grouping
const ROTATION_EPOCH_UTC = Date.UTC(2025, 0, 1); // 1 Jan 2025

function getTimeRange(hours) {
  const now = new Date();
  const end = new Date(now.getTime() + hours * 60 * 60 * 1000);
  return { start: now.toISOString(), end: end.toISOString() };
}

async function getBreakById(breakId) {
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input("id", sql.Int, breakId).query(`
      SELECT TOP 1 Id, Name, Region, Latitude, Longitude
      FROM dbo.SurfBreaks
      WHERE Id = @id
    `);
  return result.recordset[0] || null;
}

async function getAllBreaksWithCoords() {
  const pool = await poolPromise;
  const result = await pool.request().query(`
    SELECT Id, Name, Region, Latitude, Longitude
    FROM dbo.SurfBreaks
    WHERE Latitude IS NOT NULL AND Longitude IS NOT NULL
    ORDER BY Id
  `);
  return result.recordset;
}

async function getAllBreaksMissingCoords() {
  const pool = await poolPromise;
  const result = await pool.request().query(`
    SELECT Id, Name, Region
    FROM dbo.SurfBreaks
    WHERE Latitude IS NULL OR Longitude IS NULL
    ORDER BY Id
  `);
  return result.recordset;
}

async function updateBreakCoords(id, lat, lng) {
  const pool = await poolPromise;
  await pool
    .request()
    .input("id", sql.Int, id)
    .input("lat", sql.Float, lat)
    .input("lng", sql.Float, lng).query(`
      UPDATE dbo.SurfBreaks
      SET Latitude = @lat, Longitude = @lng
      WHERE Id = @id
    `);
}

async function storeCachedForecast(breakId, hours, json) {
  const pool = await poolPromise;
  const jsonString = JSON.stringify(json);
  console.log(
    `[SQL] Storing forecast: BreakId=${breakId}, Size=${jsonString.length}, Hours=${hours}`
  );
  await pool
    .request()
    .input("BreakId", sql.Int, breakId)
    .input("Hours", sql.Int, hours)
    .input("DataJson", sql.NVarChar(sql.MAX), jsonString).query(`
      INSERT INTO dbo.ForecastCache (BreakId, Hours, DataJson)
      VALUES (@BreakId, @Hours, @DataJson)
    `);
}

async function fetchStormglassData(lat, lng, hours) {
  const { start, end } = getTimeRange(hours);
  const url = `https://api.stormglass.io/v2/weather/point?lat=${lat}&lng=${lng}&params=${STORMGLASS_PARAMS.join(
    ","
  )}&start=${start}&end=${end}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(url, {
      headers: { Authorization: process.env.STORMGLASS_API_KEY },
      signal: controller.signal,
    });

    const text = await response.text();
    if (!response.ok) {
      console.error(`[Stormglass] Error ${response.status}: ${text}`);
      throw new Error(`Stormglass error ${response.status}`);
    }

    const parsed = JSON.parse(text);
    console.log(
      `[Stormglass] Received ${parsed.hours?.length || 0} records`
    );
    return parsed;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Simple geocoder for missing coords using OpenStreetMap Nominatim.
 * Call this once to populate Latitude and Longitude in SurfBreaks.
 * Be polite with rate limiting.
 */
async function geocodePlace(name, region) {
  const q = encodeURIComponent(`${name}, ${region}`);
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${q}`;

  const response = await fetch(url, {
    headers: { "User-Agent": "CoreLord/1.0 (ops@corelord.app)" },
  });
  if (!response.ok) {
    throw new Error(`Nominatim ${response.status}`);
  }
  const arr = await response.json();
  if (!Array.isArray(arr) || arr.length === 0) return null;

  const { lat, lon } = arr[0];
  return { lat: parseFloat(lat), lng: parseFloat(lon) };
}

// single break cache
router.get("/daily", async (req, res) => {
  try {
    const breakId = parseInt(req.query.breakId, 10);
    const hours = parseInt(req.query.hours || String(HOURS), 10);
    if (!breakId) return res.status(400).json({ message: "breakId is required" });

    const brk = await getBreakById(breakId);
    if (!brk) return res.status(404).json({ message: "break not found" });
    if (brk.Latitude == null || brk.Longitude == null) {
      return res.status(400).json({ message: "Break has no coordinates" });
    }

    console.log(`[Daily] Fetching forecast for ${brk.Name} (${brk.Id})`);
    const json = await fetchStormglassData(brk.Latitude, brk.Longitude, hours);
    await storeCachedForecast(breakId, hours, json);

    const items = json.hours || [];
    console.log(`[Daily] Stored ${items.length} hours for ${brk.Name}`);
    return res
      .status(200)
      .json({ message: "cached", break: brk.Name, hours: items.length });
  } catch (err) {
    console.error("[GET /api/cache/daily] Error:", err.message);
    return res.status(500).json({ message: "Cache failed", detail: err.message });
  }
});

/**
 * Rotating batch
 * Picks a different slice of breaks each day so we do not hit the same first group repeatedly.
 * Optional query overrides for testing:
 *   /api/cache/daily-batch?max=5&offset=10
 */
router.get("/daily-batch", async (req, res) => {
  try {
    const all = await getAllBreaksWithCoords();
    const total = all.length;

    const max = Math.max(
      1,
      Math.min(parseInt(req.query.max || String(MAX_CALLS_PER_RUN), 10), total)
    );

    // compute daily offset in UTC so it is stable regardless of region
    const todayIndex = Math.floor((Date.now() - ROTATION_EPOCH_UTC) / 86400000);
    const autoOffset = (todayIndex * max) % total;
    const offset = parseInt(req.query.offset || String(autoOffset), 10) % total;

    // take a slice of size max starting at offset with wrap around
    const selected =
      offset + max <= total
        ? all.slice(offset, offset + max)
        : [...all.slice(offset), ...all.slice(0, (offset + max) % total)];

    const results = [];
    for (const brk of selected) {
      console.log(`[Batch] Processing ${brk.Name} (${brk.Id})`);
      const url = `${API_BASE}/api/cache/daily?breakId=${brk.Id}`;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20000);

      try {
        const response = await fetch(url, { signal: controller.signal });
        const text = await response.text();
        clearTimeout(timeout);

        let json;
        try {
          json = JSON.parse(text);
        } catch {
          throw new Error(`Invalid JSON returned: ${text.slice(0, 120)}`);
        }

        results.push({
          break: brk.Name,
          region: brk.Region,
          status: response.status,
          message: json.message || null,
          error: json.detail || null,
        });
      } catch (err) {
        clearTimeout(timeout);
        console.error(`[Batch] ${brk.Name} failed: ${err.message}`);
        results.push({
          break: brk.Name,
          region: brk.Region,
          status: 500,
          message: "Fetch failed",
          error: err.message,
        });
      }
    }

    console.log(
      `[Batch] Complete: processed ${results.length} of ${total} breaks. offset=${offset}, max=${max}`
    );
    return res.json({
      status: "ok",
      processed: results.length,
      total,
      offset,
      max,
      results,
    });
  } catch (err) {
    console.error("[GET /api/cache/daily-batch] Error:", err.message);
    return res
      .status(500)
      .json({ message: "Batch caching failed", detail: err.message });
  }
});

/**
 * Admin. Geocode and fill coordinates for any breaks missing Latitude or Longitude.
 * Run once. Logs each update. Polite delay to respect Nominatim usage.
 */
router.post("/admin/geocode-missing", async (_req, res) => {
  try {
    const missing = await getAllBreaksMissingCoords();
    const updates = [];

    for (const brk of missing) {
      try {
        console.log(`[Geocode] Looking up "${brk.Name}, ${brk.Region}"`);
        const coords = await geocodePlace(brk.Name, brk.Region);
        if (!coords) {
          console.warn(`[Geocode] No result for ${brk.Name}`);
          updates.push({ id: brk.Id, name: brk.Name, ok: false, reason: "no result" });
          continue;
        }
        await updateBreakCoords(brk.Id, coords.lat, coords.lng);
        console.log(
          `[Geocode] Updated ${brk.Name} -> ${coords.lat}, ${coords.lng}`
        );
        updates.push({ id: brk.Id, name: brk.Name, ok: true, ...coords });
        await new Promise((r) => setTimeout(r, 900));
      } catch (e) {
        console.error(`[Geocode] ${brk.Name} failed: ${e.message}`);
        updates.push({ id: brk.Id, name: brk.Name, ok: false, reason: e.message });
      }
    }

    return res.json({
      updated: updates.filter((u) => u.ok).length,
      attempted: updates.length,
      updates,
    });
  } catch (err) {
    console.error("[POST /api/cache/admin/geocode-missing] Error:", err.message);
    return res.status(500).json({ message: "Geocode failed", detail: err.message });
  }
});

export default router;
