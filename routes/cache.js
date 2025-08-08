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

// daily call budget
const MAX_CALLS_PER_RUN = 10;

// rotation seed. changing this shifts the daily grouping
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
    console.log(`[Stormglass] Received ${parsed.hours?.length || 0} records`);
    return parsed;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Region helpers for safer geocoding
 * countryCodeFor returns a two letter code when we can
 * bboxFor returns a guard box {minLat, maxLat, minLng, maxLng}
 */
function countryCodeFor(region) {
  if (!region) return null;
  const r = region.toLowerCase();
  if (r.includes("ericeira")) return "pt";    // Portugal
  if (r.includes("torquay")) return "au";     // Australia
  return null;
}

// generous boxes, then we can expand if needed
function bboxFor(region) {
  if (!region) return null;
  const r = region.toLowerCase();
  if (r.includes("ericeira")) {
    // around 38.9 to 39.2N, 9.60W to 9.10W
    return { minLat: 38.90, maxLat: 39.20, minLng: -9.60, maxLng: -9.10 };
  }
  if (r.includes("torquay")) {
    // Surf Coast VIC
    return { minLat: -38.90, maxLat: -38.10, minLng: 144.00, maxLng: 144.80 };
  }
  return null;
}

function expandBox(box, factor) {
  const latSpan = (box.maxLat - box.minLat) * (factor - 1) / 2;
  const lngSpan = (box.maxLng - box.minLng) * (factor - 1) / 2;
  return {
    minLat: box.minLat - latSpan,
    maxLat: box.maxLat + latSpan,
    minLng: box.minLng - lngSpan,
    maxLng: box.maxLng + lngSpan,
  };
}

function withinBox(lat, lng, box) {
  if (!box) return true;
  return (
    lat >= box.minLat &&
    lat <= box.maxLat &&
    lng >= box.minLng &&
    lng <= box.maxLng
  );
}

// lightweight alias corrections for common local names
function aliasFor(name) {
  const map = new Map([
    ["winki pop", "winkipop"],
    ["hut gulley", "hutt gully"],
    ["jarosite reef", "jarosite"],
    ["the reef", "torquay reef"], // nudge
    ["boobs", "boobs surf spot"],
    ["steps", "steps surf spot"],
    ["point roadnight", "point roadknight"], // common misspelling
  ]);
  const key = String(name || "").toLowerCase().trim();
  return map.get(key) || null;
}

function nameVariants(name, region) {
  const variants = [];
  const alias = aliasFor(name);
  const base = [name, alias].filter(Boolean);

  for (const b of base) {
    variants.push(b);
    variants.push(`${b} surf`);
    variants.push(`${b} surf spot`);
    variants.push(`${b} ${region}`);
    variants.push(`${b} ${region} surf`);
  }
  // de dup while preserving order
  return Array.from(new Set(variants));
}

/**
 * Smarter geocoder using OpenStreetMap Nominatim.
 * Pass 1: country + tight box
 * Pass 2: country + expanded box
 * Pass 3: country only with query variants
 * Every candidate is validated against the tight or expanded box if one exists
 */
async function geocodePlace(name, region) {
  const cc = countryCodeFor(region);
  const box = bboxFor(region);
  const expanded = box ? expandBox(box, 1.8) : null;

  const variants = nameVariants(name, region);
  const headers = { "User-Agent": "CoreLord/1.0 (ops@corelord.app)" };

  const buildUrl = (q, boxArg) => {
    const params = new URLSearchParams({ format: "json", limit: "1", q });
    if (cc) params.append("countrycodes", cc);
    if (boxArg) {
      params.append("viewbox", `${boxArg.minLng},${boxArg.minLat},${boxArg.maxLng},${boxArg.maxLat}`);
      params.append("bounded", "1");
    }
    return `https://nominatim.openstreetmap.org/search?${params.toString()}`;
  };

  // helper that tries a set of queries with an optional box and validates
  const trySet = async (queries, boxArg) => {
    for (const q of queries) {
      const url = buildUrl(q, boxArg);
      const resp = await fetch(url, { headers });
      if (!resp.ok) continue;
      const arr = await resp.json();
      if (!Array.isArray(arr) || arr.length === 0) continue;

      const { lat, lon } = arr[0];
      const latNum = parseFloat(lat);
      const lngNum = parseFloat(lon);

      if (box && !withinBox(latNum, lngNum, box) && boxArg === box) {
        // result outside tight box, keep looking
        continue;
      }
      if (expanded && boxArg === expanded && !withinBox(latNum, lngNum, expanded)) {
        continue;
      }
      return { lat: latNum, lng: lngNum };
    }
    return null;
  };

  // Pass 1: strict
  if (box) {
    const hit = await trySet([`${name}, ${region}`], box);
    if (hit) return hit;
  }

  // Pass 2: expanded box
  if (expanded) {
    const hit = await trySet([`${name}, ${region}`], expanded);
    if (hit) return hit;
  }

  // Pass 3: country only with variants
  const hit = await trySet(variants.map(v => `${v}`), null);
  if (hit && (!box || withinBox(hit.lat, hit.lng, expanded || box))) {
    return hit;
  }

  return null;
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
 * Rotating batch.
 * Picks a different slice each day so we do not hit the same first group repeatedly.
 * Optional testing overrides:
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

    const todayIndex = Math.floor((Date.now() - ROTATION_EPOCH_UTC) / 86400000);
    const autoOffset = (todayIndex * max) % total;
    const offset = parseInt(req.query.offset || String(autoOffset), 10) % total;

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
 * Uses country code hints and bounding boxes, with widening and variants as fallback.
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
          console.warn(`[Geocode] No safe result for ${brk.Name}`);
          updates.push({ id: brk.Id, name: brk.Name, ok: false, reason: "no result" });
          continue;
        }

        await updateBreakCoords(brk.Id, coords.lat, coords.lng);
        console.log(`[Geocode] Updated ${brk.Name} -> ${coords.lat}, ${coords.lng}`);
        updates.push({ id: brk.Id, name: brk.Name, ok: true, ...coords });

        // polite pacing for Nominatim
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

/**
 * Admin. Audit coordinates that look out of region.
 * Does not change data. Use it to spot anything odd.
 */
router.get("/admin/audit-coords", async (_req, res) => {
  try {
    const pool = await poolPromise;
    const result = await pool.request().query(`
      SELECT Id, Name, Region, Latitude, Longitude
      FROM dbo.SurfBreaks
      WHERE Latitude IS NOT NULL AND Longitude IS NOT NULL
      ORDER BY Region, Id
    `);

    const suspicious = [];
    for (const r of result.recordset) {
      const box = bboxFor(r.Region);
      if (box && !withinBox(r.Latitude, r.Longitude, box)) {
        suspicious.push(r);
      }
    }

    return res.json({ totalChecked: result.recordset.length, suspicious });
  } catch (err) {
    console.error("[GET /api/cache/admin/audit-coords] Error:", err.message);
    return res.status(500).json({ message: "Audit failed", detail: err.message });
  }
});

export default router;
