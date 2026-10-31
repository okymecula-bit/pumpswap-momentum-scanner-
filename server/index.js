import express from 'express';
import { io } from 'socket.io-client';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

const CONFIG = {
  maxMonitorMinutes: 10,
  orangeThreshold: 0.70,
  minLiquidityUSD: 10000,
  source: 'PumpSwap only',
  autoTrading: false
};

const shrine = io('https://sol.shrine.trade');

shrine.on('connect', () => {
  console.log('SHRINE CONNECTED:', shrine.id);

  shrine.emit(
    'subscribe_migrations',
    { protocols: ['PUMPFUN'] },
    (ack) => {
      console.log('MIGRATION SUBSCRIPTION:', ack);
    }
  );
});

shrine.on('migration', (migration) => {
  console.log('NEW PUMPSWAP MIGRATION:', migration);
  console.log('MIGRATION KEYS:', Object.keys(migration));

  const mint = migration.mint;
  const pool = migration.new_pool;

  if (!mint || !pool) {
    console.log('MIGRATION MISSING MINT OR NEW POOL');
    return;
  }

  monitorToken(mint, pool);
});

function monitorToken(mint, pool) {
  console.log('MONITORING PUMPSWAP TOKEN:', mint, pool);

  shrine.emit('subscribe', { mint }, (ack) => {
    console.log('TOKEN SUBSCRIPTION:', mint, ack);
  });

  setTimeout(() => {
    shrine.emit('unsubscribe', { mint });
    console.log('STOP MONITORING:', mint);
  }, CONFIG.maxMonitorMinutes * 60 * 1000);
}

shrine.on('token_update', (update) => {
  console.log('TOKEN UPDATE:', update);
});

app.get('/api/status', (_req, res) => {
  res.json({
    protocols: ['PUMPSWAP'],
    ok: true,
    source: CONFIG.source,
    autoTrading: CONFIG.autoTrading,
    maxMonitorMinutes: CONFIG.maxMonitorMinutes,
    minLiquidityUSD: CONFIG.minLiquidityUSD,
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
