import express from 'express';
import { io } from 'socket.io-client';

const app = express();
const PORT = Number(process.env.PORT || 3000);

app.use(express.json());
app.use(express.static('public'));

const CONFIG = {
  maxMonitorMinutes: 10,
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

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const telegramEnabled = Boolean(
  TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID
);

const WSOL =
  'So11111111111111111111111111111111111111112';

const USDC =
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGkGZwyTDt1v';

const USDT =
  'Es9vMFrzaCERmJfrF4H2FYD7fB4xF1H2v4L1u9Y';

const USD1 =
  'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB';

const monitored = new Map();
const poolToMint = new Map();
const normalAlertsSent = new Set();
const devSellAlertsSent = new Set();
const eliteAlertsSent = new Set();
const eliteWallets = new Map();

let scannerStartedAt = Date.now();
let scannerActive = true;
let solPriceUSD = 0;

const safeNumber = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const shortAddress = (address) =>
  address
    ? `${address.slice(0, 6)}...${address.slice(-4)}`
    : 'unknown';

const getAction = (trade) => {
  const raw =
    trade?.action ??
    trade?.side ??
    trade?.type ??
    '';

  if (
    trade?.is_buy === true ||
    trade?.isBuy === true
  ) {
    return 'buy';
  }

  if (
    trade?.is_buy === false ||
    trade?.isBuy === false
  ) {
    return 'sell';
  }

  return String(raw)
    .toLowerCase()
    .includes('sell')
    ? 'sell'
    : 'buy';
};

const getTradeWallet = (trade) =>
  trade?.user ??
  trade?.wallet ??
  trade?.trader ??
  trade?.maker ??
  trade?.owner ??
  trade?.user_address ??
  trade?.wallet_address ??
  null;

const getTradeSOL = (trade) =>
  safeNumber(
    trade?.sol_amount ??
      trade?.solAmount ??
      trade?.quote_amount ??
      trade?.quoteAmount ??
      trade?.sol ??
      trade?.amountSol
  );

const getMint = (event) =>
  event?.mint ??
  event?.token ??
  event?.tokenMint ??
  event?.token_mint ??
  null;

const getPool = (event) =>
  event?.pool ??
  event?.new_pool ??
  event?.pool_address ??
  event?.poolAddress ??
  event?.newPool ??
  null;

const getPriceUSD = (event) =>
  safeNumber(
    event?.priceUSD ??
      event?.price_usd ??
      event?.usdPrice ??
      event?.usd_price ??
      event?.price
  );

const getMcapUSD = (event) =>
  safeNumber(
    event?.marketcapUSD ??
      event?.marketCapUSD ??
      event?.market_cap_usd ??
      event?.mcapUSD ??
      event?.mcap ??
      event?.marketcap
  );

const getSignature = (trade) =>
  trade?.signature ??
  trade?.tx_signature ??
  trade?.txSignature ??
  trade?.transaction ??
  trade?.transactionSignature ??
  null;

const getQuoteMint = (event) =>
  event?.quoteMint ??
  event?.quote_mint ??
  event?.quoteToken ??
  event?.quote_token ??
  null;

const getQuoteReserve = (event) =>
  safeNumber(
    event?.quoteInPool ??
      event?.quote_in_pool ??
      event?.quoteReserve ??
      event?.quote_reserve ??
      event?.quoteAmountInPool ??
      event?.quote_amount_in_pool
  );

function getScannerState() {
  const elapsed =
    Date.now() - scannerStartedAt;

  const cycle =
    (CONFIG.workMinutes +
      CONFIG.restMinutes) *
    60 *
    1000;

  const position = elapsed % cycle;

  return (
    position <
    CONFIG.workMinutes * 60 * 1000
  );
}

function updateScannerSchedule() {
  scannerActive = getScannerState();
}

function formatUSD(value) {
  if (
    !Number.isFinite(value) ||
    value <= 0
  ) {
    return 'unknown';
  }

  return `$${Math.round(value).toLocaleString()}`;
}

function getStateFromEvent(event) {
  const mint = getMint(event);
  const pool = getPool(event);

  if (
    mint &&
    monitored.has(mint)
  ) {
    return monitored.get(mint);
  }

  if (
    pool &&
    poolToMint.has(pool)
  ) {
    return monitored.get(
      poolToMint.get(pool)
    );
  }

  return null;
}

function createTokenState(mint, pool) {
  return {
    mint,
    pool,

    startedAt: Date.now(),
    firstTradeAt: null,
    lastTradeAt: null,
    lastUpdateAt: null,

    name: '',
    symbol: '',
    devWallet: null,
    devHoldingPct: null,
    metadata: null,

    priceUSD: 0,
    mcapUSD: 0,
    firstPriceUSD: 0,
    highestPriceUSD: 0,
    latestPriceUSD: 0,

    liquidityUSD: 0,
    liquidityKnown: false,
    quoteMint: null,
    quoteInPool: 0,

    buys: 0,
    sells: 0,
    buyVolumeSOL: 0,
    sellVolumeSOL: 0,

    uniqueBuyers: new Set(),
    uniqueSellers: new Set(),
    walletStats: new Map(),

    recentTrades: [],
    buyerTimeline: [],
    priceHistory: [],

    normalAlertSent: false,
    devSellAlertSent: false,
    greenSent: false,
    orangeSent: false,

    lastTradeSignature: null,
    stopTimer: null
  };
}

function updateLiquidity(state, event) {
  const directLiquidity = safeNumber(
    event?.liquidityUSD ??
      event?.liquidity_usd ??
      event?.liquidityUsd
  );

  if (directLiquidity > 0) {
    state.liquidityUSD =
      directLiquidity;

    state.liquidityKnown = true;
    return;
  }

  const quote = getQuoteReserve(event);

  const quoteMint =
    getQuoteMint(event) ||
    state.quoteMint;

  if (quote > 0) {
    state.quoteInPool = quote;

    state.quoteMint =
      quoteMint ||
      state.quoteMint;

    if (
      quoteMint === WSOL &&
      solPriceUSD > 0
    ) {
      state.liquidityUSD =
        quote *
        solPriceUSD *
        2;

      state.liquidityKnown = true;
    } else if (
      quoteMint === USDC ||
      quoteMint === USDT ||
      quoteMint === USD1
    ) {
      state.liquidityUSD =
        quote * 2;

      state.liquidityKnown = true;
    }
  }
}

async function fetchMetadata(state) {
  try {
    const url =
      `https://sol.shrine.trade/metadata?mint=${encodeURIComponent(state.mint)}` +
      `&pool=${encodeURIComponent(state.pool)}`;

    const response = await fetch(
      url,
      {
        signal:
          AbortSignal.timeout(10000)
      }
    );

    if (!response.ok) {
      console.log(
        'METADATA HTTP ERROR:',
        response.status
      );
      return;
    }

    const metadata =
      await response.json();

    state.metadata = metadata;

    state.name =
      metadata?.name ??
      metadata?.token?.name ??
      metadata?.data?.name ??
      '';

    state.symbol =
      metadata?.symbol ??
      metadata?.token?.symbol ??
      metadata?.data?.symbol ??
      '';

    state.devWallet =
      metadata?.creator ??
      metadata?.devWallet ??
      metadata?.dev_wallet ??
      metadata?.pumpfun?.creator ??
      metadata?.pumpfun?.devWallet ??
      null;

    state.quoteMint =
      getQuoteMint(metadata) ||
      metadata?.pool?.quoteMint ||
      metadata?.pool?.quote_mint ||
      state.quoteMint;

    const holding =
      safeNumber(
        metadata?.devHoldingPct ??
          metadata?.dev_holding_pct ??
          metadata?.creatorHoldingPct ??
          metadata?.creator_holding_pct
      );

    if (holding > 0) {
      state.devHoldingPct =
        holding;
    }

    updateLiquidity(
      state,
      metadata
    );

    console.log(
      'TOKEN METADATA:',
      state.mint,
      state.name ||
        'unknown',
      state.symbol ||
        'unknown',
      'DEV:',
      shortAddress(
        state.devWallet
      )
    );
  } catch (error) {
    console.log(
      'METADATA ERROR:',
      error.message
    );
  }
}

function subscribeToken(state) {
  if (!shrine.connected) {
    return;
  }

  shrine.emit(
    'subscribe',
    {
      pool: state.pool
    },
    (ack) => {
      console.log(
        'TOKEN SUBSCRIPTION:',
        state.mint,
        ack
      );
    }
  );

  shrine.emit(
    'subscribe_trades',
    {
      pool: state.pool
    },
    (ack) => {
      console.log(
        'TRADE SUBSCRIPTION:',
        state.mint,
        ack
      );
    }
  );
}

function unsubscribeToken(state) {
  if (!shrine.connected) {
    return;
  }

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

async function monitorToken(
  mint,
  pool
) {
  if (!mint || !pool) {
    return;
  }

  if (monitored.has(mint)) {
    const existing =
      monitored.get(mint);

    if (existing.pool !== pool) {
      poolToMint.delete(
        existing.pool
      );

      existing.pool = pool;

      poolToMint.set(
        pool,
        mint
      );

      subscribeToken(
        existing
      );
    }

    return;
  }

  const state =
    createTokenState(
      mint,
      pool
    );

  monitored.set(
    mint,
    state
  );

  poolToMint.set(
    pool,
    mint
  );

  console.log(
    'MONITORING PUMPSWAP:',
    mint,
    'POOL:',
    pool
  );

  subscribeToken(state);

  await fetchMetadata(state);

  state.stopTimer =
    setTimeout(
      () => {
        cleanupToken(mint);
      },
      CONFIG.maxMonitorMinutes *
        60 *
        1000
    );
}

function cleanupToken(mint) {
  const state =
    monitored.get(mint);

  if (!state) {
    return;
  }

  unsubscribeToken(state);

  if (state.stopTimer) {
    clearTimeout(
      state.stopTimer
    );

    state.stopTimer = null;
  }

  poolToMint.delete(
    state.pool
  );

  monitored.delete(mint);

  console.log(
    'MONITOR COMPLETE:',
    mint
  );
}

async function sendTelegram(text) {
  if (!telegramEnabled) {
    return false;
  }

  try {
    const url =
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

    const response =
      await fetch(
        url,
        {
          method: 'POST',
          headers: {
            'content-type':
              'application/json'
          },
          body: JSON.stringify({
            chat_id:
              TELEGRAM_CHAT_ID,
            text,
            disable_web_page_preview:
              true
          }),
          signal:
            AbortSignal.timeout(10000)
        }
      );

    if (!response.ok) {
      console.log(
        'TELEGRAM ERROR:',
        response.status
      );

      return false;
    }

    return true;
  } catch (error) {
    console.log(
      'TELEGRAM ERROR:',
      error.message
    );

    return false;
  }
}

function updateWalletStats(
  state,
  wallet,
  side,
  solAmount
) {
  if (!wallet) {
    return;
  }

  let stats =
    state.walletStats.get(
      wallet
    );

  if (!stats) {
    stats = {
      buys: 0,
      sells: 0,
      buyVolumeSOL: 0,
      sellVolumeSOL: 0
    };

    state.walletStats.set(
      wallet,
      stats
    );
  }

  if (side === 'buy') {
    stats.buys++;
    stats.buyVolumeSOL +=
      solAmount;
  } else {
    stats.sells++;
    stats.sellVolumeSOL +=
      solAmount;
  }
}

function getBuyPressure(state) {
  if (
    state.sellVolumeSOL <= 0
  ) {
    return state.buyVolumeSOL >
      0
      ? Infinity
      : 0;
  }

  return (
    state.buyVolumeSOL /
    state.sellVolumeSOL
  );
}

function getBuyerGrowth(state) {
  if (
    state.buyerTimeline.length <
    2
  ) {
    return 0;
  }

  const now = Date.now();

  const recent =
    state.buyerTimeline.filter(
      (item) =>
        now - item.time <=
        60 * 1000
    ).length;

  const previous =
    state.buyerTimeline.filter(
      (item) =>
        now - item.time >
          60 * 1000 &&
        now - item.time <=
          180 * 1000
    ).length;

  if (previous <= 0) {
    return recent;
  }

  return (
    recent / previous
  );
}

function getVolumeGrowth(state) {
  if (
    state.recentTrades.length <
    2
  ) {
    return 0;
  }

  const now = Date.now();

  const recent =
    state.recentTrades
      .filter(
        (trade) =>
          now - trade.time <=
          60 * 1000
      )
      .reduce(
        (sum, trade) =>
          sum + trade.solAmount,
        0
      );

  const previous =
    state.recentTrades
      .filter(
        (trade) =>
          now - trade.time >
            60 * 1000 &&
          now - trade.time <=
            180 * 1000
      )
      .reduce(
        (sum, trade) =>
          sum + trade.solAmount,
        0
      );

  if (previous <= 0) {
    return recent > 0
      ? Infinity
      : 0;
  }

  return (
    recent / previous
  );
}

function getRepeatBuyerCount(state) {
  let count = 0;

  for (
    const stats of
    state.walletStats.values()
  ) {
    if (stats.buys >= 2) {
      count++;
    }
  }

  return count;
}

function getLargestBuyerShare(state) {
  if (
    state.buyVolumeSOL <= 0
  ) {
    return 1;
  }

  let largest = 0;

  for (
    const stats of
    state.walletStats.values()
  ) {
    largest = Math.max(
      largest,
      stats.buyVolumeSOL
    );
  }

  return (
    largest /
    state.buyVolumeSOL
  );
}

function getPriceMomentum(state) {
  if (
    state.firstPriceUSD <= 0 ||
    state.latestPriceUSD <= 0
  ) {
    return 0;
  }

  return (
    state.latestPriceUSD /
    state.firstPriceUSD
  );
}

function hasHeavyDumping(state) {
  if (
    state.sellVolumeSOL <= 0
  ) {
    return false;
  }

  const pressure =
    state.buyVolumeSOL /
    state.sellVolumeSOL;

  if (
    state.sells >= 8 &&
    pressure < 0.55
  ) {
    return true;
  }

  if (
    state.sellVolumeSOL >
    state.buyVolumeSOL * 1.8
  ) {
    return true;
  }

  return false;
}

function hasExtremeConcentration(state) {
  const largestShare =
    getLargestBuyerShare(state);

  return (
    state.uniqueBuyers.size >=
      3 &&
    largestShare >= 0.70
  );
}

function hasSuspiciousActivity(state) {
  if (
    state.buys < 6 ||
    state.uniqueBuyers.size < 2
  ) {
    return false;
  }

  const largestShare =
    getLargestBuyerShare(state);

  const repeatBuyers =
    getRepeatBuyerCount(state);

  return (
    largestShare >= 0.80 ||
    (
      repeatBuyers >= 3 &&
      state.uniqueBuyers.size <=
        3 &&
      state.buys >= 10
    )
  );
}

function getHardBlock(state) {
  const reasons = [];

  if (
    state.liquidityKnown &&
    state.liquidityUSD > 0 &&
    state.liquidityUSD <
      CONFIG.minLiquidityUSD * 0.5
  ) {
    reasons.push(
      'extremely thin liquidity'
    );
  }

  if (
    hasExtremeConcentration(
      state
    )
  ) {
    reasons.push(
      'extreme buyer concentration'
    );
  }

  if (
    hasSuspiciousActivity(
      state
    )
  ) {
    reasons.push(
      'suspicious coordinated activity'
    );
  }

  if (
    hasHeavyDumping(state)
  ) {
    reasons.push(
      'heavy dumping'
    );
  }

  return {
    blocked:
      reasons.length > 0,
    reasons
  };
}

function calculateScore(state) {
  let score = 0;

  const liquidity =
    state.liquidityUSD;

  if (liquidity >= 20000) {
    score += 15;
  } else if (liquidity >= 15000) {
    score += 13;
  } else if (liquidity >= 10000) {
    score += 10;
  }

  const buyers =
    state.uniqueBuyers.size;

  if (buyers >= 8) {
    score += 15;
  } else if (buyers >= 5) {
    score += 13;
  } else if (buyers >= 3) {
    score += 10;
  } else if (buyers >= 2) {
    score += 7;
  } else if (buyers >= 1) {
    score += 3;
  }

  const pressure =
    getBuyPressure(state);

  if (pressure >= 2) {
    score += 20;
  } else if (pressure >= 1.5) {
    score += 16;
  } else if (pressure >= 1.25) {
    score += 12;
  } else if (pressure >= 1) {
    score += 6;
  }

  const momentum =
    getPriceMomentum(state);

  if (momentum >= 1.30) {
    score += 15;
  } else if (momentum >= 1.15) {
    score += 12;
  } else if (momentum >= 1.05) {
    score += 8;
  }

  const buyerGrowth =
    getBuyerGrowth(state);

  if (buyerGrowth >= 2) {
    score += 10;
  } else if (buyerGrowth >= 1.3) {
    score += 8;
  } else if (buyerGrowth >= 1) {
    score += 4;
  }

  const volumeGrowth =
    getVolumeGrowth(state);

  if (volumeGrowth >= 1.5) {
    score += 10;
  } else if (volumeGrowth >= 1.1) {
    score += 6;
  }

  const largestShare =
    getLargestBuyerShare(state);

  if (largestShare <= 0.30) {
    score += 10;
  } else if (largestShare <= 0.50) {
    score += 5;
  }

  if (
    getRepeatBuyerCount(state) >=
    2
  ) {
    score += 5;
  }

  return {
    score: Math.min(
      100,
      score
    ),

    percentage: Math.min(
      1,
      score / 100
    ),

    buyPressure: pressure,
    buyerGrowth,
    volumeGrowth,
    priceMomentum: momentum,
    largestBuyerShare:
      largestShare,

    liquidityUSD:
      state.liquidityUSD,

    mcapUSD:
      state.mcapUSD
  };
}

function getSignalReasons(
  state,
  result
) {
  const reasons = [];

  if (
    result.liquidityUSD >=
    CONFIG.minLiquidityUSD
  ) {
    reasons.push(
      `liquidity ${formatUSD(
        result.liquidityUSD
      )}`
    );
  }

  if (
    state.mcapUSD >=
    CONFIG.minMcapUSD
  ) {
    reasons.push(
      `market cap ${formatUSD(
        state.mcapUSD
      )}`
    );
  }

  if (
    state.uniqueBuyers.size >=
    3
  ) {
    reasons.push(
      `${state.uniqueBuyers.size} unique buyers`
    );
  }

  if (
    result.buyPressure >= 1.25
  ) {
    reasons.push(
      `buyers stronger than sellers (${result.buyPressure === Infinity ? 'strong' : `${result.buyPressure.toFixed(2)}x`})`
    );
  }

  if (
    result.buyerGrowth >= 1
  ) {
    reasons.push(
      'buyer activity is growing'
    );
  }

  if (
    result.volumeGrowth >= 1.1
  ) {
    reasons.push(
      'volume is accelerating'
    );
  }

  if (
    result.priceMomentum >= 1.05
  ) {
    reasons.push(
      `price momentum +${Math.round(
        (result.priceMomentum - 1) *
          100
      )}%`
    );
  }

  if (
    getRepeatBuyerCount(state) >=
    2
  ) {
    reasons.push(
      'repeat buying detected'
    );
  }

  if (
    state.devHoldingPct !== null
  ) {
    if (
      state.devHoldingPct < 10
    ) {
      reasons.push(
        `dev holding ${state.devHoldingPct.toFixed(1)}%`
      );
    } else {
      reasons.push(
        `dev holding ${state.devHoldingPct.toFixed(1)}% — elevated risk`
      );
    }
  }

  return reasons;
}

async function sendNormalAlert(
  state,
  signal,
  result,
  reasons
) {
  const message = [
    `🚨 ${signal}`,
    '',
    `${state.name || 'Unknown Token'} ${state.symbol ? `(${state.symbol})` : ''}`,
    `CA: ${state.mint}`,
    `Pool: ${shortAddress(state.pool)}`,
    '',
    `MCap: ${formatUSD(
      state.mcapUSD
    )}`,
    `Liquidity: ${formatUSD(
      state.liquidityUSD
    )}`,
    `Score: ${result.score}/100`,
    `Buy pressure: ${
      result.buyPressure === Infinity
        ? 'strong'
        : `${result.buyPressure.toFixed(2)}x`
    }`,
    '',
    'Why it triggered:',
    ...reasons.map(
      (reason) => `• ${reason}`
    ),
    '',
    `Source: ${CONFIG.source}`,
    'Auto-trading: OFF'
  ].join('\n');

  await sendTelegram(
    message
  );

  console.log(
    'NORMAL ALERT:',
    signal,
    state.mint,
    result.score
  );
}

async function sendDeveloperSellAlert(
  state,
  solAmount,
  trade
) {
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

  state.devSellAlertSent =
    true;

  const holding =
    state.devHoldingPct !== null
      ? `${state.devHoldingPct.toFixed(1)}%`
      : 'unavailable';

  const message = [
  '⚠️ DEV SELL AFTER ALERT',
  '',
  `${state.name || 'Unknown Token'} ${state.symbol ? `(${state.symbol})` : ''}`,
  `CA: ${state.mint}`,
  `Dev: ${shortAddress(state.devWallet)}`,
  `Sold: ${solAmount.toFixed(4)} SOL`,
  `Remaining dev holding: ${holding}`,
  `Tx: ${getSignature(trade) || 'unavailable'}`
].join('\n');

  await sendTelegram(
    message
  );

  console.log(
    'DEV SELL 
    function evaluateToken(state) {
  if (
    !state ||
    state.normalAlertSent
  ) {
    return;
  }

  if (
    state.mcapUSD <
    CONFIG.minMcapUSD
  ) {
    return;
  }

  if (
    !state.liquidityKnown ||
    state.liquidityUSD <
      CONFIG.minLiquidityUSD
  ) {
    return;
  }

  const block =
    getHardBlock(state);

  if (block.blocked) {
    return;
  }

  const result =
    calculateScore(state);

  const reasons =
    getSignalReasons(
      state,
      result
    );

  if (
    result.percentage >=
    CONFIG.greenThreshold
  ) {
    state.greenSent = true;
    state.normalAlertSent =
      true;

    normalAlertsSent.add(
      state.mint
    );

    void sendNormalAlert(
      state,
      'GREEN',
      result,
      reasons
    ).catch((error) => {
      console.log(
        'GREEN ALERT ERROR:',
        error.message
      );
    });

    return;
  }

  if (
    result.percentage >=
    CONFIG.orangeThreshold
  ) {
    state.orangeSent = true;
    state.normalAlertSent =
      true;

    normalAlertsSent.add(
      state.mint
    );

            void sendNormalAlert(
      state,
      'ORANGE',
      result,
      reasons
    ).catch((error) => {
      console.log(
        'ORANGE ALERT ERROR:',
        error.message
      );
    });
  }
  }
  function recordEliteWalletTrade(
  wallet,
  state,
  side,
  priceUSD
) {
  if (!wallet) {
    return;
  }

  let stats =
    eliteWallets.get(wallet);

  if (!stats) {
    stats = {
      trades: 0,
      wins: 0,
      lastTrade: 0,
      cooldownUntil: 0,
      positions: new Map()
    };

    eliteWallets.set(
      wallet,
      stats
    );
  }

  stats.trades++;
  stats.lastTrade =
    Date.now();

  let position =
    stats.positions.get(
      state.mint
    );

  if (
    side === 'buy' &&
    priceUSD > 0
  ) {
    if (!position) {
      position = {
        quantityScore: 0,
        averageEntry: priceUSD
      };
    } else {
      position.averageEntry =
        (
          position.averageEntry +
          priceUSD
        ) / 2;
    }

    position.quantityScore++;

    stats.positions.set(
      state.mint,
      position
    );
  }

  if (
    side === 'sell' &&
    position &&
    position.averageEntry > 0 &&
    priceUSD >=
      position.averageEntry * 1.20
  ) {
    stats.wins++;

    stats.positions.delete(
      state.mint
    );
  }
  }
  function evaluateEliteSniper(
  wallet,
  state,
  side,
  priceUSD
) {
  if (
    !wallet ||
    side !== 'buy'
  ) {
    return;
  }

  if (
    state.mcapUSD <
    CONFIG.minMcapUSD
  ) {
    return;
  }

  if (
    !state.liquidityKnown ||
    state.liquidityUSD <
      CONFIG.minLiquidityUSD
  ) {
    return;
  }

  if (
    state.buys < 2 ||
    state.uniqueBuyers.size < 2
  ) {
    return;
  }

  const block =
    getHardBlock(state);

  if (block.blocked) {
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

  const key =
    `${state.mint}:${wallet}`;

  if (
    eliteAlertsSent.has(key)
  ) {
    return;
  }

  eliteAlertsSent.add(key);

  stats.cooldownUntil =
    Date.now() +
    CONFIG.eliteCooldownMinutes *
      60 *
      1000;

  const message = [
    '🎯 ELITE_SNIPER',
    '',
    `${state.name || 'Unknown Token'} ${state.symbol ? `(${state.symbol})` : ''}`,
    `CA: ${state.mint}`,
    `Elite wallet: ${shortAddress(
      wallet
    )}`,
    '',
    `Wallet record: ${stats.wins} wins / ${stats.trades} observed trades`,
    `MCap: ${formatUSD(
      state.mcapUSD
    )}`,
    `Liquidity: ${formatUSD(
      state.liquidityUSD
    )}`,
    '',
    'Reason: proven early-buying wallet detected buying this PumpSwap token.',
    '',
    'Auto-trading: OFF'
  ].join('\n');

  void sendTelegram(
    message
  ).catch((error) => {
    console.log(
      'ELITE ALERT ERROR:',
      error.message
    );
  });

  console.log(
    'ELITE SNIPER:',
    state.mint,
    shortAddress(wallet)
  );
  }
  async function handleTrade(trade) {
  const state =
    getStateFromEvent(trade);

  if (!state) {
    return;
  }

  try {
    const signature =
      getSignature(trade);

    if (
      signature &&
      state.lastTradeSignature ===
        signature
    ) {
      return;
    }

    if (signature) {
      state.lastTradeSignature =
        signature;
    }

    const side =
      getAction(trade);

    const wallet =
      getTradeWallet(trade);

    const solAmount =
      getTradeSOL(trade);

    const tradePrice =
      getPriceUSD(trade);

    const tradeMcap =
      getMcapUSD(trade);

    if (tradePrice > 0) {
      state.latestPriceUSD =
        tradePrice;

      state.priceUSD =
        tradePrice;

      if (
        !state.firstPriceUSD
      ) {
        state.firstPriceUSD =
          tradePrice;
      }

      state.highestPriceUSD =
        Math.max(
          state.highestPriceUSD,
          tradePrice
        );
    }

    if (tradeMcap > 0) {
      state.mcapUSD =
        tradeMcap;
    }

    const tradeQuoteMint =
      getQuoteMint(trade);

    if (tradeQuoteMint) {
      state.quoteMint =
        tradeQuoteMint;
    }

    updateLiquidity(
      state,
      trade
    );

    state.lastTradeAt =
      Date.now();

    if (!state.firstTradeAt) {
      state.firstTradeAt =
        Date.now();
    }

    if (side === 'buy') {
      state.buys++;
      state.buyVolumeSOL +=
        solAmount;

      if (wallet) {
        state.uniqueBuyers.add(
          wallet
        );

        state.buyerTimeline.push({
          wallet,
          time: Date.now()
        });
      }
    } else {
      state.sells++;
      state.sellVolumeSOL +=
        solAmount;

      if (wallet) {
        state.uniqueSellers.add(
          wallet
        );
      }
    }

    updateWalletStats(
      state,
      wallet,
      side,
      solAmount
    );

    const explicitHolding =
      safeNumber(
        trade?.devHoldingPct ??
          trade?.dev_holding_pct ??
          trade?.creatorHoldingPct ??
          trade?.creator_holding_pct
      );

    if (
      explicitHolding > 0 &&
      wallet === state.devWallet
    ) {
      state.devHoldingPct =
        explicitHolding;
    }

    state.recentTrades.push({
      time: Date.now(),
      side,
      wallet,
      solAmount,
      priceUSD: tradePrice
    });

    if (
      state.recentTrades.length >
      500
    ) {
      state.recentTrades.shift();
    }

    if (
      state.buyerTimeline.length >
      500
    ) {
      state.buyerTimeline.shift();
    }

    console.log(
      'TRADE:',
      side.toUpperCase(),
      state.mint,
      'wallet=',
      shortAddress(wallet),
      'SOL=',
      solAmount.toFixed(4),
      'buys=',
      state.buys,
      'sells=',
      state.sells,
      'mcap=',
      formatUSD(
        state.mcapUSD
      ),
      'liq=',
      formatUSD(
        state.liquidityUSD
      )
    );

    if (
      side === 'sell' &&
      wallet &&
      state.devWallet &&
      wallet ===
        state.devWallet &&
      state.normalAlertSent
    ) {
      await sendDeveloperSellAlert(
        state,
        solAmount,
        trade
      );
    }

    recordEliteWalletTrade(
      wallet,
      state,
      side,
      tradePrice
    );

    evaluateEliteSniper(
      wallet,
      state,
      side,
      tradePrice
    );

    evaluateToken(state);
  } catch (error) {
    console.log(
      'TRADE HANDLER ERROR:',
      state.mint,
      error.message
    );
  }
  }
  function handleTokenUpdate(update) {
  try {
    const state =
      getStateFromEvent(update);

    if (!state) {
      return;
    }

    const price =
      getPriceUSD(update);

    const mcap =
      getMcapUSD(update);

    if (price > 0) {
      state.priceUSD =
        price;

      state.latestPriceUSD =
        price;

      if (
        !state.firstPriceUSD
      ) {
        state.firstPriceUSD =
          price;
      }

      state.highestPriceUSD =
        Math.max(
          state.highestPriceUSD,
          price
        );

      state.priceHistory.push({
        time: Date.now(),
        price
      });

      if (
        state.priceHistory.length >
        300
      ) {
        state.priceHistory.shift();
      }
    }

    if (mcap > 0) {
      state.mcapUSD =
        mcap;
    }

    const quoteMint =
      getQuoteMint(update);

    if (quoteMint) {
      state.quoteMint =
        quoteMint;
    }

    updateLiquidity(
      state,
      update
    );

    state.lastUpdateAt =
      Date.now();

    console.log(
      'TOKEN UPDATE:',
      state.mint,
      'price=',
      formatUSD(
        state.priceUSD
      ),
      'mcap=',
      formatUSD(
        state.mcapUSD
      ),
      'liq=',
      formatUSD(
        state.liquidityUSD
      )
    );

    evaluateToken(state);
  } catch (error) {
    console.log(
      'TOKEN UPDATE ERROR:',
      error.message
    );
  }
  }
  const shrine = io(
  'https://sol.shrine.trade',
  {
    transports: ['websocket'],
    reconnection: true,
    reconnectionAttempts:
      Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax:
      10000,
    timeout: 20000
  }
);

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
      }
    );

    for (
      const state of
      monitored.values()
    ) {
      subscribeToken(state);
    }
  }
);

shrine.on(
  'connect_error',
  (error) => {
    console.log(
      'SHRINE CONNECT ERROR:',
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

shrine.on(
  'subscription_error',
  (error) => {
    console.log(
      'SHRINE SUBSCRIPTION ERROR:',
      error
    );
  }
);

shrine.on(
  'sol_price',
  (data) => {
    try {
      const price =
        safeNumber(
          data?.priceUSD
        ) ||
        safeNumber(
          data?.price_usd
        ) ||
        safeNumber(
          data?.price
        );

      if (price > 0) {
        solPriceUSD =
          price;

        console.log(
          'SOL PRICE:',
          solPriceUSD
        );
      }
    } catch (error) {
      console.log(
        'SOL PRICE ERROR:',
        error.message
      );
    }
  }
);

shrine.on(
  'migration',
  async (migration) => {
    try {
      console.log(
        'NEW PUMPSWAP MIGRATION:',
        migration
      );

      const mint =
        getMint(migration);

      const pool =
        migration?.new_pool ??
        migration?.newPool ??
        migration?.pool ??
        migration?.pool_address ??
        migration?.poolAddress;

      if (!mint || !pool) {
        console.log(
          'MIGRATION MISSING MINT/POOL:',
          migration
        );

        return;
      }

      if (!scannerActive) {
        console.log(
          'SCANNER RESTING - MIGRATION SKIPPED:',
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

shrine.on(
  'token_update',
  handleTokenUpdate
);

shrine.on(
  'trade',
  (trade) => {
    void handleTrade(trade);
  }
);
  updateScannerSchedule();

setInterval(
  () => {
    const previous =
      scannerActive;

    updateScannerSchedule();

    if (
      previous !==
      scannerActive
    ) {
      console.log(
        scannerActive
          ? 'SCANNER WORK PERIOD STARTED'
          : 'SCANNER REST PERIOD STARTED'
      );
    }
  },
  60 * 1000
);

app.get(
  '/api/status',
  (req, res) => {
    res.json({
      ok: true,
      shrineConnected:
        shrine.connected,
      scannerActive,
      telegramEnabled,
      autoTrading:
        CONFIG.autoTrading,
      source:
        CONFIG.source,
      solPriceUSD,
      monitoredTokens:
        monitored.size,
      normalAlertsSent:
        normalAlertsSent.size,
      devSellAlertsSent:
        devSellAlertsSent.size,
      eliteWallets:
        eliteWallets.size,
      uptimeSeconds:
        Math.floor(
          process.uptime()
        ),
      config: {
        minMcapUSD:
          CONFIG.minMcapUSD,
        minLiquidityUSD:
          CONFIG.minLiquidityUSD,
        orangeThreshold:
          CONFIG.orangeThreshold,
        greenThreshold:
          CONFIG.greenThreshold,
        maxMonitorMinutes:
          CONFIG.maxMonitorMinutes,
        workMinutes:
          CONFIG.workMinutes,
        restMinutes:
          CONFIG.restMinutes
      }
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
      scannerActive,
      monitoredTokens:
        monitored.size
    });
  }
);
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

app.listen(
  PORT,
  () => {
    console.log(
      `PumpSwap Momentum Scanner running on port ${PORT}`
    );

    console.log(
      'TELEGRAM ENABLED:',
      telegramEnabled
    );

    console.log(
      'AUTO TRADING:',
      CONFIG.autoTrading
    );

    console.log(
      'SOURCE:',
      CONFIG.source
    );
  }
);
