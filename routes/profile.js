// routes/profile.js
import express from 'express';
import { sql, poolPromise } from '../db.js';
import verifyToken from '../auth/verifyToken.js';

const router = express.Router();
router.use(verifyToken);

// GET: Retrieve the current user's profile
router.get('/', async (req, res) => {
  try {
    const email = req.user?.preferred_username;
    if (!email) return res.status(400).json({ message: 'Email not found in token' });

    const pool = await poolPromise;
    const result = await pool
      .request()
      .input('email', sql.NVarChar, email)
      .query(`
        SELECT TOP 1 FullName, Country, PhoneNumber
        FROM UserProfiles
        WHERE LOWER(Email) = LOWER(@email)
      `);

    if (result.recordset.length === 0) {
      return res.status(404).json({ message: 'Profile not found' });
    }

    const row = result.recordset[0];
    return res.status(200).json({
      name: row.FullName || null,
      country: row.Country || null,
      phone: row.PhoneNumber || null,
      email,
    });
  } catch (err) {
    console.error('Error retrieving profile:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

// POST: Create or update the user's profile
router.post('/', async (req, res) => {
  try {
    const email = req.user?.preferred_username;
    if (!email) return res.status(400).json({ message: 'Email not found in token' });

    const { name, country, phone } = req.body || {};
    const pool = await poolPromise;

    // Upsert pattern
    const check = await pool
      .request()
      .input('email', sql.NVarChar, email)
      .query(`
        SELECT Id FROM UserProfiles WHERE LOWER(Email) = LOWER(@email)
      `);

    if (check.recordset.length > 0) {
      await pool
        .request()
        .input('email', sql.NVarChar, email)
        .input('fullName', sql.NVarChar, name || null)
        .input('country', sql.NVarChar, country || null)
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
        .input('fullName', sql.NVarChar, name || null)
        .input('country', sql.NVarChar, country || null)
        .input('phoneNumber', sql.NVarChar, phone || null)
        .query(`
          INSERT INTO UserProfiles (Email, FullName, Country, PhoneNumber, CreatedAt)
          VALUES (@email, @fullName, @country, @phoneNumber, GETDATE())
        `);
    }

    return res.status(200).json({ message: 'Profile saved successfully' });
  } catch (err) {
    console.error('Error saving profile:', err);
    return res.status(500).json({ message: 'Failed to save profile' });
  }
});

export default router;
