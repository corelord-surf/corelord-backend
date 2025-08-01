import express from 'express';
import cors from 'cors';
import profileRouter from './routes/profile.js';
import verifyToken from './auth/verifyToken.js';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Protected route
app.use('/api/profile', verifyToken, profileRouter);

app.get('/', (req, res) => {
  res.send('CoreLord backend is running.');
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
