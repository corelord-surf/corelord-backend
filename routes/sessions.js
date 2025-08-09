// routes/sessions.js
import express from "express";
import fetch from "node-fetch";

const router = express.Router();

/**
 * Utility: normalize degrees to 0..360
 */
function normDeg(d) {
  let x = Number(d) % 360;
  if (x < 0) x += 360;
  return x;
}

/**
 * Build sector centers for 8-way compass
 */
const SECTOR_CENTERS = {
  N: 0, NE: 45, E: 90, SE: 135, S: 180, SW: 225, W: 270, NW: 315
};

/**
 * Direction score: if no allowed list => neutral 1.0
 * Else compute cosine falloff from nearest allowed sector center.
 * Full score inside ±22.5°, then soft to 0 by ±45°.
 */
function dirScore(deg, allowedCsv) {
  if (deg == null) return 0.5; // unknown -> neutral-ish
  if (!allowedCsv) return 1.0;

  const allowed = String(allowedCsv)
    .split(",")
    .map(s => s.trim().toUpperCase())
    .filter(Boolean);

  if (!allowed.length) return 1.0;

  const d = normDeg(deg);
  let best = 0;

  for (const a of allowed) {
    const center = SECTOR_CENTERS[a];
    if (center == null) continue;
    // circular distance
    let delta = Math.abs(d - center);
    delta = Math.min(delta, 360 - delta);

    // inside 22.5° => 1.0; at 45° => 0.0; cosine between
    if (delta <= 22.5) {
      best = Math.max(best, 1.0);
    } else if (delta <= 45) {
      const t = (delta - 22.5) / 22.5; // 0..1
      // cosine smoothstep 1..0
      const s = 0.5 * (1 + Math.cos(Math.PI * t));
      best = Math.max(best, s);
    } else {
      // no contribution
    }
  }
  return best;
}

/**
 * Band score (min/max). If both present: 1.0 in-band, linear falloff to 0 at ±25%.
 * If only min: ramp 0..1 up to min, then 1.
 * If only max: 1..0 down to max, then 0.
 * If neither: neutral 1.0.
 */
function bandScore(val, min, max) {
  if (val == null) return 0.5;
  const hasMin = typeof min === "number";
  const hasMax = typeof max === "number";

  if (!hasMin && !hasMax) return 1.0;

  const v = Number(val);

  if (hasMin && hasMax) {
    if (v >= min && v <= max) return 1.0;
    const span = (max - min) || 0.0001;
    const pad = 0.25 * span; // 25% falloff
    if (v < min) {
      const t = Math.max(0, Math.min(1, (min - v) / pad));
      return 1 - t;
    } else {
      const t = Math.max(0, Math.min(1, (v - max) / pad));
      return 1 - t;
    }
  }

  if (hasMin && !hasMax) {
    if (v >= min) return 1.0;
    const t = Math.max(0, Math.min(1, (min - v) / (min || 1)));
    return 1 - t;
  }

  // !hasMin && hasMax
  if (v <= max) return 1.0;
  const t = Math.max(0, Math.min(1, (v - max) / (max || 1)));
  return 1 - t;
}

/**
 * Wind speed score: 1.0 at <= max, fall to 0 at +50% over max.
 * If no max defined -> neutral 1.0
 */
function windSpeedScore(kt, maxWind) {
  if (kt == null) return 0.5;
  if (typeof maxWind !== "number") return 1.0;
  if (kt <= maxWind) return 1.0;
  const over = kt - maxWind;
  const fall = maxWind * 0.5 || 1;
  const t = Math.max(0, Math.min(1, over / fall));
  return 1 - t;
}

/**
 * Tide score: band if user gave min/max; else neutral 0.75 (tide optional)
 */
function tideScore(tide, minTide, maxTide) {
  const hasMin = typeof minTide === "number";
  const hasMax = typeof maxTide === "number";
  if (!hasMin && !hasMax) return 0.75;
  return bandScore(tide, minTide, maxTide);
}

/**
 * Hourly score given item + prefs
 */
function hourlyScore(item, prefs, weights) {
  const height = bandScore(item.waveHeightM, prefs.MinHeightM, prefs.MaxHeightM);
  const period = bandScore(item.swellPeriodS, prefs.MinPeriodS, prefs.MaxPeriodS);
  const swellDir = dirScore(item.swellDir, prefs.AllowedSwellDirs);
  const wSpeed = windSpeedScore(item.windSpeedKt, prefs.MaxWindKt);
  const wDir = dirScore(item.windDir, prefs.AllowedWindDirs);
  const tide = tideScore(item.tideM, prefs.MinTideM, prefs.MaxTideM);

  const s =
    weights.h * height +
    weights.p * period +
    weights.sd * swellDir +
    weights.ws * wSpeed +
    weights.wd * wDir +
    weights.t * tide;

  return {
    score: Math.max(0, Math.min(1, s)),
    subs: { height, period, swellDir, windSpeed: wSpeed, windDir: wDir, tide }
  };
}

/**
 * Map a Date (UTC) to local DOW/hour for a given IANA tz.
 * Returns { dow:0..6 (Sun=0), hour:0..23 }
 */
function dowHourInTZ(dateUtc, tz) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    hour: "numeric",
    hour12: false
  }).formatToParts(dateUtc);

  let wd = null, hr = null;
  for (const p of parts) {
    if (p.type === "weekday") wd = p.value; // e.g., "Mon"
    if (p.type === "hour") hr = parseInt(p.value, 10);
  }
  const map = { Sun:0, Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6 };
  return { dow: map[wd] ?? 0, hour: hr ?? 0 };
}

/**
 * Helper to call our own API with the same Authorization header.
 */
async function selfGet(req, path) {
  const base = `${req.protocol}://${req.get("host")}`;
  const res = await fetch(base + path, {
    headers: { Authorization: req.headers.authorization || "" }
  });
  if (!res.ok && res.status !== 204) {
    const txt = await res.text();
    throw new Error(`${path} -> ${res.status}: ${txt.slice(0, 120)}`);
  }
  return res.status === 204 ? null : res.json();
}

/**
 * GET /api/planner/sessions?region=Ericeira&days=7&tz=Europe/Lisbon
 */
router.get("/sessions", async (req, res) => {
  try {
    const region = (req.query.region || "").toString();
    const days = Math.max(1, Math.min(parseInt(req.query.days || "7", 10), 7));
    const tz = (req.query.tz || "UTC").toString();

    // 1) Load user prefs (list) and availability
    const prefsList = await selfGet(
      req,
      `/api/planner/prefs/list${region ? `?region=${encodeURIComponent(region)}` : ""}`
    ) || [];

    if (!Array.isArray(prefsList) || prefsList.length === 0) {
      return res.json({ generatedAt: new Date().toISOString(), timezone: tz, windows: [] });
    }

    const availability = await selfGet(req, "/api/planner/availability") || [];
    // availability items look like: { Dow, StartHour }
    const availSet = new Set(availability.map(a => `${a.Dow}@${a.StartHour}`));

    // 2) Score weights (tweak later)
    const W = { h: 1.0, p: 0.8, sd: 0.7, wd: 1.0, ws: 1.0, t: 0.5 };

    // 3) For each preferred break, read cached forecast and build sessions
    const windows = [];

    for (const pref of prefsList) {
      const breakId = pref.BreakId;
      if (!breakId) continue;

      // Pull cached 168h
      const fc = await fetch(
        `${req.protocol}://${req.get("host")}/api/forecast/timeseries?breakId=${breakId}&hours=168&includeTide=1`
      );
      if (!fc.ok) continue;
      const fcJson = await fc.json();
      const items = Array.isArray(fcJson?.items) ? fcJson.items : [];
      if (!items.length) continue;

      // Look at next N days only
      const cutoff = Date.now() + days * 86400000;

      // Iterate hours, decide which ones fall into user's availability 2-hour slots.
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const tsMs = it.ts * 1000;
        if (tsMs > cutoff) break;

        const d0 = new Date(tsMs);
        const { dow, hour } = dowHourInTZ(d0, tz);
        const key = `${dow}@${hour}`;

        if (!availSet.has(key)) continue;

        // Candidate window = [hour, hour+1]
        const itNext = items[i + 1];
        // Make sure the next hour is actually the next local hour in the same tz (wrap allowed)
        let okNext = false;
        if (itNext) {
          const d1 = new Date(itNext.ts * 1000);
          const h0 = hour;
          const { dow: dow1, hour: h1 } = dowHourInTZ(d1, tz);
          okNext = (dow1 === dow && h1 === ((h0 + 1) % 24)) || (dow1 === ((dow + (h0 === 23 ? 1 : 0)) % 7) && h1 === ((h0 + 1) % 24));
        }

        // Score hour 0
        const s0 = hourlyScore(it, pref, W);
        let s1 = null;
        if (okNext) s1 = hourlyScore(itNext, pref, W);

        // Window score = mean of available hours (prefer both)
        const nums = [s0.score].concat(s1 ? [s1.score] : []);
        const windowScore = nums.reduce((a, b) => a + b, 0) / nums.length;

        const bestHour = (!s1 || s0.score >= s1.score) ? it.ts : itNext.ts;

        windows.push({
          breakId: breakId,
          breakName: pref.BreakName || fcJson?.break?.name || `#${breakId}`,
          region: pref.Region || fcJson?.break?.region || "",
          start: new Date(it.ts * 1000).toISOString(),
          end: new Date((okNext ? itNext.ts : it.ts) * 1000).toISOString(),
          score: Math.round(windowScore * 100),
          why: {
            height: s0.subs.height,
            period: s0.subs.period,
            swellDir: s0.subs.swellDir,
            windDir: s0.subs.windDir,
            windSpeed: s0.subs.windSpeed,
            tide: s0.subs.tide
          },
          bestHour: new Date(bestHour * 1000).toISOString(),
          hourly: [
            {
              ts: new Date(it.ts * 1000).toISOString(),
              score: s0.score,
              wave: it.waveHeightM ?? null,
              per: it.swellPeriodS ?? null,
              swellDir: it.swellDir ?? null,
              windKt: it.windSpeedKt ?? null,
              windDir: it.windDir ?? null,
              tide: it.tideM ?? null
            },
            ...(s1 ? [{
              ts: new Date(itNext.ts * 1000).toISOString(),
              score: s1.score,
              wave: itNext.waveHeightM ?? null,
              per: itNext.swellPeriodS ?? null,
              swellDir: itNext.swellDir ?? null,
              windKt: itNext.windSpeedKt ?? null,
              windDir: itNext.windDir ?? null,
              tide: itNext.tideM ?? null
            }] : [])
          ]
        });
      }
    }

    // Sort by score desc, then soonest start
    windows.sort((a, b) => (b.score - a.score) || (new Date(a.start) - new Date(b.start)));

    return res.json({
      generatedAt: new Date().toISOString(),
      timezone: tz,
      windows
    });
  } catch (err) {
    console.error("[GET /api/planner/sessions] error:", err);
    return res.status(500).json({ message: String(err.message || err) });
  }
});

export default router;
