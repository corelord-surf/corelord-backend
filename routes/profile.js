// routes/profile.js
import express from 'express';
import { sql, poolPromise } from '../db.js';
import verifyToken from '../auth/verifyToken.js';

const router = express.Router();
router.use(verifyToken);

// GET: Retrieve the current user's profile
router.get('/', async (req, res) => {
  try {
    const pool = await poolPromise;
    const email = req.user?.preferred_username;

    const result = await pool.request()
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

    // Always return these four keys for the frontend
    const payload = {
      name: row.FullName ?? null,
      email,
      country: row.Country ?? null,
      phone: row.PhoneNumber ?? null,
    };

    return res.status(200).json(payload);
  } catch (err) {
    console.error('Error retrieving profile:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

// POST: Create or update the user's profile
router.post('/', async (req, res) => {
  try {
    const pool = await poolPromise;
    const { name, country, phone } = req.body;
    const email = req.user?.preferred_username;

    // Upsert by email (case-insensitive)
    const check = await pool.request()
      .input('email', sql.NVarChar, email)
      .query(`
        SELECT Id FROM UserProfiles
        WHERE LOWER(Email) = LOWER(@email)
      `);

    if (check.recordset.length > 0) {
      await pool.request()
        .input('email', sql.NVarChar, email)
        .input('fullName', sql.NVarChar, name)
        .input('country', sql.NVarChar, country)
        .input('phoneNumber', sql.NVarChar, phone)
        .query(`
          UPDATE UserProfiles
          SET FullName = @fullName,
              Country = @country,
              PhoneNumber = @phoneNumber
          WHERE LOWER(Email) = LOWER(@email)
        `);
    } else {
      await pool.request()
        .input('email', sql.NVarChar, email)
        .input('fullName', sql.NVarChar, name)
        .input('country', sql.NVarChar, country)
        .input('phoneNumber', sql.NVarChar, phone)
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
