import express from 'express';
import fs from 'fs-extra';
const router = express.Router();

const dataFile = './data/user-data.json';

// GET: Fetch the current user's profile
router.get('/', async (req, res) => {
  try {
    const data = await fs.readJson(dataFile);
    const user = data.find(u => u.oid === req.user.oid);

    if (!user) {
      return res.status(404).json({ message: 'Profile not found' });
    }

    res.json(user);
  } catch (error) {
    console.error('Error reading profile:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// POST: Update or create the user's profile
router.post('/', async (req, res) => {
  try {
    const data = await fs.readJson(dataFile);

    const newProfile = {
      oid: req.user.oid,  // Extracted from validated Entra ID token
      name: req.body.name || '',
      preferredBreak: req.body.preferredBreak || '',
      availability: req.body.availability || []
    };

    const existingIndex = data.findIndex(u => u.oid === req.user.oid);

    if (existingIndex >= 0) {
      data[existingIndex] = newProfile;
    } else {
      data.push(newProfile);
    }

    await fs.writeJson(dataFile, data, { spaces: 2 });
    res.status(200).json({ message: 'Profile saved successfully' });

  } catch (error) {
    console.error('Error saving profile:', error);
    res.status(500).json({ message: 'Failed to save profile' });
  }
});

export default router;
