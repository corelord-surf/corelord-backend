import express from 'express';
import { sql, poolPromise } from '../db.js';
import verifyToken from '../auth/verifyToken.js';

const router = express.Router();
router.use(verifyToken);

// GET: Retrieve the current user's profile
router.get('/', async (req, res) => {
  try {
    const pool = await poolPromise;
    const result = await pool.request()
      .input('email', sql.NVarChar, req.user.preferred_username)
      .query('SELECT FullName, Country, PhoneNumber FROM UserProfiles WHERE Email = @email');

    if (result.recordset.length === 0) {
      return res.status(404).json({ message: 'Profile not found' });
    }

    res.status(200).json(result.recordset[0]);
  } catch (err) {
    console.error('Error retrieving profile:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// POST: Create or update the user's profile
router.post('/', async (req, res) => {
  try {
    const pool = await poolPromise;
    const { name, country, phone } = req.body;
    const email = req.user.preferred_username;

    // Check if user already exists
    const check = await pool.request()
      .input('email', sql.NVarChar, email)
      .query('SELECT Id FROM UserProfiles WHERE Email = @email');

    if (check.recordset.length > 0) {
      // Update existing profile
      await pool.request()
        .input('email', sql.NVarChar, email)
        .input('fullName', sql.NVarChar, name)
        .input('country', sql.NVarChar, country)
        .input('phoneNumber', sql.NVarChar, phone)
        .query(`
          UPDATE UserProfiles
          SET FullName = @fullName, Country = @country, PhoneNumber = @phoneNumber
          WHERE Email = @email
        `);
    } else {
      // Insert new profile
      await pool.request()
        .input('email', sql.NVarChar, email)
        .input('fullName', sql.NVarChar, name)
        .input('country', sql.NVarChar, country)
        .input('phoneNumber', sql.NVarChar, phone)
        .query(`
          INSERT INTO UserProfiles (Email, FullName, Country, PhoneNumber)
          VALUES (@email, @fullName, @country, @phoneNumber)
        `);
    }

    res.status(200).json({ message: 'Profile saved successfully' });
  } catch (err) {
    console.error('Error saving profile:', err);
    res.status(500).json({ message: 'Failed to save profile' });
  }
});

export default router;
