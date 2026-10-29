import express from 'express';
import { io } from 'socket.io-client';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

// Scanner configuration
const CONFIG = {
  maxMonitorMinutes: 10,
  orangeThreshold: 0.70,
  source: 'PumpSwap only',
  autoTrading: false
};

// Basic status endpoint
app.get('/api/status', (_req, res) => {
  res.json({
    ok: true,
    message: 'PumpSwap scanner server is online',
    source: CONFIG.source,
    autoTrading: CONFIG.autoTrading,
    maxMonitorMinutes: CONFIG.maxMonitorMinutes,
    orangeThreshold: CONFIG.orangeThreshold,
    signals: ['GREEN', 'ORANGE', 'ELITE_SNIPER']
  });
});

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`PumpSwap Momentum Scanner running on port ${PORT}`);
});
