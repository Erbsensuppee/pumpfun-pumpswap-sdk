const fs = require('fs/promises');
const path = require('path');
const { LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { TOKEN_PROGRAM_ID } = require('@solana/spl-token');

const FILE_PATH = path.join(__dirname, 'cacheData.json');
let cache = {};
let saveInterval = null;

/**
 * Initialize cache and load from file
 */
async function initCache(connection, walletPubkey) {
  await ensureFileExists();
  await loadCacheFromFile();

  // --- 1 Load SOL balance
  await updateSolBalance(connection, walletPubkey);

  // --- 2 Load all SPL token accounts
  const tokenAccounts = await connection.getParsedTokenAccountsByOwner(walletPubkey, {
    programId: TOKEN_PROGRAM_ID
  });

  for (const { account } of tokenAccounts.value) {
    const parsed = account.data.parsed;
    const mint = parsed.info.mint;
    const amount = BigInt(parsed.info.tokenAmount.amount); // SPL amounts are strings

    const existing = cache.tokens[mint] || {};
    cache.tokens[mint] = { ...existing, lamports: amount, tokenPricePerLamports: existing.tokenPricePerLamports || 0 };
  }

  console.log('[cacheManager] Cache initialized with on-chain data');
  await saveCacheToFile();
}

/**
 * Ensure cache file exists or create a new one
 */
async function ensureFileExists() {
  try {
    await fs.access(FILE_PATH);
  } catch {
    console.log('[cacheManager] cacheData.json not found. Creating new one...');
    await fs.writeFile(FILE_PATH, JSON.stringify({ solLamports: 0, tokens: {} }, null, 2));
  }
}

/**
 * Load cache data from disk (with migration)
 */
async function loadCacheFromFile() {
  try {
    const data = await fs.readFile(FILE_PATH, 'utf-8');
    let parsed = JSON.parse(data, (_, value) =>
      typeof value === 'string' && /^\d+n$/.test(value) ? BigInt(value.slice(0, -1)) : value
    );

    if (typeof parsed !== 'object' || parsed === null) parsed = {};

    // --- Migration: flat → nested format
    if (!parsed.tokens) {
      const migrated = { solLamports: parsed.solLamports || 0, tokens: {} };
      for (const [key, value] of Object.entries(parsed)) {
        if (key !== 'solLamports') migrated.tokens[key] = value;
      }
      parsed = migrated;
      console.log('[cacheManager] Migrated old flat cache structure → nested (cache.tokens).');
      await fs.writeFile(FILE_PATH, JSON.stringify(parsed, null, 2));
    }

    cache = parsed;
    console.log(`[cacheManager] Loaded ${Object.keys(cache.tokens).length} tokens from cacheData.json`);
  } catch (err) {
    console.warn('[cacheManager] Failed to read cacheData.json, starting fresh:', err);
    cache = { solLamports: 0, tokens: {} };
  }
}

/**
 * Update wallet SOL balance from blockchain
 */
async function updateSolBalance(connection, walletPubkey) {
  try {
    const balanceLamports = await connection.getBalance(walletPubkey);
    cache.solLamports = balanceLamports;
    console.log(`[cacheManager] SOL balance updated: ${(balanceLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
  } catch (err) {
    console.error('[cacheManager] Failed to fetch SOL balance:', err);
  }
}

/**
 * Add lamports to cached wallet SOL balance
 */
function addSolLamports(lamportsToAdd) {
  if (!lamportsToAdd || lamportsToAdd <= 0) return;
  const current = cache.solLamports || 0;
  cache.solLamports = BigInt(current) + BigInt(lamportsToAdd);
  console.log(`[cacheManager] Added ${lamportsToAdd} lamports to wallet SOL. Total = ${cache.solLamports}`);
}

/**
 * Get full cache (SOL + tokens)
 */
function getCache() {
  return cache;
}

/**
 * Get one token entry
 */
function getToken(mint) {
  return cache.tokens[mint];
}

function hasToken(mint) {
  const token = cache.tokens[mint];
  return token && token.lamports > 0n;
}

/**
 * Get token data safely — returns `null` if token not found or 0 balance
 */
function getTokenSafe(mint) {
  const token = cache.tokens[mint];
  return token && token.lamports > 0n ? token : null;
}

/**
 * Calculate lamports to sell based on percentage
 */
function getAmountToSellFromCache(tokenMint, percentToSell = 100) {
  const token = getTokenSafe(tokenMint);
  if (!token || token.lamports <= 0n) return 0n;

  const lamports = token.lamports;
  if (percentToSell <= 0) return 0n;

  const lamportsToSell = (lamports * BigInt(percentToSell)) / 100n;
  if (lamportsToSell < 1n && lamports > 0n) return 1n;
  return lamportsToSell > lamports ? lamports : lamportsToSell;
}

/**
 * Add or update token entry
 */
function updateToken(mint, updates) {
  if (!mint || mint === 'solLamports') return;
  const existing = cache.tokens[mint] || {};
  cache.tokens[mint] = { ...existing, ...updates };

  if (!cache.tokens[mint].lamports || cache.tokens[mint].lamports <= 0n) {
    delete cache.tokens[mint];
    console.log(`[cacheManager] Removed ${mint} (lamports = 0)`);
  }
}

/**
 * Add lamports to an existing token (for repeated buys)
 */
function addTokenLamports(mint, lamportsToAdd, tokenPricePerLamports = null) {
  if (!mint || mint === 'solLamports') return;

  const existing = cache.tokens[mint] || { lamports: 0n };
  const newLamports = BigInt(existing.lamports) + BigInt(lamportsToAdd);

  cache.tokens[mint] = {
    ...existing,
    lamports: newLamports,
    ...(tokenPricePerLamports !== null ? { tokenPricePerLamports } : {})
  };

  console.log(`[cacheManager] Added ${lamportsToAdd} lamports to ${mint}. Total = ${newLamports}`);
}

/**
 * Reduce lamports by a specific amount (for partial/full sells)
 */
function reduceTokenLamports(mint, lamportsToReduce) {
  const token = cache.tokens[mint];
  if (!token) return;

  const reduce = BigInt(lamportsToReduce);
  token.lamports = token.lamports > reduce ? token.lamports - reduce : 0n;

  if (token.lamports <= 0n) {
    delete cache.tokens[mint];
    console.log(`[cacheManager] Removed ${mint} (fully sold)`);
  } else {
    console.log(`[cacheManager] ${mint} reduced by ${lamportsToReduce}, remaining ${token.lamports}`);
  }
}

/**
 * Write the full cache to disk (overwrite)
 */
async function saveCacheToFile() {
  console.log('[cacheManager] Saving cache object...');
  try {
    const replacer = (_, value) => (typeof value === 'bigint' ? value.toString() : value);
    await fs.writeFile(FILE_PATH, JSON.stringify(cache, replacer, 2));
    console.log('[cacheManager] Cache written to cacheData.json');
  } catch (err) {
    console.error('[cacheManager] Failed to write cacheData.json:', err);
  }
}

/**
 * Stop the auto-save interval
 */
function stopCache() {
  if (saveInterval) {
    clearInterval(saveInterval);
    saveInterval = null;
    console.log('[cacheManager] Auto-save stopped');
  }
}

/**
 * Get current cached wallet SOL lamports
 */
function getSolLamports() {
  return cache.solLamports || 0;
}

/**
 * Get a percentage of the cached wallet SOL lamports
 */
function getSolLamportsPercent(percent) {
  const solLamportsRaw = getSolLamports();

  // Validate raw balance
  if (solLamportsRaw === undefined || solLamportsRaw === null) {
    console.error('[getSolLamportsPercent] solLamportsRaw is undefined/null');
    return 0n;
  }

  let solLamports;
  try {
    solLamports = BigInt(solLamportsRaw);
  } catch {
    console.error('[getSolLamportsPercent] Failed to convert to BigInt:', solLamportsRaw);
    return 0n;
  }

  if (solLamports <= 0n || !percent || percent <= 0) return 0n;

  // Safe fractional handling
  const lamportsAmount =
    (solLamports * BigInt(Math.round(percent * 100))) / 10000n;

  let adjusted = lamportsAmount;
  if (adjusted < 1n && solLamports > 0n) adjusted = 1n;
  if (adjusted > solLamports) adjusted = solLamports;

  return adjusted;
}




module.exports = {
  initCache,
  updateSolBalance,
  getCache,
  getToken,
  getTokenSafe,
  hasToken,
  updateToken,
  addTokenLamports,
  reduceTokenLamports,
  saveCacheToFile,
  stopCache,
  getAmountToSellFromCache,
  getSolLamportsPercent,
  addSolLamports
};
