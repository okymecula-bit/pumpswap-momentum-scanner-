import express from 'express';
import { io } from 'socket.io-client';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

const CONFIG = {
  maxMonitorMinutes: 10,
  minLiquidityUSD: 10000,

  orangeThreshold: 0.70,
  greenThreshold: 0.80,

  workMinutes: 180,
  restMinutes: 120,

  eliteMinTrades: 8,
  eliteMinWins: 3,
  eliteCooldownMinutes: 30,

  source: 'PumpSwap only',
  autoTrading: false
};

const TELEGRAM_BOT_TOKEN =
  process.env.TELEGRAM_BOT_TOKEN || '';

const TELEGRAM_CHAT_ID =
  process.env.TELEGRAM_CHAT_ID || '';

const telegramEnabled =
  TELEGRAM_BOT_TOKEN.length > 0 &&
  TELEGRAM_CHAT_ID.length > 0;

const shrine = io(
  'https://sol.shrine.trade',
  {
    transports: ['websocket']
  }
);

// ------------------------------
// GLOBAL STATE
// ------------------------------

const monitored = new Map();
const normalAlertsSent = new Set();
const devSellAlertsSent = new Set();
const eliteAlertsSent = new Map();
const eliteWallets = new Map();

let scannerStartedAt = Date.now();
let scannerActive = true;
let solPriceUSD = 0;

// ------------------------------
// HELPERS
// ------------------------------

function safeNumber(value, fallback = 0) {
  const number = Number(value);

  return Number.isFinite(number)
    ? number
    : fallback;
}

function shortAddress(address) {
  if (
    !address ||
    typeof address !== 'string'
  ) {
    return 'unknown';
  }

  if (address.length <= 12) {
    return address;
  }

  return (
    address.slice(0, 6) +
    '...' +
    address.slice(-6)
  );
}

function getAction(trade) {
  if (trade?.is_buy === true) {
    return 'buy';
  }

  if (trade?.is_buy === false) {
    return 'sell';
  }

  if (
    trade?.action === 'buy' ||
    trade?.action === 'sell'
  ) {
    return trade.action;
  }

  return null;
}

function getTradeWallet(trade) {
  return (
    trade?.wallet ||
    trade?.trader ||
    null
  );
}

function getTradeSOL(trade) {
  return safeNumber(
    trade?.sol_amount ??
    trade?.solAmount
  );
}

function getStateByPool(pool) {
  for (
    const state of monitored.values()
  ) {
    if (state.pool === pool) {
      return state;
    }
  }

  return null;
}

function getTokenState(mint) {
  if (!monitored.has(mint)) {
    monitored.set(
      mint,
      {
        mint,
        pool: null,

        startedAt: Date.now(),

        priceUSD: 0,
        mcapUSD: 0,
        liquidityUSD: 0,

        quoteMint: null,
        quoteInPool: 0,
        tokensInPool: 0,

        buys: 0,
        sells: 0,

        buyVolumeSOL: 0,
        sellVolumeSOL: 0,

        uniqueBuyers: new Set(),
        uniqueSellers: new Set(),

        walletStats: new Map(),

        firstPriceUSD: 0,
        latestPriceUSD: 0,
        highestPriceUSD: 0,

        firstTradeAt: Date.now(),
        lastTradeAt: 0,
        lastUpdateAt: 0,

        recentTrades: [],
        buyerTimeline: [],

        devWallet: null,
        creatorLoaded: false,
        metadata: null,

        normalAlertSent: false,
        greenSent: false,
        orangeSent: false,

        latestTrade: null,
        stopTimer: null
      }
    );
  }

  return monitored.get(mint);
}

// ------------------------------
// TELEGRAM
// ------------------------------

async function sendTelegram(message) {
  if (!telegramEnabled) {
    console.log(
      'TELEGRAM NOT CONFIGURED'
    );

    return false;
  }

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: 'POST',

        headers: {
          'Content-Type':
            'application/json'
        },

        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text: message,
          disable_web_page_preview: true
        })
      }
    );

    const result =
      await response.json();

    if (!result.ok) {
      console.log(
        'TELEGRAM ERROR:',
        result
      );

      return false;
    }

    return true;
  } catch (error) {
    console.log(
      'TELEGRAM SEND FAILED:',
      error.message
    );

    return false;
  }
}

// ------------------------------
// 3 HOURS ON / 2 HOURS OFF
// ------------------------------

function isScannerActive() {
  const cycleMs =
    (
      CONFIG.workMinutes +
      CONFIG.restMinutes
    ) *
    60 *
    1000;

  const position =
    (
      Date.now() -
      scannerStartedAt
    ) % cycleMs;

  return (
    position <
    CONFIG.workMinutes *
      60 *
      1000
  );
}

setInterval(() => {
  const previous =
    scannerActive;

  scannerActive =
    isScannerActive();

  if (
    previous !== scannerActive
  ) {
    console.log(
      scannerActive
        ? 'SCANNER ACTIVE: 3-HOUR WORK PERIOD STARTED'
        : 'SCANNER RESTING: 2-HOUR REST PERIOD STARTED'
    );
  }
}, 60 * 1000);

// ------------------------------
// SOL PRICE
// ------------------------------

shrine.on(
  'sol_price',
  (data) => {
    try {
      solPriceUSD =
        safeNumber(
          data?.priceUSD
        );

      console.log(
        'SOL PRICE:',
        solPriceUSD
      );
    } catch (error) {
      console.log(
        'SOL PRICE ERROR:',
        error.message
      );
    }
  }
);

// ------------------------------
// SHRINE CONNECTION
// ------------------------------

shrine.on(
  'connect',
  () => {
    console.log(
      'SHRINE CONNECTED:',
      shrine.id
    );

    shrine.emit(
      'subscribe_migrations',
      {
        protocols: ['PUMPFUN']
      },
      (ack) => {
        console.log(
          'MIGRATION SUBSCRIPTION:',
          ack
        );
      }
    );

    shrine.emit(
      'subscribe_sol_price',
      (ack) => {
        console.log(
          'SOL PRICE SUBSCRIPTION:',
          ack
        );

        if (
          ack?.snapshot?.priceUSD
        ) {
          solPriceUSD =
            safeNumber(
              ack.snapshot.priceUSD
            );
        }
      }
    );
  }
);

shrine.on(
  'connect_error',
  (error) => {
    console.log(
      'SHRINE CONNECTION ERROR:',
      error.message
    );
  }
);

shrine.on(
  'disconnect',
  (reason) => {
    console.log(
      'SHRINE DISCONNECTED:',
      reason
    );
  }
);

// ------------------------------
// MIGRATIONS
// ------------------------------

shrine.on(
  'migration',
  async (migration) => {
    try {
      console.log(
        'NEW PUMPSWAP MIGRATION:',
        migration
      );

      const mint =
        migration?.mint;

      const pool =
        migration?.new_pool;

      if (
        !mint ||
        !pool
      ) {
        console.log(
          'MIGRATION MISSING MINT OR NEW POOL'
        );

        return;
      }

      if (!scannerActive) {
        console.log(
          'MIGRATION SEEN DURING REST PERIOD:',
          mint
        );

        return;
      }

      await monitorToken(
        mint,
        pool
      );
    } catch (error) {
      console.log(
        'MIGRATION HANDLER ERROR:',
        error.message
      );
    }
  }
);

// ------------------------------
// METADATA
// ------------------------------

async function loadMetadata(
  mint,
  pool
) {
  try {
    const params =
      new URLSearchParams();

    params.set(
      'mint',
      mint
    );

    if (pool) {
      params.set(
        'pool',
        pool
      );
    }

    const response =
      await fetch(
        `https://sol.shrine.trade/metadata?${params.toString()}`
      );

    if (!response.ok) {
      console.log(
        'METADATA HTTP ERROR:',
        response.status,
        mint
      );

      return null;
    }

    const metadata =
      await response.json();

    const state =
      getTokenState(mint);

    state.metadata =
      metadata;

    state.creatorLoaded =
      true;

    if (
      metadata?.creator
    ) {
      state.devWallet =
        metadata.creator;
    }

    console.log(
      'TOKEN METADATA:',
      {
        mint,
        pool: metadata?.pool,
        program: metadata?.program,
        creator: metadata?.creator,
        name: metadata?.name,
        symbol: metadata?.symbol,
        graduated:
          metadata?.graduated
      }
    );

    return metadata;
  } catch (error) {
    console.log(
      'METADATA ERROR:',
      mint,
      error.message
    );

    return null;
  }
}

// ------------------------------
// MONITOR TOKEN
// ------------------------------

async function monitorToken(
  mint,
  pool
) {
  if (monitored.has(mint)) {
    console.log(
      'ALREADY MONITORING:',
      mint
    );

    return;
  }

  const state =
    getTokenState(mint);

  state.pool =
    pool;

  state.startedAt =
    Date.now();

  state.firstTradeAt =
    Date.now();

  console.log(
    'MONITORING PUMPSWAP TOKEN:',
    mint,
    pool
  );

  shrine.emit(
    'subscribe',
    {
      pool
    },
    (ack) => {
      console.log(
        'TOKEN PRICE SUBSCRIPTION:',
        mint,
        ack
      );
    }
  );

  shrine.emit(
    'subscribe_trades',
    {
      pool
    },
    (ack) => {
      console.log(
        'TOKEN TRADE SUBSCRIPTION:',
        mint,
        ack
      );
    }
  );

  await loadMetadata(
    mint,
    pool
  );

  state.stopTimer =
    setTimeout(
      () => {
        unsubscribeToken(
          state
        );
      },
      CONFIG.maxMonitorMinutes *
        60 *
        1000
    );
}

// ------------------------------
// UNSUBSCRIBE
// ------------------------------

function unsubscribeToken(state) {
  if (!state) {
    return;
  }

  try {
    if (state.pool) {
      shrine.emit(
        'unsubscribe',
        {
          pool: state.pool
        }
      );

      shrine.emit(
        'unsubscribe_trades',
        {
          pool: state.pool
        }
      );
    }
  } catch (error) {
    console.log(
      'UNSUBSCRIBE ERROR:',
      state.mint,
      error.message
    );
  }

  if (state.stopTimer) {
    clearTimeout(
      state.stopTimer
    );
  }

  monitored.delete(
    state.mint
  );

  console.log(
    'STOP MONITORING:',
    state.mint
  );
}

// ------------------------------
// TOKEN PRICE UPDATE
// ------------------------------

shrine.on(
  'token_update',
  (update) => {
    try {
      const state =
        getStateByPool(
          update?.pool
        );

      if (!state) {
        return;
      }

      state.priceUSD =
        safeNumber(
          update?.priceUSD
        );

      state.mcapUSD =
        safeNumber(
          update?.mcapUSD
        );

      if (
        !state.firstPriceUSD &&
        state.priceUSD > 0
      ) {
        state.firstPriceUSD =
          state.priceUSD;
      }

      state.latestPriceUSD =
        state.priceUSD;

      if (
        state.priceUSD >
        state.highestPriceUSD
      ) {
        state.highestPriceUSD =
          state.priceUSD;
      }

      state.lastUpdateAt =
        Date.now();

      console.log(
        'TOKEN UPDATE:',
        {
          mint: state.mint,
          pool: state.pool,
          price: state.priceUSD,
          mcap: state.mcapUSD
        }
      );

      evaluateToken(
        state
      );
    } catch (error) {
      console.log(
        'TOKEN UPDATE ERROR:',
        error.message
      );
    }
  }
);

// ------------------------------
// TRADE STREAM
// ------------------------------

shrine.on(
  'trade',
  (trade) => {
    try {
      const state =
        getStateByPool(
          trade?.pool
        );

      if (!state) {
        return;
      }

      const action =
        getAction(trade);

      const wallet =
        getTradeWallet(
          trade
        );

      const solAmount =
        getTradeSOL(
          trade
        );

      if (!action) {
        return;
      }

      state.latestTrade =
        trade;

      state.lastTradeAt =
        Date.now();

      state.quoteMint =
        trade?.quoteMint ||
        state.quoteMint;

      state.quoteInPool =
        safeNumber(
          trade?.quoteInPool
        );

      state.tokensInPool =
        safeNumber(
          trade?.tokensInPool
        );

      updateLiquidity(
        state
      );

      if (
        action === 'buy'
      ) {
        state.buys++;

        state.buyVolumeSOL +=
          solAmount;

        if (wallet) {
          state.uniqueBuyers.add(
            wallet
          );

          updateWalletStats(
            state,
            wallet,
            'buy',
            solAmount
          );

          updateEliteWallet(
            wallet,
            state,
            'buy',
            solAmount
          );
        }
      }

      if (
        action === 'sell'
      ) {
        state.sells++;

        state.sellVolumeSOL +=
          solAmount;

        if (wallet) {
          state.uniqueSellers.add(
            wallet
          );

          updateWalletStats(
            state,
            wallet,
            'sell',
            solAmount
          );

          updateEliteWallet(
            wallet,
            state,
            'sell',
            solAmount
          );
        }
      }

      state.recentTrades.push({
        time: Date.now(),
        action,
        wallet,
        solAmount
      });

      if (
        state.recentTrades.length >
        500
      ) {
        state.recentTrades.shift();
      }

      state.buyerTimeline.push({
        time: Date.now(),
        buyers:
          state.uniqueBuyers.size
      });

      if (
        state.buyerTimeline.length >
        100
      ) {
        state.buyerTimeline.shift();
      }

      console.log(
        'TRADE:',
        {
          mint: state.mint,
          action,
          wallet:
            wallet
              ? shortAddress(wallet)
              : 'unknown',
          solAmount,
          liquidityUSD:
            state.liquidityUSD
        }
      );

      if (
        action === 'sell' &&
        wallet &&
        state.devWallet &&
        wallet === state.devWallet
      ) {
        sendDeveloperSellAlert(
          state,
          solAmount,
          trade
        );
      }

      evaluateEliteSniper(
        wallet
      );

      evaluateToken(
        state
      );
    } catch (error) {
      console.log(
        'TRADE HANDLER ERROR:',
        error.message
      );
    }
  }
);

// ------------------------------
// WALLET STATS
// ------------------------------

function updateWalletStats(
  state,
  wallet,
  side,
  solAmount
) {
  if (
    !state.walletStats.has(wallet)
  ) {
    state.walletStats.set(
      wallet,
      {
        buys: 0,
        sells: 0,
        buySOL: 0,
        sellSOL: 0,
        firstSeen: Date.now()
      }
    );
  }

  const stats =
    state.walletStats.get(
      wallet
    );

  if (side === 'buy') {
    stats.buys++;
    stats.buySOL +=
      solAmount;
  }

  if (side === 'sell') {
    stats.sells++;
    stats.sellSOL +=
      solAmount;
  }
}

// ------------------------------
// LIQUIDITY
// ------------------------------

function updateLiquidity(state) {
  if (
    state.quoteInPool <= 0
  ) {
    return;
  }

  const quote =
    state.quoteMint;

  const WSOL =
    'So11111111111111111111111111111111111111112';

  const USDC =
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGkGZwyTDt1v';

  const USD1 =
    'USD1ttGY1N17NEEHLmELoaybftRBUrhqYiQzvEmuB';

  const USDT =
    'Es9vMFrzaCERmJfrF4H2FYD7f1bXfF4gY7xYw4L1u9Y';

  if (
    quote === WSOL &&
    solPriceUSD > 0
  ) {
    state.liquidityUSD =
      state.quoteInPool *
      solPriceUSD *
      2;

    return;
  }

  if (
    quote === USDC ||
    quote === USD1 ||
    quote === USDT
  ) {
    state.liquidityUSD =
      state.quoteInPool * 2;
  }
}

// ------------------------------
// DEV SELL ALERT
// ------------------------------

async function sendDeveloperSellAlert(
  state,
  solAmount,
  trade
) {
  if (
    !state.normalAlertSent
  ) {
    return;
  }

  if (
    devSellAlertsSent.has(
      state.mint
    )
  ) {
    return;
  }

  devSellAlertsSent.add(
    state.mint
  );

  const message =
    `🚨 DEV SELL DETECTED\n\n` +
    `CA: ${state.mint}\n` +
    `DEV: ${shortAddress(state.devWallet)}\n` +
    `Sold: ${solAmount.toFixed(3)} SOL\n` +
    `MCap: $${Math.round(
      state.mcapUSD
    ).toLocaleString()}\n` +
    `Liquidity: $${Math.round(
      state.liquidityUSD
    ).toLocaleString()}\n` +
    `TX: ${
      trade?.signature ||
      'unknown'
    }`;

  await sendTelegram(
    message
  );

  console.log(
    'DEV SELL ALERT SENT:',
    state.mint
  );
}

// ------------------------------
// BUY PRESSURE
// ------------------------------

function getBuyPressure(state) {
  if (
    state.sellVolumeSOL <= 0
  ) {
    return state.buyVolumeSOL > 0
      ? 3
      : 0;
  }

  return (
    state.buyVolumeSOL /
    state.sellVolumeSOL
  );
}

// ------------------------------
// BUYER GROWTH
// ------------------------------

function getBuyerGrowth(state) {
  const now =
    Date.now();

  const recent =
    state.buyerTimeline.filter(
      x =>
        now - x.time <=
        60 * 1000
    );

  if (
    recent.length < 2
  ) {
    return 0;
  }

  const first =
    recent[0].buyers;

  const last =
    recent[
      recent.length - 1
    ].buyers;

  return Math.max(
    0,
    last - first
  );
}

// ------------------------------
// BUYER CONCENTRATION
// ------------------------------

function getLargestBuyerShare(
  state
) {
  if (
    state.buyVolumeSOL <= 0
  ) {
    return 1;
  }

  let largest = 0;

  for (
    const stats
    of state.walletStats.values()
  ) {
    if (
      stats.buySOL >
      largest
    ) {
      largest =
        stats.buySOL;
    }
  }

  return (
    largest /
    state.buyVolumeSOL
  );
}

// ------------------------------
// SCORE
// ------------------------------

function calculateScore(state) {
  let score = 0;

  if (
    state.liquidityUSD >=
    CONFIG.minLiquidityUSD * 2
  ) {
    score += 20;
  } else if (
    state.liquidityUSD >=
    CONFIG.minLiquidityUSD
  ) {
    score += 15;
  }

  if (
    state.uniqueBuyers.size >= 5
  ) {
    score += 15;
  } else if (
    state.uniqueBuyers.size >= 3
  ) {
    score += 12;
  } else if (
    state.uniqueBuyers.size >= 2
  ) {
    score += 8;
  } else if (
    state.uniqueBuyers.size >= 1
  ) {
    score += 4;
  }

  const buyPressure =
    getBuyPressure(state);

  if (
    buyPressure >= 2
  ) {
    score += 20;
  } else if (
    buyPressure >= 1.5
  ) {
    score += 16;
  } else if (
    buyPressure >= 1.25
  ) {
    score += 12;
  } else if (
    buyPressure >= 1
  ) {
    score += 6;
  }

  if (
    state.firstPriceUSD > 0 &&
    state.latestPriceUSD > 0
  ) {
    const ratio =
      state.latestPriceUSD /
      state.firstPriceUSD;

    if (ratio >= 1.30) {
      score += 20;
    } else if (ratio >= 1.15) {
      score += 15;
    } else if (ratio >= 1.05) {
      score += 10;
    }
  }

  if (
    state.mcapUSD >= 100000
  ) {
    score += 15;
  } else if (
    state.mcapUSD >= 50000
  ) {
    score += 12;
  } else if (
    state.mcapUSD >= 25000
  ) {
    score += 8;
  } else if (
    state.mcapUSD > 0
  ) {
    score += 4;
  }

  const buyerGrowth =
    getBuyerGrowth(state);

  if (
    buyerGrowth >= 5
  ) {
    score += 10;
  } else if (
    buyerGrowth >= 3
  ) {
    score += 7;
  } else if (
    buyerGrowth >= 1
  ) {
    score += 4;
  }

  const concentration =
    getLargestBuyerShare(state);

  if (
    concentration <= 0.30
  ) {
    score += 5;
  } else if (
    concentration <= 0.50
  ) {
    score += 2;
  }

  const maxScore = 120;

  return {
    score,
    percentage:
      score / maxScore,
    buyPressure,
    buyerGrowth,
    concentration
  };
}

// ------------------------------
// TOKEN EVALUATION
// ------------------------------

function evaluateToken(state) {
  if (!state) {
    return;
  }

  // Below $10k liquidity:
  // silently ignore.
  if (
    state.liquidityUSD > 0 &&
    state.liquidityUSD <
      CONFIG.minLiquidityUSD
  ) {
        return;
  }

  if (state.liquidityUSD <= 0) {
    return;
  }

  const result = calculateScore(state);

  if (
    result.percentage >= CONFIG.greenThreshold &&
    !state.greenSent &&
    !state.normalAlertSent
  ) {
    state.greenSent = true;
    state.normalAlertSent = true;

    sendNormalAlert(state, 'GREEN', result);
    return;
  }

  if (
    result.percentage >= CONFIG.orangeThreshold &&
    !state.orangeSent &&
    !state.greenSent &&
    !state.normalAlertSent
  ) {
    state.orangeSent = true;
    state.normalAlertSent = true;

    sendNormalAlert(state, 'ORANGE', result);
  }
}

async function sendNormalAlert(state, signal, result) {
  if (normalAlertsSent.has(state.mint)) {
    return;
  }

  normalAlertsSent.add(state.mint);

  const message =
    `${signal === 'GREEN' ? '🟢' : '🟠'} ${signal} PUMPSWAP\n\n` +
    `CA: ${state.mint}\n` +
    `MCap: $${Math.round(state.mcapUSD).toLocaleString()}\n` +
    `Price: $${state.latestPriceUSD}\n` +
    `Liquidity: $${Math.round(state.liquidityUSD).toLocaleString()}\n` +
    `Buyers: ${state.uniqueBuyers.size}\n` +
    `Sellers: ${state.uniqueSellers.size}\n` +
    `Buys: ${state.buys}\n` +
    `Sells: ${state.sells}\n` +
    `Buy pressure: ${result.buyPressure.toFixed(2)}x\n` +
    `Buyer growth: ${result.buyerGrowth}\n` +
    `Score: ${Math.round(result.percentage * 100)}%\n\n` +
    `⚠️ Signal only — not a profit guarantee.`;

  console.log(
    `${signal} SIGNAL:`,
    state.mint,
    result
  );

  await sendTelegram(message);
}

function updateEliteWallet(wallet, state, side, solAmount) {
  if (!wallet) {
    return;
  }

  if (!eliteWallets.has(wallet)) {
    eliteWallets.set(wallet, {
      trades: 0,
      buys: 0,
      sells: 0,
      buySOL: 0,
      sellSOL: 0,
      tokensSeen: new Set(),
      successfulTokens: new Set(),
      firstSeen: Date.now(),
      lastSeen: Date.now(),
      suspiciousScore: 0
    });
  }

  const stats = eliteWallets.get(wallet);

  stats.trades++;
  stats.lastSeen = Date.now();
  stats.tokensSeen.add(state.mint);

  if (side === 'buy') {
    stats.buys++;
    stats.buySOL += solAmount;
  }

  if (side === 'sell') {
    stats.sells++;
    stats.sellSOL += solAmount;
  }

  if (
    stats.trades >= 2 &&
    stats.buys >= 2 &&
    stats.sellSOL > stats.buySOL * 3
  ) {
    stats.suspiciousScore++;
  }
}

async function evaluateEliteSniper(wallet) {
  if (!wallet) {
    return;
  }

  const stats = eliteWallets.get(wallet);

  if (!stats) {
    return;
  }

  if (stats.trades < CONFIG.eliteMinTrades) {
    return;
  }

  if (stats.buys < CONFIG.eliteMinWins) {
    return;
  }

  if (stats.suspiciousScore >= 3) {
    return;
  }

  const winRate =
    stats.buys /
    Math.max(1, stats.trades);

  if (winRate < 0.50) {
    return;
  }

  const now = Date.now();

  const lastAlert =
    eliteAlertsSent.get(wallet) || 0;

  if (
    now - lastAlert <
    CONFIG.eliteCooldownMinutes * 60 * 1000
  ) {
    return;
  }

  eliteAlertsSent.set(wallet, now);

  console.log(
    'ELITE SNIPER WALLET:',
    shortAddress(wallet),
    {
      trades: stats.trades,
      buys: stats.buys,
      sells: stats.sells,
      tokensSeen: stats.tokensSeen.size,
      winRate
    }
  );
}

setInterval(() => {
  const cutoff =
    Date.now() -
    CONFIG.maxMonitorMinutes * 60 * 1000;

  for (const state of monitored.values()) {
    if (state.startedAt < cutoff) {
      unsubscribeToken(state);
    }
  }

  if (normalAlertsSent.size > 10000) {
    normalAlertsSent.clear();
  }

  if (devSellAlertsSent.size > 10000) {
    devSellAlertsSent.clear();
  }

  if (eliteAlertsSent.size > 10000) {
    eliteAlertsSent.clear();
  }

  const walletCutoff =
    Date.now() -
    24 * 60 * 60 * 1000;

  for (const [wallet, stats] of eliteWallets) {
    if (stats.lastSeen < walletCutoff) {
      eliteWallets.delete(wallet);
    }
  }
}, 60 * 1000);

app.get('/api/status', (_req, res) => {
  res.json({
    ok: true,
    protocols: ['PUMPSWAP'],
    source: CONFIG.source,
    autoTrading: CONFIG.autoTrading,
    scannerActive,
    maxMonitorMinutes: CONFIG.maxMonitorMinutes,
    minLiquidityUSD: CONFIG.minLiquidityUSD,
    orangeThreshold: CONFIG.orangeThreshold,
    greenThreshold: CONFIG.greenThreshold,
    monitoredTokens: monitored.size,
    eliteWallets: eliteWallets.size,
    telegramEnabled,
    solPriceUSD,
    signals: [
      'GREEN',
      'ORANGE',
      'ELITE_SNIPER',
      'DEV_SELL'
    ]
  });
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true
  });
});

process.on('uncaughtException', (error) => {
  console.log(
    'GLOBAL ERROR:',
    error.message
  );
});

process.on('unhandledRejection', (error) => {
  console.log(
    'UNHANDLED PROMISE:',
    error
  );
});

app.listen(PORT, () => {
  console.log(
    `PumpSwap Momentum Scanner running on port ${PORT}`
  );

  console.log(
    'SOURCE:',
    CONFIG.source
  );

  console.log(
    'AUTO TRADING:',
    CONFIG.autoTrading
  );

  console.log(
    'TELEGRAM ENABLED:',
    telegramEnabled
  );

  console.log(
    'MONITOR WINDOW:',
    CONFIG.maxMonitorMinutes,
    'minutes'
  );

  console.log(
    'MIN LIQUIDITY:',
    CONFIG.minLiquidityUSD
  );

  console.log(
    'SCHEDULE:',
    CONFIG.workMinutes,
    'minutes ON /',
    CONFIG.restMinutes,
    'minutes OFF'
  );
});
