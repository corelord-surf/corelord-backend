require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const sql = require('mssql');
const OpenAI = require('openai');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');

const app = express();
const port = process.env.PORT || 8080;

// --- Azure SQL Setup ---
const sqlConfig = {
  connectionString: process.env.CorelordDb,       // injected from "SQLAZURECONNSTR_CorelordDb"
};

// Create a global connection pool
let pool;
async function initDb() {
  try {
    pool = await sql.connect(sqlConfig);
    console.log('✅ Connected to Azure SQL');
    await ensureTables();
  } catch (err) {
    console.error('❌ SQL connection error:', err);
    process.exit(1);
  }
}

// Ensure the tables exist (users + favourites + profiles)
async function ensureTables() {
  const req = pool.request();
  await req.query(`
    IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'Users')
      CREATE TABLE Users (
        Email NVARCHAR(256) PRIMARY KEY,
        PasswordHash NVARCHAR(200),
        Confirmed BIT       DEFAULT 0,
        ConfirmationToken NVARCHAR(100),
        Name NVARCHAR(100),
        Region NVARCHAR(50),
        Phone NVARCHAR(50),
        UpdatesPreference NVARCHAR(20),
        Availability NVARCHAR(MAX)
      );
  `);
  await req.query(`
    IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'Favourites')
      CREATE TABLE Favourites (
        Email NVARCHAR(256),
        BreakName NVARCHAR(100),
        PRIMARY KEY (Email, BreakName),
        FOREIGN KEY (Email) REFERENCES Users(Email)
      );
  `);
}

// --- OpenAI setup ---
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// --- Express middleware ---
app.use(cors());
app.use(bodyParser.json());

// Health check
app.get('/health', (req, res) => res.send('Corelord backend is running ✅'));

// Register
app.post('/register', async (req, res) => {
  const { email, password } = req.body;
  try {
    // check exists
    const { recordset } = await pool.request()
      .input('email', sql.NVarChar, email)
      .query('SELECT Email FROM Users WHERE Email=@email');
    if (recordset.length) {
      return res.status(400).json({ error: 'User already exists' });
    }
    const passwordHash = await bcrypt.hash(password, 10);
    const confirmationToken = uuidv4();
    await pool.request()
      .input('email', sql.NVarChar, email)
      .input('passwordHash', sql.NVarChar, passwordHash)
      .input('token', sql.NVarChar, confirmationToken)
      .query(`
        INSERT INTO Users (Email, PasswordHash, ConfirmationToken)
         VALUES (@email, @passwordHash, @token)
      `);
    console.log(`Confirmation token for ${email}: ${confirmationToken}`);
    res.json({ message: 'User registered. Please confirm your email.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Confirm email
app.post('/confirm', async (req, res) => {
  const { email, token } = req.body;
  try {
    const { recordset } = await pool.request()
      .input('email', sql.NVarChar, email)
      .input('token', sql.NVarChar, token)
      .query(`
        SELECT * FROM Users
         WHERE Email=@email AND ConfirmationToken=@token
      `);
    if (!recordset.length) {
      return res.status(400).json({ error: 'Invalid token or email' });
    }
    await pool.request()
      .input('email', sql.NVarChar, email)
      .query(`
        UPDATE Users
         SET Confirmed=1, ConfirmationToken=NULL
         WHERE Email=@email
      `);
    res.json({ message: 'Email confirmed!' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Confirmation failed' });
  }
});

// Login
app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const { recordset } = await pool.request()
      .input('email', sql.NVarChar, email)
      .query('SELECT * FROM Users WHERE Email=@email');
    const user = recordset[0];
    if (!user || !user.Confirmed) {
      return res.status(403).json({ error: 'Email not confirmed or user not found' });
    }
    const valid = await bcrypt.compare(password, user.PasswordHash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const token = jwt.sign({ email }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({ token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Auth middleware
function authenticate(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'No token' });
  try {
    const payload = jwt.verify(auth.replace('Bearer ', ''), process.env.JWT_SECRET);
    req.user = payload;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// Save profile
app.post('/api/profile', authenticate, async (req, res) => {
  const { email } = req.user;
  const { name, region, phone, updates, availability } = req.body;
  try {
    await pool.request()
      .input('email', sql.NVarChar, email)
      .input('name',  sql.NVarChar, name)
      .input('region',sql.NVarChar, region)
      .input('phone', sql.NVarChar, phone)
      .input('updates',sql.NVarChar, updates)
      .input('avail', sql.NVarChar, JSON.stringify(availability))
      .query(`
        UPDATE Users
         SET Name=@name,
             Region=@region,
             Phone=@phone,
             UpdatesPreference=@updates,
             Availability=@avail
         WHERE Email=@email
      `);
    res.json({ message: 'Profile saved successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Saving profile failed' });
  }
});

// Favourites
app.post('/favourites', authenticate, async (req, res) => {
  const { email } = req.user;
  const { favourites } = req.body;
  if (!Array.isArray(favourites) || favourites.length > 5) {
    return res.status(400).json({ error: 'Must be up to 5 surf breaks' });
  }
  try {
    // delete existing
    await pool.request()
      .input('email', sql.NVarChar, email)
      .query('DELETE FROM Favourites WHERE Email=@email');
    // insert new
    const ps = new sql.PreparedStatement(pool);
    ps.input('email', sql.NVarChar);
    ps.input('break', sql.NVarChar);
    await ps.prepare('INSERT INTO Favourites (Email, BreakName) VALUES (@email,@break)');
    for (let b of favourites) {
      await ps.execute({ email, break: b });
    }
    await ps.unprepare();
    res.json({ message: 'Favourites updated' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Updating favourites failed' });
  }
});

// Get favourites
app.get('/favourites', authenticate, async (req, res) => {
  const { email } = req.user;
  try {
    const { recordset } = await pool.request()
      .input('email', sql.NVarChar, email)
      .query('SELECT BreakName FROM Favourites WHERE Email=@email');
    res.json({ favourites: recordset.map(r => r.BreakName) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Fetching favourites failed' });
  }
});

// Surf plan
app.post('/api/surfplan', async (req, res) => {
  try {
    const { break: surfBreak, availability, conditions } = req.body;
    const prompt = `Create a surf plan based on:
- Surf break: ${surfBreak}
- Availability: ${Array.isArray(availability) ? availability.join(', ') : availability}
- Preferred conditions: ${conditions}

Output should include ideal days and any tips.`;
    const chatCompletion = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [{ role: 'user', content: prompt }],
    });
    res.json({ plan: chatCompletion.choices[0].message.content });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Surf plan generation failed' });
  }
});

// Start server
initDb().then(() => {
  app.listen(port, () => console.log(`🚀 Server listening on port ${port}`));
});
