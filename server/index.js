import express from 'express';
import { io } from 'socket.io-client';

const app = express();
const PORT = Number(process.env.PORT || 3000);

app.use(express.json());
app.use(express.static('public'));

const CONFIG = {
  maxMonitorMinutes: 10,

  // Strategy minimums
  minMcapUSD: 7000,
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

// ------------------------------
// TELEGRAM CONFIG
// ------------------------------

const TELEGRAM_BOT_TOKEN =
  process.env.TELEGRAM_BOT_TOKEN || '';

const TELEGRAM_CHAT_ID =
  process.env.TELEGRAM_CHAT_ID || '';

const telegramEnabled =
  Boolean(
    TELEGRAM_BOT_TOKEN &&
    TELEGRAM_CHAT_ID
  );

// ------------------------------
// SHRINE
// ------------------------------

const shrine = io(
  'https://sol.shrine.trade',
  {
    transports: ['websocket'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10000,
    timeout: 20000
  }
);

// ------------------------------
// GLOBAL STATE
// ------------------------------

const monitored = new Map();
const poolToMint = new Map();

const normalAlertsSent =
  new Set();

const devSellAlertsSent =
  new Set();

const eliteAlertsSent =
  new Map();

const eliteWallets =
  new Map();

const scannerStartedAt =
  Date.now();

let scannerActive = true;
let solPriceUSD = 0;

// ------------------------------
// HELPERS
// ------------------------------

function safeNumber(
  value,
  fallback = 0
) {
  const n = Number(value);

  return Number.isFinite(n)
    ? n
    : fallback;
}

function shortAddress(
  address
) {
  if (
    typeof address !== 'string' ||
    !address
  ) {
    return 'unknown';
  }

  if (
    address.length <= 12
  ) {
    return address;
  }

  return (
    address.slice(0, 6) +
    '...' +
    address.slice(-6)
  );
}

function getAction(
  trade
) {
  if (
    typeof trade?.is_buy ===
    'boolean'
  ) {
    return trade.is_buy
      ? 'buy'
      : 'sell';
  }

  if (
    trade?.action === 'buy' ||
    trade?.action === 'sell'
  ) {
    return trade.action;
  }

  return null;
}

function getTradeWallet(
  trade
) {
  return (
    trade?.wallet ||
    trade?.trader ||
    trade?.user ||
    null
  );
}

function getTradeSOL(
  trade
) {
  return safeNumber(
    trade?.sol_amount ??
    trade?.solAmount ??
    trade?.quote_amount ??
    trade?.quoteAmount ??
    trade?.amount
  );
}

// ------------------------------
// TOKEN STATE
// ------------------------------

function getTokenState(
  mint
) {
  if (!mint) {
    return null;
  }

  let state =
    monitored.get(mint);

  if (state) {
    return state;
  }

  state = {
    mint,

    pool: null,

    startedAt:
      Date.now(),

    firstTradeAt:
      Date.now(),

    lastTradeAt: 0,
    lastUpdateAt: 0,

    priceUSD: 0,
    mcapUSD: 0,

    liquidityUSD: 0,
    liquidityKnown: false,

    quoteMint: null,
    quoteInPool: 0,
    tokensInPool: 0,

    buys: 0,
    sells: 0,

    buyVolumeSOL: 0,
    sellVolumeSOL: 0,

    uniqueBuyers:
      new Set(),

    uniqueSellers:
      new Set(),

    walletStats:
      new Map(),

    recentTrades: [],

    buyerTimeline: [],

    firstPriceUSD: 0,
    latestPriceUSD: 0,
    highestPriceUSD: 0,

    devWallet: null,

    metadata: null,

    normalAlertSent: false,
    greenSent: false,
    orangeSent: false,

    lastTradeSignature:
      null,

    stopTimer: null
  };

  monitored.set(
    mint,
    state
  );

  return state;
}

// ------------------------------
// FIND TOKEN BY MINT OR POOL
// ------------------------------

function findState(
  event
) {
  const mint =
    event?.mint;

  const pool =
    event?.pool;

  if (
    mint &&
    monitored.has(mint)
  ) {
    return monitored.get(
      mint
    );
  }

  if (
    pool &&
    poolToMint.has(pool)
  ) {
    return monitored.get(
      poolToMint.get(pool)
    );
  }

  if (pool) {
    for (
      const state
      of monitored.values()
    ) {
      if (
        state.pool === pool
      ) {
        return state;
      }
    }
  }

  return null;
}

// ------------------------------
// TELEGRAM
// ------------------------------

async function sendTelegram(
  message
) {
  if (
    !telegramEnabled
  ) {
    return false;
  }

  try {
    const response =
      await fetch(
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
        {
          method: 'POST',

          headers: {
            'Content-Type':
              'application/json'
          },

          body:
            JSON.stringify({
              chat_id:
                TELEGRAM_CHAT_ID,

              text:
                message,

              disable_web_page_preview:
                true
            })
        }
      );

    const result =
      await response.json();

    if (
      !result.ok
    ) {
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
      error?.message || error
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

setInterval(
  () => {
    const previous =
      scannerActive;

    scannerActive =
      isScannerActive();

    if (
      previous !==
      scannerActive
    ) {
      console.log(
        scannerActive
          ? 'SCANNER ACTIVE: 3-HOUR WORK PERIOD STARTED'
          : 'SCANNER RESTING: 2-HOUR REST PERIOD STARTED'
      );
    }
  },
  60 * 1000
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
        protocols: [
          'PUMPFUN'
        ]
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

        const price =
          safeNumber(
            ack?.snapshot
              ?.priceUSD
          );

        if (
          price > 0
        ) {
          solPriceUSD =
            price;
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
      error?.message ||
        error
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
// SOL PRICE
// ------------------------------

shrine.on(
  'sol_price',
  (data) => {
    const price =
      safeNumber(
        data?.priceUSD ??
        data?.price
      );

    if (
      price > 0
    ) {
      solPriceUSD =
        price;

      console.log(
        'SOL PRICE:',
        solPriceUSD
      );
    }
  }
);

// ------------------------------
// SHRINE SUBSCRIPTION ERRORS
// ------------------------------

shrine.on(
  'subscription_error',
  (error) => {
    console.log(
      'SHRINE SUBSCRIPTION ERROR:',
      error
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
        migration?.new_pool ||
        migration?.toPool ||
        migration?.pool;

      if (
        !mint ||
        !pool
      ) {
        console.log(
          'MIGRATION MISSING MINT OR NEW POOL:',
          {
            mint,
            pool,
            migration
          }
        );

        return;
      }

      if (
        !scannerActive
      ) {
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
        error?.stack ||
          error?.message ||
          error
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
      new URLSearchParams({
        mint
      });

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

    if (
      !response.ok
    ) {
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
      getTokenState(
        mint
      );

    if (!state) {
      return null;
    }

    state.metadata =
      metadata;

    state.devWallet =
      metadata?.creator ||
      metadata?.pumpfun?.creator ||
      state.devWallet;

    state.quoteMint =
      metadata?.quote ||
      state.quoteMint;

    console.log(
      'TOKEN METADATA:',
      {
        mint,
        pool:
          metadata?.pool,

        program:
          metadata?.program,

        creator:
          state.devWallet,

        name:
          metadata?.name,

        symbol:
          metadata?.symbol,

        quote:
          metadata?.quote,

        graduated:
          metadata?.graduated
      }
    );

    return metadata;
  } catch (error) {
    console.log(
      'METADATA ERROR:',
      mint,
      error?.message ||
        error
    );

    return null;
  }
}

// ------------------------------
// SUBSCRIBE TOKEN
// ------------------------------

async function subscribeToken(
  state
) {
  if (
    !state?.pool
  ) {
    return;
  }

  shrine.emit(
    'subscribe',
    {
      pool:
        state.pool
    },
    (ack) => {
      console.log(
        'TOKEN PRICE SUBSCRIPTION:',
        state.mint,
        ack
      );

      if (
        ack?.error
      ) {
        console.log(
          'PRICE SUBSCRIPTION FAILED:',
          state.mint,
          ack
        );
      }
    }
  );

  shrine.emit(
    'subscribe_trades',
    {
      pool:
        state.pool
    },
    (ack) => {
      console.log(
        'TOKEN TRADE SUBSCRIPTION:',
        state.mint,
        ack
      );

      if (
        ack?.error
      ) {
        console.log(
          'TRADE SUBSCRIPTION FAILED:',
          state.mint,
          ack
        );
      } else {
        console.log(
          'TRADE STREAM ACTIVE:',
          state.mint,
          state.pool
        );
      }
    }
  );
}

// ------------------------------
// MONITOR TOKEN
// ------------------------------

async function monitorToken(
  mint,
  pool
) {
  const existing =
    monitored.get(mint);

  if (existing) {
    if (
      !existing.pool &&
      pool
    ) {
      existing.pool =
        pool;

      poolToMint.set(
        pool,
        mint
      );

      await subscribeToken(
        existing
      );
    }

    console.log(
      'ALREADY MONITORING:',
      mint
    );

    return;
  }

  const state =
    getTokenState(
      mint
    );

  state.pool =
    pool;

  poolToMint.set(
    pool,
    mint
  );

  console.log(
    'MONITORING PUMPSWAP TOKEN:',
    mint,
    pool
  );

  await loadMetadata(
    mint,
    pool
  );

  await subscribeToken(
    state
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

function unsubscribeToken(
  state
) {
  if (!state) {
    return;
  }

  try {
    if (
      state.pool
    ) {
      shrine.emit(
        'unsubscribe',
        {
          pool:
            state.pool
        }
      );

      shrine.emit(
        'unsubscribe_trades',
        {
          pool:
            state.pool
        }
      );

      poolToMint.delete(
        state.pool
      );
    }
  } catch (error) {
    console.log(
      'UNSUBSCRIBE ERROR:',
      state.mint,
      error?.message ||
        error
    );
  }

  if (
    state.stopTimer
  ) {
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
// LIQUIDITY
// ------------------------------

function updateLiquidityFromEvent(
  state,
  event
) {
  const quoteMint =
    event?.quote ||
    event?.quoteMint ||
    state.quoteMint;

  const quoteInPool =
    safeNumber(
      event?.quoteInPool ??
      event?.quote_in_pool ??
      event?.quoteReserve ??
      event?.quote_reserve
    );

  if (
    quoteMint
  ) {
    state.quoteMint =
      quoteMint;
  }

  if (
    quoteInPool > 0
  ) {
    state.quoteInPool =
      quoteInPool;
  }

  if (
    state.quoteInPool <= 0
  ) {
    return;
  }

  const WSOL =
    'So11111111111111111111111111111111111111112';

  const USDC =
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGkGZwyTDt1v';

  const USD1 =
    'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB';

  const USDT =
    'Es9vMFrzaCERmJfrF4H2FYD7f1bXfF4gY7xYw4L1u9Y';

  if (
    quoteMint === WSOL &&
    solPriceUSD > 0
  ) {
    state.liquidityUSD =
      state.quoteInPool *
      solPriceUSD *
      2;

    state.liquidityKnown =
      true;
  } else if (
    quoteMint === USDC ||
    quoteMint === USD1 ||
    quoteMint === USDT
  ) {
    state.liquidityUSD =
      state.quoteInPool * 2;

    state.liquidityKnown =
      true;
  }
}

// ------------------------------
// TOKEN PRICE UPDATE
// ------------------------------

shrine.on(
  'token_update',
  (update) => {
    try {
      const state =
        findState(update);

      if (!state) {
        return;
      }

      state.priceUSD =
        safeNumber(
          update?.priceUSD ??
          update?.price
        );

      state.mcapUSD =
        safeNumber(
          update?.mcapUSD ??
          update?.mcap
        );

      state.quoteMint =
        update?.quote ||
        state.quoteMint;

      state.lastUpdateAt =
        Date.now();

      if (
        state.priceUSD > 0
      ) {
        if (
          !state.firstPriceUSD
        ) {
          state.firstPriceUSD =
            state.priceUSD;
        }

        state.latestPriceUSD =
          state.priceUSD;

        state.highestPriceUSD =
          Math.max(
            state.highestPriceUSD,
            state.priceUSD
          );
      }

      console.log(
        'TOKEN UPDATE:',
        {
          mint:
            state.mint,

          pool:
            state.pool,

          priceUSD:
            state.priceUSD,

          mcapUSD:
            state.mcapUSD
        }
      );

      evaluateToken(
        state
      );
    } catch (error) {
      console.log(
        'TOKEN UPDATE ERROR:',
        error?.stack ||
          error?.message ||
          error
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
        findState(trade);

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
        console.log(
          'TRADE WITHOUT SIDE:',
          trade
        );

        return;
      }

      if (
        trade?.signature &&
        trade.signature ===
          state.lastTradeSignature
      ) {
        return;
      }

      state.lastTradeSignature =
        trade?.signature ||
        null;

      state.lastTradeAt =
        Date.now();

      if (
        trade?.quote
      ) {
        state.quoteMint =
          trade.quote;
      }

      updateLiquidityFromEvent(
        state,
        trade
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
      } else {
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

      if (
        trade?.price &&
        solPriceUSD > 0 &&
        state.quoteMint ===
          'So11111111111111111111111111111111111111112'
      ) {
        state.latestPriceUSD =
          safeNumber(
            trade.price
          ) *
          solPriceUSD;

        if (
          !state.firstPriceUSD &&
          state.latestPriceUSD > 0
        ) {
          state.firstPriceUSD =
            state.latestPriceUSD;
        }

        state.highestPriceUSD =
          Math.max(
            state.highestPriceUSD,
            state.latestPriceUSD
          );
      }

      if (
        trade?.marketcapUSD
      ) {
        state.mcapUSD =
          safeNumber(
            trade.marketcapUSD
          );
      }

      if (
        trade?.marketcap &&
        state.mcapUSD <= 0
      ) {
        const quote =
          state.quoteMint;

        if (
          quote ===
            'So11111111111111111111111111111111111111112' &&
          solPriceUSD > 0
        ) {
          state.mcapUSD =
            safeNumber(
              trade.marketcap
            ) *
            solPriceUSD;
        } else {
          state.mcapUSD =
            safeNumber(
              trade.marketcap
            );
        }
      }

      state.recentTrades.push({
        time:
          Date.now(),

        action,

        wallet,

        solAmount,

        signature:
          trade?.signature ||
          null
      });

      if (
        state.recentTrades.length >
        500
      ) {
        state.recentTrades.shift();
      }

      state.buyerTimeline.push({
        time:
          Date.now(),

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
          mint:
            state.mint,

          pool:
            state.pool,

          action,

          wallet:
            wallet
              ? shortAddress(wallet)
              : 'unknown',

          solAmount,

          signature:
            trade?.signature ||
            'unknown',

          mcapUSD:
            state.mcapUSD,

          liquidityUSD:
            state.liquidityUSD,

          liquidityKnown:
            state.liquidityKnown
        }
      );

      if (
        action === 'sell' &&
        wallet &&
        state.devWallet &&
        wallet ===
          state.devWallet
      ) {
        sendDeveloper
        SellAlert(
          state,
          solAmount,
          trade
        ).catch(
          (error) => {
            console.log(
              'DEV SELL ALERT ERROR:',
              error?.message ||
                error
            );
          }
        );
      }

      evaluateEliteSniper(
        wallet
      ).catch(
        (error) => {
          console.log(
            'ELITE SNIPER ERROR:',
            error?.message ||
              error
          );
        }
      );

      evaluateToken(
        state
      );
    } catch (error) {
      console.log(
        'TRADE HANDLER ERROR:',
        error?.stack ||
          error?.message ||
          error
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
    !state.walletStats.has(
      wallet
    )
  ) {
    state.walletStats.set(
      wallet,
      {
        buys: 0,
        sells: 0,
        buySOL: 0,
        sellSOL: 0,
        firstSeen:
          Date.now()
      }
    );
  }

  const stats =
    state.walletStats.get(
      wallet
    );

  if (
    side === 'buy'
  ) {
    stats.buys++;
    stats.buySOL +=
      solAmount;
  } else {
    stats.sells++;
    stats.sellSOL +=
      solAmount;
  }
}

// ------------------------------
// BUY PRESSURE
// ------------------------------

function getBuyPressure(
  state
) {
  if (
    state.sellVolumeSOL <=
    0
  ) {
    return state.buyVolumeSOL >
      0
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

function getBuyerGrowth(
  state
) {
  const cutoff =
    Date.now() -
    60 * 1000;

  const recent =
    state.buyerTimeline.filter(
      (item) =>
        item.time >= cutoff
    );

  if (
    recent.length < 2
  ) {
    return 0;
  }

  return Math.max(
    0,
    recent[
      recent.length - 1
    ].buyers -
      recent[0].buyers
  );
}

// ------------------------------
// BUYER CONCENTRATION
// ------------------------------

function getLargestBuyerShare(
  state
) {
  if (
    state.buyVolumeSOL <=
    0
  ) {
    return 1;
  }

  let largest = 0;

  for (
    const stats
    of state.walletStats.values()
  ) {
    largest =
      Math.max(
        largest,
        stats.buySOL
      );
  }

  return (
    largest /
    state.buyVolumeSOL
  );
}

// ------------------------------
// SCORE
// ------------------------------

function calculateScore(
  state
) {
  let score = 0;

  if (
    state.liquidityKnown
  ) {
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
  }

  if (
    state.uniqueBuyers.size >=
    5
  ) {
    score += 15;
  } else if (
    state.uniqueBuyers.size >=
    3
  ) {
    score += 12;
  } else if (
    state.uniqueBuyers.size >=
    2
  ) {
    score += 8;
  } else if (
    state.uniqueBuyers.size >=
    1
  ) {
    score += 4;
  }

  const buyPressure =
    getBuyPressure(
      state
    );

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
    state.firstPriceUSD >
      0 &&
    state.latestPriceUSD >
      0
  ) {
    const ratio =
      state.latestPriceUSD /
      state.firstPriceUSD;

    if (
      ratio >= 1.30
    ) {
      score += 20;
    } else if (
      ratio >= 1.15
    ) {
      score += 15;
    } else if (
      ratio >= 1.05
    ) {
      score += 10;
    }
  }

  if (
    state.mcapUSD >= 50000
  ) {
    score += 12;
  } else if (
    state.mcapUSD >= 25000
  ) {
    score += 8;
  } else if (
    state.mcapUSD >=
    CONFIG.minMcapUSD
  ) {
    score += 4;
  }

  const buyerGrowth =
    getBuyerGrowth(
      state
    );

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
    getLargestBuyerShare(
      state
    );

  if (
    concentration <= 0.30
  ) {
    score += 5;
  } else if (
    concentration <= 0.50
  ) {
    score += 2;
  }

  return {
    score,
    percentage:
      score / 120,
    buyPressure,
    buyerGrowth,
    concentration
  };
}

// ------------------------------
// SAFETY
// ------------------------------

function hasHeavyDumping(
  state
) {
  if (
    state.sellVolumeSOL <=
    0
  ) {
    return false;
  }

  if (
    state.buyVolumeSOL <=
    0
  ) {
    return (
      state.sellVolumeSOL >=
      10
    );
  }

  return (
    state.sellVolumeSOL >=
    state.buyVolumeSOL * 3
  );
}

// ------------------------------
// SIGNAL REASONS
// ------------------------------

function getSignalReasons(
  state,
  result
) {
  const reasons = [];

  if (
    state.liquidityKnown
  ) {
    if (
      state.liquidityUSD >=
      CONFIG.minLiquidityUSD * 2
    ) {
      reasons.push(
        'Strong liquidity'
      );
    } else if (
      state.liquidityUSD >=
      CONFIG.minLiquidityUSD
    ) {
      reasons.push(
        'Liquidity above $10k'
      );
    }
  }

  if (
    result.buyPressure >=
    2
  ) {
    reasons.push(
      'Buyers strongly outweigh sellers'
    );
  } else if (
    result.buyPressure >=
    1.25
  ) {
    reasons.push(
      'Positive buyer pressure'
    );
  }

  if (
    result.buyerGrowth >=
    3
  ) {
    reasons.push(
      'Unique buyers are accelerating'
    );
  } else if (
    result.buyerGrowth >=
    1
  ) {
    reasons.push(
      'Holder growth is increasing'
    );
  }

  if (
    state.uniqueBuyers.size >=
    3
  ) {
    reasons.push(
      'Multiple unique buyers'
    );
  }

  if (
    result.concentration <=
    0.30
  ) {
    reasons.push(
      'Buyer distribution is healthy'
    );
  }

  if (
    result.volumeGrowth >=
    1.50
  ) {
    reasons.push(
      'Trading volume is growing strongly'
    );
  }

  if (
    result.buyerAcceleration >=
    0.50
  ) {
    reasons.push(
      'Buyer activity is accelerating'
    );
  }

  if (
    result.buyPressure >=
    0.60
  ) {
    reasons.push(
      'Buyers are stronger than sellers'
    );
  }

  if (
    result.devHolding < 0.10
  ) {
    reasons.push(
      'Developer holding is below 10%'
    );
  }

  if (
    result.liquidityUSD >=
    CONFIG.minLiquidityUSD
  ) {
    reasons.push(
      'Liquidity is above the $10k target'
    );
  }

  if (
    result.score >=
    CONFIG.greenThreshold * 100
  ) {
    reasons.push(
      'Overall momentum is strong'
    );
  }

  if (
    reasons.length === 0
  ) {
    reasons.push(
      'Momentum conditions are developing'
    );
  }

  return reasons;
}

// ------------------------------
// TOKEN EVALUATION
// ------------------------------

function evaluateToken(
  state
) {
  if (!state) {
    return;
  }

  if (
    state.alertSent &&
    !state.devSellAlertSent
  ) {
    return;
  }

  const result =
    calculateScore(state);

  if (!result) {
    return;
  }

  if (
    result.liquidityUSD <
    CONFIG.minLiquidityUSD
  ) {
    return;
  }

  if (
    result.mcapUSD <
    CONFIG.minMcapUSD
  ) {
    return;
  }

  if (
    result.hardBlocked
  ) {
    return;
  }

  const reasons =
    signalReasons(
      state,
      result
    );

  let signal =
    null;

  if (
    result.score >=
    CONFIG.greenThreshold * 100
  ) {
    signal = 'GREEN';
  } else if (
    result.score >=
    CONFIG.orangeThreshold * 100
  ) {
    signal = 'ORANGE';
  }

  if (!signal) {
    return;
  }

  if (
    !normalAlertsSent.has(
      state.mint
    )
  ) {
    normalAlertsSent.add(
      state.mint
    );

    state.alertSent = true;

    sendNormalAlert(
      state,
      signal,
      result,
      reasons
    ).catch(
      (error) => {
        console.log(
          'NORMAL ALERT ERROR:',
          error.message
        );
      }
    );
  }
}

// ------------------------------
// NORMAL ALERT
// ------------------------------

async function sendNormalAlert(
  state,
  signal,
  result,
  reasons
) {
  const message =
    [
      `🚨 ${signal}`,
      '',
      `Token: ${
        state.symbol ||
        state.name ||
        'Unknown'
      }`,
      `CA: ${state.mint}`,
      '',
      `Market Cap: $${Math.round(
        result.mcapUSD
      ).toLocaleString()}`,
      `Liquidity: $${Math.round(
        result.liquidityUSD
      ).toLocaleString()}`,
      `Score: ${result.score.toFixed(1)}%`,
      '',
      'Why it triggered:',
      ...reasons.map(
        (reason) =>
          `• ${reason}`
      )
    ].join('\n');

  await sendTelegram(
    message
  );

  console.log(
    'NORMAL ALERT SENT:',
    state.mint,
    signal
  );
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
    !state ||
    !state.alertSent
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

  const devHolding =
    safeNumber(
      state.devHolding
    );

  const message =
    [
      '⚠️ DEV SELL ALERT',
      '',
      `Token: ${
        state.symbol ||
        state.name ||
        'Unknown'
      }`,
      `CA: ${state.mint}`,
      '',
      `Dev sold: ${solAmount.toFixed(4)} SOL`,
      `Dev remaining: ${
        devHolding
      }%`,
      '',
      'This token had already triggered an alert.'
    ].join('\n');

  await sendTelegram(
    message
  );

  console.log(
    'DEV SELL ALERT SENT:',
    state.mint
  );
}

// ------------------------------
// ELITE WALLET TRACKING
// ------------------------------

function trackEliteWallet(
  wallet,
  trade
) {
  if (!wallet) {
    return;
  }

  let stats =
    eliteWallets.get(
      wallet
    );

  if (!stats) {
    stats = {
      trades: 0,
      wins: 0,
      lastTrade: 0,
      cooldownUntil: 0
    };

    eliteWallets.set(
      wallet,
      stats
    );
  }

  stats.trades += 1;
  stats.lastTrade =
    Date.now();
}

// ------------------------------
// ELITE SNIPER
// ------------------------------

async function evaluateEliteSniper(
  wallet
) {
  if (!wallet) {
    return;
  }

  const stats =
    eliteWallets.get(
      wallet
    );

  if (!stats) {
    return;
  }

  if (
    stats.trades <
    CONFIG.eliteMinTrades
  ) {
    return;
  }

  if (
    stats.wins <
    CONFIG.eliteMinWins
  ) {
    return;
  }

  if (
    Date.now() <
    stats.cooldownUntil
  ) {
    return;
  }

  if (
    eliteAlertsSent.has(
      wallet
    )
  ) {
    return;
  }

  eliteAlertsSent.add(
    wallet
  );

  stats.cooldownUntil =
    Date.now() +
    CONFIG.eliteCooldownMinutes *
      60 *
      1000;

  await sendTelegram(
    [
      '🎯 ELITE SNIPER',
      '',
      `Wallet: ${shortAddress(
        wallet
      )}`,
      `Trades tracked: ${
        stats.trades
      }`,
      `Wins tracked: ${
        stats.wins
      }`
    ].join('\n')
  );

  console.log(
    'ELITE SNIPER ALERT:',
    wallet
  );
}

// ------------------------------
// CLEANUP
// ------------------------------

function cleanupToken(
  mint
) {
  const state =
    monitored.get(
      mint
    );

  if (!state) {
    return;
  }

  if (
    state.pool
  ) {
    poolToMint.delete(
      state.pool
    );

    try {
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
    } catch (error) {
      console.log(
        'UNSUBSCRIBE ERROR:',
        error.message
      );
    }
  }

  monitored.delete(
    mint
  );
}

// ------------------------------
// STATUS
// ------------------------------

app.get(
  '/api/status',
  (req, res) => {
    res.json({
      ok: true,
      shrineConnected:
        shrine.connected,
      telegramEnabled,
      monitoredTokens:
        monitored.size,
      normalAlerts:
        normalAlertsSent.size,
      devSellAlerts:
        devSellAlertsSent.size,
      eliteAlerts:
        eliteAlertsSent.size,
      source:
        CONFIG.source,
      autoTrading:
        CONFIG.autoTrading
    });
  }
);

app.get(
  '/health',
  (req, res) => {
    res.json({
      ok: true,
      shrineConnected:
        shrine.connected,
      telegramEnabled,
      monitored:
        monitored.size
    });
  }
);

// ------------------------------
// GLOBAL ERROR HANDLING
// ------------------------------

process.on(
  'uncaughtException',
  (error) => {
    console.log(
      'GLOBAL ERROR:',
      error.message
    );
  }
);

process.on(
  'unhandledRejection',
  (error) => {
    console.log(
      'UNHANDLED PROMISE:',
      error
    );
  }
);

// ------------------------------
// START SERVER
// ------------------------------

app.listen(
  PORT,
  () => {
    console.log(
      `PumpSwap Momentum Scanner running on port ${PORT}`
    );

    console.log(
      'SHRINE TRADE STREAM: READY'
    );
  }
); 
