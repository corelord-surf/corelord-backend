require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const OpenAI = require('openai');
const { v4: uuidv4 } = require('uuid');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const { expressjwt: jwt } = require('express-jwt');
const jwksRsa = require('jwks-rsa');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 8080;

// ─── SQLITE SETUP ────────────────────────────────────────────────────────────────
const dbPath = path.join(__dirname, 'corelord.db');
const db = new sqlite3.Database(dbPath, err => {
  if (err) {
    console.error('❌ Failed to open SQLite DB:', err);
    process.exit(1);
  }
});

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

// ─── CORS CONFIG ─────────────────────────────────────────────────────────────────
const allowedOrigins = [
  "https://agreeable-ground-04732bc03.1.azurestaticapps.net",
  "http://localhost:5500"
];

const corsOptions = {
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(bodyParser.json());

// ─── JWT VALIDATION FOR ENTRA ID ────────────────────────────────────────────────
app.use(
  jwt({
    secret: jwksRsa.expressJwtSecret({
      cache: true,
      rateLimit: true,
      jwksUri: `https://login.microsoftonline.com/d048d6e2-6e9f-4af0-afcf-58a5ad036480/discovery/v2.0/keys`,
    }),
    audience: "api://315eede8-ee31-4487-b202-81e495e8f9fe", // ✅ MUST match frontend-requested token
    issuer: "https://login.microsoftonline.com/d048d6e2-6e9f-4af0-afcf-58a5ad036480/v2.0",
    algorithms: ["RS256"],
  }).unless({ path: ["/health", "/", "/api/debug-audience"] }) // 👈 allow debug-audience open
);

// ─── HEALTHCHECK & DEFAULT ───────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.send('🌊 Corelord backend root is up');
});

app.get('/health', (req, res) => {
  res.send('✅ Corelord backend (SQLite) is running');
});

app.get('/api/debug-audience', (req, res) => {
  res.send({
    audience: "api://315eede8-ee31-4487-b202-81e495e8f9fe",
    message: "✅ This backend is using the correct audience for JWT validation."
  });
});

// ─── DEBUG TOKEN DECODING ────────────────────────────────────────────────────────
app.post('/api/debug', (req, res) => {
  res.json({
    message: 'Token received',
    headers: req.headers,
    user: req.user || 'No decoded token user',
  });
});

// ─── PROFILE ENDPOINTS ───────────────────────────────────────────────────────────
app.post('/api/profile', (req, res) => {
  const email = req.user?.preferred_username;
  const { name, region, phone, updates, availability } = req.body;

  if (!email) {
    return res.status(400).json({ error: 'No email in token' });
  }

  const stmt = db.prepare(`
    INSERT INTO Profiles (email, name, region, phone, updates, availability)
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
    function (err) {
      if (err) {
        console.error('❌ SQLite write error:', err);
        return res.status(500).json({ error: 'Failed to save profile' });
      }
      res.json({ message: 'Profile saved successfully' });
    }
  );
  stmt.finalize();
});

app.get('/api/profile', (req, res) => {
  const email = req.user?.preferred_username;
  if (!email) return res.status(400).json({ error: 'No email in token' });

  db.get(`SELECT * FROM Profiles WHERE email = ?`, [email], (err, row) => {
    if (err) {
      console.error('❌ DB read error:', err);
      return res.status(500).json({ error: 'DB error' });
    }
    if (!row) return res.status(404).json({ error: 'Profile not found' });
    res.json({
      ...row,
      updates: JSON.parse(row.updates || "[]"),
      availability: JSON.parse(row.availability || "[]"),
    });
  });
});

// ─── SURF PLANNER ───────────────────────────────────────────────────────────────
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.post('/api/surfplan', async (req, res) => {
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
    console.error('❌ OpenAI error:', err);
    res.status(500).json({ error: 'Something went wrong with AI response.' });
  }
});

// ─── START SERVER ───────────────────────────────────────────────────────────────
app.listen(port, () => {
  console.log(`🚀 CoreLord backend listening on port ${port}`);
});
