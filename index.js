import express from 'express';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

app.get('/api/status', (_req, res) => {
  res.json({
    ok: true,
    message: 'PumpSwap scanner server is online',
    source: 'PumpSwap only',
    minimumAgeMinutes: 5,
    observationWindow: '3-15 minutes',
    confirmationMinutes: 1
  });
});

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`PumpSwap Momentum Scanner running on port ${PORT}`);
});
