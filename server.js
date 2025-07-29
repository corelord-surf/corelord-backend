require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const OpenAI = require('openai');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');
const sql = require('mssql');

const app = express();
const port = process.env.PORT || 8080;

// ─── CONNECT TO AZURE SQL (Option 1: raw connection string) ─────────────────
const connStr = process.env.SQLAZURECONNSTR_CorelordDb;
console.log('⛓️ Raw SQL string:', connStr);

sql.connect(connStr)
  .then(() => console.log('✅ Connected to Azure SQL Database'))
  .catch(err => {
    console.error('❌ Azure SQL connection error:', err);
    process.exit(1);
  });

// ─── MIDDLEWARE ─────────────────────────────────────────────────────────────
app.use(cors());
app.use(bodyParser.json());

// ─── HEALTHCHECK ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.send('Corelord backend is running ✅');
});

// ─── AUTH HELPERS ───────────────────────────────────────────────────────────
const users = {}; // in-memory for MVP

function authenticate(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'No token' });

  try {
    const payload = jwt.verify(auth.replace('Bearer ', ''), process.env.JWT_SECRET);
    req.user = payload;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ─── REGISTER / CONFIRM / LOGIN ─────────────────────────────────────────────
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

  if (!await bcrypt.compare(password, u.passwordHash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = jwt.sign({ email }, process.env.JWT_SECRET, { expiresIn: '7d' });
  res.json({ token });
});

// ─── PROFILE SETUP ────────────────────────────────────────────────────────────
app.post('/api/profile', authenticate, async (req, res) => {
  const { email } = req.user;
  const { name, region, phone, updates, availability } = req.body;

  // save in-memory
  users[email].profile = { name, region, phone, updates, availability };
  console.log(`📌 Profile saved for ${email}`, users[email].profile);

  // persist to Azure SQL
  try {
    const pool = await sql.connect(connStr);
    await pool.request()
      .input('email', sql.NVarChar, email)
      .input('name', sql.NVarChar, name)
      .input('region', sql.NVarChar, region)
      .input('phone', sql.NVarChar, phone)
      .input('updates', sql.NVarChar, JSON.stringify(updates))
      .input('availability', sql.NVarChar, JSON.stringify(availability))
      .query(`
        MERGE Profiles AS target
        USING (SELECT @email AS email) AS src
          ON target.email = src.email
        WHEN MATCHED THEN
          UPDATE SET name = @name, region = @region, phone = @phone, updates = @updates, availability = @availability
        WHEN NOT MATCHED THEN
          INSERT (email, name, region, phone, updates, availability)
          VALUES (@email, @name, @region, @phone, @updates, @availability);
      `);
  } catch (err) {
    console.error('DB write error:', err);
    return res.status(500).json({ error: 'Failed to save profile to database' });
  }

  res.json({ message: 'Profile saved successfully' });
});

// ─── SURF PLANNER ─────────────────────────────────────────────────────────────
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

// ─── START SERVER ─────────────────────────────────────────────────────────────
app.listen(port, () => {
  console.log(`🚀 CoreLord backend listening on port ${port}`);
});
