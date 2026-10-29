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

const shrine = io('https://sol.shrine.trade');// Basic status endpoint
app.get('/api/status', (_req, res) => {
   shrine.emit('subscribe_migrations', { res.json({
       protocols: ['PUMPFUN']ok: true,
     });message: 'PumpSwap scanner server is online',
     shrine.on('migration', (migration) => {
  console.log('NEW PUMPSWAP MIGRATION:', migration);
});source: CONFIG.source,
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
