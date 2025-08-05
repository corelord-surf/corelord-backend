// routes/planner.js
import express from 'express';
import { sql, poolPromise } from '../db.js';
import verifyToken from '../auth/verifyToken.js';

const router = express.Router();
router.use(verifyToken);

function getEmailFromToken(claims = {}) {
  return (
    claims.preferred_username ||
    claims.email ||
    claims.upn ||
    claims.unique_name ||
    null
  );
}

// GET /api/planner/regions
router.get('/regions', async (_req, res) => {
  res.json([{ name: 'Ericeira' }, { name: 'Torquay' }]);
});

// GET /api/planner/breaks?region=Ericeira
router.get('/breaks', async (req, res) => {
  const region = req.query.region;
  if (!region) return res.status(400).json({ message: 'region is required' });

  try {
    const pool = await poolPromise;
    const result = await pool.request()
      .input('region', sql.NVarChar, region)
      .query(`
        SELECT Id, Name, Region, Latitude, Longitude
        FROM dbo.SurfBreaks
        WHERE Region = @region
        ORDER BY Name ASC
      `);
    res.json(result.recordset);
  } catch (err) {
    console.error('[GET /planner/breaks] Error:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// GET /api/planner/prefs?breakId=123
router.get('/prefs', async (req, res) => {
  const email = getEmailFromToken(req.user);
  const breakId = parseInt(req.query.breakId, 10);

  if (!email) return res.status(400).json({ message: 'Email claim missing in token' });
  if (!breakId) return res.status(400).json({ message: 'breakId is required' });

  try {
    const pool = await poolPromise;
    const result = await pool.request()
      .input('email', sql.NVarChar, email)
      .input('breakId', sql.Int, breakId)
      .query(`
        SELECT TOP 1
          MinHeightM, MaxHeightM, MinPeriodS, MaxPeriodS,
          AllowedSwellDirs, MaxWindKt, AllowedWindDirs,
          MinTideM, MaxTideM, UpdatedAt
        FROM dbo.UserBreakPrefs
        WHERE UserEmail = @email AND BreakId = @breakId
        ORDER BY UpdatedAt DESC
      `);

    if (result.recordset.length === 0) return res.status(204).end();
    res.json(result.recordset[0]);
  } catch (err) {
    console.error('[GET /planner/prefs] Error:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// POST /api/planner/prefs
router.post('/prefs', async (req, res) => {
  const email = getEmailFromToken(req.user);
  if (!email) return res.status(400).json({ message: 'Email claim missing in token' });

  const {
    breakId,
    minHeight, maxHeight,
    minPeriod, maxPeriod,
    swellDirs, maxWind,
    windDirs, minTide, maxTide
  } = req.body || {};

  if (!breakId) return res.status(400).json({ message: 'breakId is required' });

  if (minHeight != null && maxHeight != null && Number(minHeight) > Number(maxHeight)) {
    return res.status(400).json({ message: 'Min height must be less than max height' });
  }
  if (minPeriod != null && maxPeriod != null && Number(minPeriod) > Number(maxPeriod)) {
    return res.status(400).json({ message: 'Min period must be less than max period' });
  }
  if (minTide != null && maxTide != null && Number(minTide) > Number(maxTide)) {
    return res.status(400).json({ message: 'Min tide must be less than max tide' });
  }

  try {
    const pool = await poolPromise;

    const check = await pool.request()
      .input('email', sql.NVarChar, email)
      .input('breakId', sql.Int, breakId)
      .query(`
        SELECT Id FROM dbo.UserBreakPrefs
        WHERE UserEmail = @email AND BreakId = @breakId
      `);

    const dirs1 = Array.isArray(swellDirs) ? swellDirs.join(',') : (swellDirs || null);
    const dirs2 = Array.isArray(windDirs) ? windDirs.join(',') : (windDirs || null);

    if (check.recordset.length > 0) {
      await pool.request()
        .input('email', sql.NVarChar, email)
        .input('breakId', sql.Int, breakId)
        .input('minHeight', sql.Float, minHeight ?? null)
        .input('maxHeight', sql.Float, maxHeight ?? null)
        .input('minPeriod', sql.Float, minPeriod ?? null)
        .input('maxPeriod', sql.Float, maxPeriod ?? null)
        .input('swellDirs', sql.NVarChar, dirs1)
        .input('maxWind', sql.Int, maxWind ?? null)
        .input('windDirs', sql.NVarChar, dirs2)
        .input('minTide', sql.Float, minTide ?? null)
        .input('maxTide', sql.Float, maxTide ?? null)
        .query(`
          UPDATE dbo.UserBreakPrefs
          SET MinHeightM = @minHeight,
              MaxHeightM = @maxHeight,
              MinPeriodS = @minPeriod,
              MaxPeriodS = @maxPeriod,
              AllowedSwellDirs = @swellDirs,
              MaxWindKt = @maxWind,
              AllowedWindDirs = @windDirs,
              MinTideM = @minTide,
              MaxTideM = @maxTide,
              UpdatedAt = GETDATE()
          WHERE UserEmail = @email AND BreakId = @breakId
        `);
    } else {
      await pool.request()
        .input('email', sql.NVarChar, email)
        .input('breakId', sql.Int, breakId)
        .input('minHeight', sql.Float, minHeight ?? null)
        .input('maxHeight', sql.Float, maxHeight ?? null)
        .input('minPeriod', sql.Float, minPeriod ?? null)
        .input('maxPeriod', sql.Float, maxPeriod ?? null)
        .input('swellDirs', sql.NVarChar, dirs1)
        .input('maxWind', sql.Int, maxWind ?? null)
        .input('windDirs', sql.NVarChar, dirs2)
        .input('minTide', sql.Float, minTide ?? null)
        .input('maxTide', sql.Float, maxTide ?? null)
        .query(`
          INSERT INTO dbo.UserBreakPrefs
            (UserEmail, BreakId, MinHeightM, MaxHeightM, MinPeriodS, MaxPeriodS,
             AllowedSwellDirs, MaxWindKt, AllowedWindDirs, MinTideM, MaxTideM, UpdatedAt)
          VALUES
            (@email, @breakId, @minHeight, @maxHeight, @minPeriod, @maxPeriod,
             @swellDirs, @maxWind, @windDirs, @minTide, @maxTide, GETDATE())
        `);
    }

    res.status(200).json({ message: 'Preferences saved' });
  } catch (err) {
    console.error('[POST /planner/prefs] Error:', err);
    res.status(500).json({ message: 'Failed to save preferences' });
  }
});

// List saved prefs
router.get('/prefs/list', async (req, res) => {
  const email = getEmailFromToken(req.user);
  const region = req.query.region || null;
  if (!email) return res.status(400).json({ message: 'Email claim missing in token' });

  try {
    const pool = await poolPromise;
    const request = pool.request().input('email', sql.NVarChar, email);
    let where = 'WHERE p.UserEmail = @email';
    if (region) {
      request.input('region', sql.NVarChar, region);
      where += ' AND b.Region = @region';
    }

    const result = await request.query(`
      SELECT
        p.BreakId,
        b.Name    AS BreakName,
        b.Region  AS Region,
        p.MinHeightM, p.MaxHeightM,
        p.MinPeriodS, p.MaxPeriodS,
        p.AllowedSwellDirs, p.MaxWindKt, p.AllowedWindDirs,
        p.MinTideM, p.MaxTideM,
        p.UpdatedAt
      FROM dbo.UserBreakPrefs p
      INNER JOIN dbo.SurfBreaks b ON b.Id = p.BreakId
      ${where}
      ORDER BY b.Region, b.Name
    `);

    if (result.recordset.length === 0) return res.status(204).end();
    res.json(result.recordset);
  } catch (err) {
    console.error('[GET /planner/prefs/list] Error:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Delete a pref row for a break
router.delete('/prefs', async (req, res) => {
  const email = getEmailFromToken(req.user);
  const breakId = parseInt(req.query.breakId, 10);

  if (!email) return res.status(400).json({ message: 'Email claim missing in token' });
  if (!breakId) return res.status(400).json({ message: 'breakId is required' });

  try {
    const pool = await poolPromise;
    await pool.request()
      .input('email', sql.NVarChar, email)
      .input('breakId', sql.Int, breakId)
      .query(`
        DELETE FROM dbo.UserBreakPrefs
        WHERE UserEmail = @email AND BreakId = @breakId
      `);
    res.status(204).end();
  } catch (err) {
    console.error('[DELETE /planner/prefs] Error:', err);
    res.status(500).json({ message: 'Failed to delete preferences' });
  }
});

/**
 * WEEKLY AVAILABILITY
 * Table expected:
 * CREATE TABLE dbo.UserAvailability (
 *   UserEmail NVARCHAR(256) NOT NULL,
 *   Dow TINYINT NOT NULL,           -- 0=Sun ... 6=Sat
 *   StartHour TINYINT NOT NULL,     -- 0..23 local hour
 *   UpdatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
 *   CONSTRAINT PK_UserAvailability PRIMARY KEY (UserEmail, Dow, StartHour)
 * );
 */

// GET /api/planner/availability
router.get('/availability', async (req, res) => {
  const email = getEmailFromToken(req.user);
  if (!email) return res.status(400).json({ message: 'Email claim missing in token' });

  try {
    const pool = await poolPromise;
    const result = await pool.request()
      .input('email', sql.NVarChar, email)
      .query(`
        SELECT Dow, StartHour
        FROM dbo.UserAvailability
        WHERE UserEmail = @email
        ORDER BY Dow, StartHour
      `);

    if (result.recordset.length === 0) return res.status(204).end();
    res.json(result.recordset); // [{Dow, StartHour}, ...]
  } catch (err) {
    console.error('[GET /planner/availability] Error:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// POST /api/planner/availability
// Body: [{ dow: 0..6, startHour: 0..23 }, ...] each block represents a two hour slot starting at startHour
router.post('/availability', async (req, res) => {
  const email = getEmailFromToken(req.user);
  if (!email) return res.status(400).json({ message: 'Email claim missing in token' });

  const items = Array.isArray(req.body) ? req.body : [];
  for (const it of items) {
    if (typeof it.dow !== 'number' || it.dow < 0 || it.dow > 6) {
      return res.status(400).json({ message: 'Invalid dow value' });
    }
    if (typeof it.startHour !== 'number' || it.startHour < 0 || it.startHour > 23) {
      return res.status(400).json({ message: 'Invalid startHour value' });
    }
  }

  try {
    const pool = await poolPromise;

    // wipe existing
    await pool.request()
      .input('email', sql.NVarChar, email)
      .query(`DELETE FROM dbo.UserAvailability WHERE UserEmail = @email`);

    if (items.length > 0) {
      // build one INSERT with many VALUES, all parameterised
      const req = pool.request();
      req.input('email', sql.NVarChar, email);

      const values = [];
      items.forEach((it, i) => {
        req.input(`d${i}`, sql.TinyInt, it.dow);
        req.input(`h${i}`, sql.TinyInt, it.startHour);
        values.push(`(@email, @d${i}, @h${i})`);
      });

      const sqlText = `
        INSERT INTO dbo.UserAvailability (UserEmail, Dow, StartHour)
        VALUES ${values.join(',')}
      `;
      await req.query(sqlText);
    }

    res.status(200).json({ message: 'Availability saved' });
  } catch (err) {
    console.error('[POST /planner/availability] Error:', err);
    res.status(500).json({ message: 'Failed to save availability' });
  }
});

export default router;
