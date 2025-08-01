import express from 'express';
import cors from 'cors';
import profileRouter from './routes/profile.js';
// import verifyToken from './auth/verifyToken.js'; // Temporarily disabled

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Temporary mock user middleware (remove later when using verifyToken)
app.use((req, res, next) => {
  req.user = {
    oid: 'mock-user-1234' // Match this to a record in your user-data.json if needed
  };
  next();
});

// Route without token validation for now
app.use('/api/profile', profileRouter);

app.get('/', (req, res) => {
  res.send('CoreLord backend is running.');
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
