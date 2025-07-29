require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const OpenAI = require('openai');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const port = process.env.PORT || 8080;

// ─── SQLITE SETUP ────────────────────────────────────────────────────────────────
// This file lives under your app root; on Azure App Service it persists under /home
const dbPath = path.join(__dirname, 'corelord.db');
const db = new sqlite3.Database(dbPath, err => {
  if (err) {
    console.error('❌ Failed to open SQLite DB:', err);
    process.exit(1);
  }
});

// Create Profiles table if missing
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS Profiles (
      email TEXT PRIMARY KEY,
      name TEXT,
      region TEXT,
      phone TEXT,
      updates TEXT,
      availability TEXT
    )
  `);
  console.log('✅ SQLite table ready at', dbPath);
});

// ─── MIDDLEWARE ─────────────────────────────────────────────────────────────────
app.use(cors());
app.use(bodyParser.json());

// ─── HEALTHCHECK ────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.send('Corelord backend (SQLite) is running ✅');
});

// ─── AUTH HELPERS ───────────────────────────────────────────────────────────────
const users = {}; // in-memory for MVP
function authenticate(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(auth.replace('Bearer ', ''), process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ─── REGISTER / CONFIRM / LOGIN ─────────────────────────────────────────────────
app.post('/register', async (req, res) => {
  const { email, password } = req.body;
  if (users[email]) return res.status(400).json({ error: 'User already exists' });
  const passwordHash = await bcrypt.hash(password, 10);
  const confirmationToken = uuidv4();
  users[email] = { passwordHash, confirmed: false, confirmationToken, favourites: [], profile: {} };
  console.log(`Confirmation token for ${email}: ${confirmationToken}`);
  res.json({ message: 'User registered. Please confirm your email.' });
});

app.post('/confirm', (req, res) => {
  const { email, token } = req.body;
  const u = users[email];
  if (!u || u.confirmationToken !== token) return res.status(400).json({ error: 'Invalid token or email' });
  u.confirmed = true;
  delete u.confirmationToken;
  res.json({ message: 'Email confirmed!' });
});

app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const u = users[email];
  if (!u || !u.confirmed) return res.status(403).json({ error: 'Email not confirmed or user not found' });
  if (!await bcrypt.compare(password, u.passwordHash)) return res.status(401).json({ error: 'Invalid credentials' });
  const token = jwt.sign({ email }, process.env.JWT_SECRET, { expiresIn: '7d' });
  res.json({ token });
});

// ─── PROFILE SETUP ──────────────────────────────────────────────────────────────
app.post('/api/profile', authenticate, (req, res) => {
  const { email } = req.user;
  const { name, region, phone, updates, availability } = req.body;

  // in-memory
  users[email].profile = { name, region, phone, updates, availability };
  console.log(`📌 Saved in-memory profile for ${email}`, users[email].profile);

  // persist to SQLite
  const stmt = db.prepare(`
    INSERT INTO Profiles (email,name,region,phone,updates,availability)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(email) DO UPDATE SET
      name=excluded.name,
      region=excluded.region,
      phone=excluded.phone,
      updates=excluded.updates,
      availability=excluded.availability
  `);

  stmt.run(
    email,
    name,
    region,
    phone,
    JSON.stringify(updates),
    JSON.stringify(availability),
    function(err) {
      if (err) {
        console.error('❌ SQLite write error:', err);
        return res.status(500).json({ error: 'Failed to save profile' });
      }
      res.json({ message: 'Profile saved successfully' });
    }
  );
  stmt.finalize();
});

// ─── SURF PLANNER ───────────────────────────────────────────────────────────────
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.post('/api/surfplan', authenticate, async (req, res) => {
  try {
    const { break: surfBreak, availability, conditions } = req.body;
    const prompt = `Create a surf plan based on:
- Surf break: ${surfBreak}
- Availability: ${Array.isArray(availability) ? availability.join(', ') : availability}
- Preferred conditions: ${conditions}

Output should include ideal days and any tips.`;

    const chat = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [{ role: 'user', content: prompt }]
    });

    res.json({ plan: chat.choices[0].message.content });
  } catch (err) {
    console.error('OpenAI error:', err);
    res.status(500).json({ error: 'Something went wrong with AI response.' });
  }
});

// ─── START SERVER ───────────────────────────────────────────────────────────────
app.listen(port, () => {
  console.log(`🚀 CoreLord backend (SQLite) listening on port ${port}`);
});
