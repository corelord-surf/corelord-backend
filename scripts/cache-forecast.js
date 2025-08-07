// scripts/cache-forecast.js
import fetch from 'node-fetch';
import { sql, poolPromise } from '../db.js';

const API_BASE = 'https://corelord-backend-etgpd9dfdufragfb.westeurope-01.azurewebsites.net';
const HOURS = 168;

async function getAllBreaks() {
  const pool = await poolPromise;
  const result = await pool.request().query(`
    SELECT Id, Name, Region FROM dbo.SurfBreaks
    WHERE Latitude IS NOT NULL AND Longitude IS NOT NULL
  `);
  return result.recordset;
}

async function cacheForecastForBreak(breakId, breakName, region) {
  const url = `${API_BASE}/api/cache/daily?breakId=${breakId}&hours=${HOURS}`;
  console.log(`→ Caching ${HOURS}h for ${breakName} (${region})...`);

  try {
    const res = await fetch(url);
    if (!res.ok) {
      const msg = await res.text();
      console.error(`✖ Failed for ${breakName} (${res.status}): ${msg}`);
      return;
    }

    const json = await res.json();
    console.log(`✔ Cached ${json.items || 0} entries for ${breakName}`);
  } catch (err) {
    console.error(`✖ Error for ${breakName}: ${err.message}`);
  }
}

async function main() {
  const breaks = await getAllBreaks();
  console.log(`Found ${breaks.length} breaks to cache`);

  for (const brk of breaks) {
    await cacheForecastForBreak(brk.Id, brk.Name, brk.Region);
  }

  console.log('✅ All done.');
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
