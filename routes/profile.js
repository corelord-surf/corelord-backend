// routes/profile.js
import express from 'express';
import { sql, poolPromise } from '../db.js';
import verifyToken from '../auth/verifyToken.js';

const router = express.Router();

// Protect everything under /api/profile
router.use(verifyToken);

/**
 * Helper: extract an email/username from either v1 or v2 AAD tokens.
 * v2: preferred_username or email
 * v1: upn or unique_name
 */
function getEmailFromToken(claims = {}) {
  return (
    claims.preferred_username ||
    claims.email ||
    claims.upn ||
    claims.unique_name ||
    null
  );
}

// GET: Retrieve the current user's profile
router.get('/', async (req, res) => {
  try {
    const pool = await poolPromise;
    const email = getEmailFromToken(req.user);

    if (!email) {
      console.warn('[GET /profile] Missing email claim in token', {
        tokenKeys: Object.keys(req.user || {}),
      });
      return res.status(400).json({ message: 'Email claim missing in token' });
    }

    const result = await pool
      .request()
      .input('email', sql.NVarChar, email)
      .query(`
        SELECT FullName, Country, PhoneNumber
        FROM UserProfiles
        WHERE LOWER(Email) = LOWER(@email)
      `);

    if (result.recordset.length === 0) {
      return res.status(404).json({ message: 'Profile not found' });
    }

    const row = result.recordset[0];

    return res.status(200).json({
      name: row.FullName ?? null,
      email,
      country: row.Country ?? null,
      phone: row.PhoneNumber ?? null,
    });
  } catch (err) {
    console.error('[GET /profile] Error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

// POST: Create or update the user's profile
router.post('/', async (req, res) => {
  try {
    const pool = await poolPromise;
    const email = getEmailFromToken(req.user);

    if (!email) {
      console.warn('[POST /profile] Missing email claim in token', {
        tokenKeys: Object.keys(req.user || {}),
      });
      return res.status(400).json({ message: 'Email claim missing in token' });
    }

    const { name, country, phone } = req.body || {};
    // Basic validation
    if (!name || !country) {
      return res.status(400).json({ message: 'Name and country are required' });
    }

    // Does a row already exist?
    const check = await pool
      .request()
      .input('email', sql.NVarChar, email)
      .query(`
        SELECT Id FROM UserProfiles
        WHERE LOWER(Email) = LOWER(@email)
      `);

    if (check.recordset.length > 0) {
      await pool
        .request()
        .input('email', sql.NVarChar, email)
        .input('fullName', sql.NVarChar, name)
        .input('country', sql.NVarChar, country)
        .input('phoneNumber', sql.NVarChar, phone || null)
        .query(`
          UPDATE UserProfiles
          SET FullName = @fullName,
              Country = @country,
              PhoneNumber = @phoneNumber
          WHERE LOWER(Email) = LOWER(@email)
        `);
    } else {
      await pool
        .request()
        .input('email', sql.NVarChar, email)
        .input('fullName', sql.NVarChar, name)
        .input('country', sql.NVarChar, country)
        .input('phoneNumber', sql.NVarChar, phone || null)
        .query(`
          INSERT INTO UserProfiles (Email, FullName, Country, PhoneNumber, CreatedAt)
          VALUES (@email, @fullName, @country, @phoneNumber, GETDATE())
        `);
    }

    return res.status(200).json({ message: 'Profile saved successfully' });
  } catch (err) {
    console.error('[POST /profile] Error:', err);
    return res.status(500).json({ message: 'Failed to save profile' });
  }
});

export default router;
