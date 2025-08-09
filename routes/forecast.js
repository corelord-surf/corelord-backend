// routes/forecast.js
import express from "express";
import { sql, poolPromise } from "../db.js";

const router = express.Router();

/* ---------- DB helpers ---------- */
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

async function listSurfBreaks() {
  const pool = await poolPromise;
  const result = await pool.request().query(`
    SELECT Id, Name, Region, Latitude, Longitude
    FROM dbo.SurfBreaks
    ORDER BY Region, Name
  `);
  return result.recordset;
}

async function getCachedForecast(breakId, hours) {
  const pool = await poolPromise;
  const result = await pool
    .request()
    .input("BreakId", sql.Int, breakId)
    .input("Hours", sql.Int, hours).query(`
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

/* ---------- Base sanity endpoint ---------- */
router.get("/", (req, res) => {
  res.json({ ok: true, routes: ["/breaks", "/:breakId", "/timeseries"] });
});

/* ---------- List breaks ---------- */
router.get("/breaks", async (req, res) => {
  try {
    const breaks = await listSurfBreaks();
    res.json(
      breaks.map(b => ({
        id: b.Id,
        name: b.Name,
        region: b.Region,
        latitude: b.Latitude,
        longitude: b.Longitude,
      }))
    );
  } catch (err) {
    console.error("[GET /forecast/breaks] Error:", err);
    res.status(500).json({ message: String(err.message || err) });
  }
});

/* ---------- Cached forecast for a break ---------- */
router.get("/:breakId", async (req, res) => {
  try {
    const breakId = parseInt(req.params.breakId, 10);
    const hours = parseInt(req.query.hours || "168", 10);

    if (!breakId) {
      return res.status(400).json({ message: "breakId must be a number" });
    }

    const brk = await getBreakById(breakId);
    if (!brk) return res.status(404).json({ message: "break not found" });
    if (brk.Latitude == null || brk.Longitude == null) {
      return res.status(400).json({ message: "Break has no coordinates" });
    }

    const json = await getCachedForecast(breakId, hours);
    if (!json) {
      return res
        .status(503)
        .json({ message: "Forecast data is not yet available. Please check back later." });
    }
    if (!Array.isArray(json.hours)) {
      return res.status(500).json({ message: "Invalid forecast data. Missing hours array" });
    }

    const items = json.hours.map((entry) => ({
      ts: new Date(entry.time).getTime() / 1000,

      // magnitudes
      waveHeightM: entry.waveHeight?.noaa ?? null,
      windSpeedKt:
        entry.windSpeed?.noaa != null ? entry.windSpeed.noaa * 1.94384 : null,

      // directions and period
      windDir:        entry.windDirection?.noaa ?? null,
      swellHeightM:   entry.swellHeight?.noaa ?? null,
      swellDir:       entry.swellDirection?.noaa ?? null,
      swellPeriodS:   entry.swellPeriod?.noaa ?? null,
      waterTempC:     entry.waterTemperature?.noaa ?? null,

      // tide from cache writer
      tideM: typeof entry.tideHeight === "number" ? entry.tideHeight : null,
    }));

    return res.json({
      break: { id: brk.Id, name: brk.Name, region: brk.Region },
      hours: items.length,
      fromCache: true,
      items,
    });
  } catch (err) {
    console.error("[GET /forecast/:breakId] Error:", err);
    return res.status(500).json({ message: String(err.message || err) });
  }
});

/* ---------- Existing cache only timeseries with query params ---------- */
router.get("/timeseries", async (req, res) => {
  try {
    const breakId = parseInt(req.query.breakId, 10);
    const hours = parseInt(req.query.hours || "168", 10);

    if (!breakId) {
      return res.status(400).json({ message: "breakId is required" });
    }

    const brk = await getBreakById(breakId);
    if (!brk) return res.status(404).json({ message: "break not found" });
    if (brk.Latitude == null || brk.Longitude == null) {
      return res.status(400).json({ message: "Break has no coordinates" });
    }

    const json = await getCachedForecast(breakId, hours);
    if (!json) {
      return res
        .status(503)
        .json({ message: "Forecast data is not yet available. Please check back later." });
    }
    if (!Array.isArray(json.hours)) {
      return res.status(500).json({ message: "Invalid forecast data: missing hours array" });
    }

    const items = json.hours.map((entry) => ({
      ts: new Date(entry.time).getTime() / 1000,
      waveHeightM: entry.waveHeight?.noaa ?? null,
      windSpeedKt:
        entry.windSpeed?.noaa != null ? entry.windSpeed.noaa * 1.94384 : null,
      windDir:        entry.windDirection?.noaa ?? null,
      swellHeightM:   entry.swellHeight?.noaa ?? null,
      swellDir:       entry.swellDirection?.noaa ?? null,
      swellPeriodS:   entry.swellPeriod?.noaa ?? null,
      waterTempC:     entry.waterTemperature?.noaa ?? null,
      tideM: typeof entry.tideHeight === "number" ? entry.tideHeight : null,
    }));

    return res.json({
      break: { id: brk.Id, name: brk.Name, region: brk.Region },
      hours: items.length,
      fromCache: true,
      items,
    });
  } catch (err) {
    console.error("[GET /forecast/timeseries] Error:", err);
    return res.status(500).json({ message: String(err.message || err) });
  }
});

export default router;
