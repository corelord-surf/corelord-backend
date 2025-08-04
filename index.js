// index.js
import express from 'express';
import cors from 'cors';
import profileRouter from './routes/profile.js';

const app = express();
const PORT = process.env.PORT || 3000;

// Allow your Static Web App to call the API
app.use(
  cors({
    origin: [
      'https://calm-coast-025fe8203.2.azurestaticapps.net',
    ],
    methods: ['GET', 'POST', 'OPTIONS'],
  })
);

app.use(express.json());

// IMPORTANT: no mock user middleware here — rely on verifyToken inside routes
app.use('/api/profile', profileRouter);

// Simple health endpoint
app.get('/', (_req, res) => {
  res.send('corelord backend is running.');
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
