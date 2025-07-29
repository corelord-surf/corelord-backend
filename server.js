require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const OpenAI = require('openai');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');

const app = express();
const port = process.env.PORT || 8080;

// In-memory storage (for MVP/demo purposes)
const users = {}; // { email: { passwordHash, confirmed, favourites: [], profile: {}, token } }

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

app.use(cors());
app.use(bodyParser.json());

// ✅ Health check
app.get('/health', (req, res) => {
  res.send('Corelord backend is running ✅');
});

// ✅ Register new user
app.post('/register', async (req, res) => {
  const { email, password } = req.body;

  if (users[email]) {
    return res.status(400).json({ error: 'User already exists' });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const confirmationToken = uuidv4();

  users[email] = {
    passwordHash,
    confirmed: false,
    confirmationToken,
    favourites: [],
  };

  // TODO: Send confirmationToken via email
  console.log(`Confirmation token for ${email}: ${confirmationToken}`);

  res.json({ message: 'User registered. Please confirm your email.' });
});

// ✅ Confirm user email
app.post('/confirm', (req, res) => {
  const { email, token } = req.body;

  const user = users[email];
  if (!user || user.confirmationToken !== token) {
    return res.status(400).json({ error: 'Invalid token or email' });
  }

  user.confirmed = true;
  delete user.confirmationToken;

  res.json({ message: 'Email confirmed!' });
});

// ✅ Login
app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const user = users[email];

  if (!user || !user.confirmed) {
    return res.status(403).json({ error: 'Email not confirmed or user not found' });
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = jwt.sign({ email }, process.env.JWT_SECRET, { expiresIn: '7d' });
  res.json({ token });
});

// ✅ Middleware to verify login
function authenticate(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'No token' });

  try {
    const payload = jwt.verify(auth.replace('Bearer ', ''), process.env.JWT_SECRET);
    req.user = payload;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ✅ Set favourite surf breaks
app.post('/favourites', authenticate, (req, res) => {
  const { email } = req.user;
  const { favourites } = req.body;

  if (!Array.isArray(favourites) || favourites.length > 5) {
    return res.status(400).json({ error: 'Must be up to 5 surf breaks' });
  }

  users[email].favourites = favourites;
  res.json({ message: 'Favourites updated' });
});

// ✅ Get favourites
app.get('/favourites', authenticate, (req, res) => {
  const { email } = req.user;
  res.json({ favourites: users[email].favourites || [] });
});

// ✅ Profile setup endpoint
app.post('/api/profile', authenticate, (req, res) => {
  const { email } = req.user;
  const { name, region, phone, updates, availability } = req.body;

  users[email].profile = {
    name,
    region,
    phone,
    updates,
    availability,
  };

  console.log(`📌 Profile saved for ${email}`, users[email].profile);

  res.json({ message: 'Profile saved successfully' });
});

// ✅ Surf planning endpoint
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

    const reply = chatCompletion.choices[0].message.content;
    res.json({ plan: reply });
  } catch (error) {
    if (error.response) {
      console.error('OpenAI API Error:', error.response.status, error.response.data);
      res.status(error.response.status).json({ error: error.response.data });
    } else {
      console.error('OpenAI error:', error.message);
      res.status(500).json({ error: 'Something went wrong with AI response.' });
    }
  }
});

// ✅ Placeholder: Entra ID Integration
// TODO: Add user to Entra ID here when account is created

app.listen(port, () => {
  console.log(`🚀 Corelord backend running on port ${port}`);
});
