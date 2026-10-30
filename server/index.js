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
shrine.on('connect', () => {
  console.log('SHRINE CONNECTED:', shrine.id);
  shrine.emit('subscribe_migrations', {});
});
app.get('/api/status', (_req, res) => {
     shrine.emit('subscribe_migrations', {});
         res.json({
         protocols: ['PUMPFUN'],
         ok: true,
      source: CONFIG.source,
    autoTrading: CONFIG.autoTrading,
        maxMonitorMinutes: CONFIG.maxMonitorMinutes,
        orangeThreshold: CONFIG.orangeThreshold,
        signals: ['GREEN', 'ORANGE', 'ELITE_SNIPER']
      });
  });
shrine.on('migration', (migration) => {
  console.log('NEW PUMPSWAP MIGRATION:', migration);
  console.log('MIGRATION KEYS:', Object.keys(migration));
  monitorToken(migration.mint, migration.pool);
  });
app.get('/health', (_req, res) => {
  res.json({ ok: true });
});
  app.listen(PORT, () => {
  console.log(`PumpSwap Momentum Scanner running on port ${PORT}`);
});
function monitorToken(mint, pool) {
  console.log('MONITORING PUMPSWAP TOKEN:', mint, pool);
         setTimeout(() => {
               console.log('STOP MONITORING:', mint);
             }, CONFIG.maxMonitorMinutes * 60 * 1000);
}
