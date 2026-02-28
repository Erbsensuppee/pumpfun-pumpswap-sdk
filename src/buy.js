// File: sdk/buildPumpFunBuy.js
const {
  Connection,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  ComputeBudgetProgram,
  LAMPORTS_PER_SOL,
  Transaction,
  sendAndConfirmTransaction
} = require("@solana/web3.js");
const {
  getAssociatedTokenAddress,
  getMint,
  getTransferFeeConfig,
  calculateEpochFee,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction
} = require("@solana/spl-token");
const { 
  addTokenLamports 
} = require('./cacheManager/cacheManager.js');

const PumpProgramType = {
  PUMP_FUN: 0,
  PUMP_SWAP: 1,
};

// PUMPFUN
const PUMPFUN_PROGRAM_ID = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const FEE_PROGRAM_ID     = new PublicKey("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ");
const BUY_DISCRIMINATOR              = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);
const BUY_EXACT_SOL_IN_DISCRIMINATOR = Buffer.from([56, 252, 116, 8, 158, 223, 205, 95]);
const PUMPFUN_BUY_USE_24B_COMPAT_ENCODING = true;

// PUMPSWAP
const PUMP_SWAP_PROGRAM_ID = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
const WSOL_MINT            = new PublicKey('So11111111111111111111111111111111111111112');
const V2_ACCOUNT_MODE_RAW = (process.env.PUMP_INCLUDE_V2_ACCOUNTS || "true").toLowerCase();
const V2_ACCOUNT_MODE =
  V2_ACCOUNT_MODE_RAW === "false" ? "off" :
  "on";

const FEE_SEED_CONST = new Uint8Array([
  1, 86, 224, 246, 147, 102, 90, 207, 68, 219,
  21, 104, 191, 23, 91, 170, 81, 137, 203, 151,
  245, 210, 255, 59, 101, 93, 43, 182, 253, 109, 24, 176,
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getTokenProgramId(connection, mint) {
  const mintInfo = await connection.getAccountInfo(mint);
  if (!mintInfo?.owner) throw new Error("Mint account not found");
  return mintInfo.owner;
}

function parseGlobalFeeRecipient(globalAccountData) {
  const feeRecipientOffset = 8 + 1 + 32;
  if (!globalAccountData || globalAccountData.length < feeRecipientOffset + 32) {
    throw new Error("Invalid Global account data for fee_recipient");
  }
  return new PublicKey(globalAccountData.slice(feeRecipientOffset, feeRecipientOffset + 32));
}

async function shouldIncludeV2Account(connection, pda) {
  if (V2_ACCOUNT_MODE === "off") return false;
  return true;
}

/**
 * Read live fee bps directly from the feeConfig account data.
 *
 * The fee program stores fees in the feeConfig PDA with this layout:
 *   offset  0: discriminator (8 bytes)
 *   offset  8: authority pubkey (32 bytes)
 *   offset 40: bump (u8)
 *   offset 41: lp_fee_bps (u64)         ← 0
 *   offset 49: protocol_fee_bps (u64)   ← 95 bps
 *   offset 57: creator_fee_bps (u64)    ← 30 bps (per-coin, differs from Global)
 *
 * This is the same value GetFees returns on-chain. Reading the account
 * directly avoids the simulation blockhash issue that causes silent failures.
 *
 * Falls back to Global account offsets 105/154, then hard fallback 125n.
 */
async function getLiveFeeBps(connection, feeConfigPda) {
  try {
    const feeConfigInfo = await connection.getAccountInfo(feeConfigPda);
    if (feeConfigInfo?.data && feeConfigInfo.data.length >= 65) {
      const protocolBps = feeConfigInfo.data.readBigUInt64LE(49);
      const creatorBps  = feeConfigInfo.data.readBigUInt64LE(57);
      const total = protocolBps + creatorBps;
      if (total > 0n) {
        console.log(`[BUY] Live fee bps (feeConfig): protocol=${protocolBps}, creator=${creatorBps}, total=${total}`);
        return { protocolBps, creatorBps, totalBps: total };
      }
    }
  } catch (err) {
    console.warn("[BUY] getLiveFeeBps feeConfig read failed:", err.message);
  }

  // Fallback: Global account offsets
  try {
    const [global] = PublicKey.findProgramAddressSync([Buffer.from("global")], PUMPFUN_PROGRAM_ID);
    const gInfo = await connection.getAccountInfo(global);
    if (gInfo?.data && gInfo.data.length >= 162) {
      const protocolBps = gInfo.data.readBigUInt64LE(105);
      const creatorBps  = gInfo.data.readBigUInt64LE(154);
      const total = protocolBps + creatorBps;
      if (total > 0n) {
        console.log(`[BUY] Live fee bps (Global fallback): total=${total}`);
        return { protocolBps, creatorBps, totalBps: total };
      }
    }
  } catch (_) {}

  console.warn("[BUY] getLiveFeeBps: using hard fallback 125n");
  return { protocolBps: 95n, creatorBps: 30n, totalBps: 125n };
}

function ceilDiv(a, b) {
  if (b === 0n) throw new Error("Division by zero");
  return (a + b - 1n) / b;
}

function encodeOptionBool(value) {
  // Observed on-chain Pump buy payloads encode OptionBool as 2 bytes:
  // [1, 1] = Some(true), [1, 0] = Some(false)
  return Buffer.from([1, value ? 1 : 0]);
}

function toBigIntSafe(value) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  if (typeof value === "string") return BigInt(value);
  return 0n;
}

async function getToken2022TransferFeeInfo(connection, mint, tokenProgramId) {
  if (!tokenProgramId.equals(TOKEN_2022_PROGRAM_ID)) return null;
  try {
    const mintInfo = await getMint(connection, mint, "confirmed", tokenProgramId);
    const transferFeeConfig = getTransferFeeConfig(mintInfo);
    if (!transferFeeConfig) return null;
    const epochInfo = await connection.getEpochInfo("confirmed");
    return { transferFeeConfig, epoch: BigInt(epochInfo.epoch) };
  } catch (err) {
    console.warn("[BUY] Failed to read Token-2022 transfer fee config:", err.message);
    return null;
  }
}

function applyTokenTransferFee(tokensOut, transferFeeInfo) {
  if (!transferFeeInfo || tokensOut <= 0n) return { feeWithheld: 0n, tokensReceived: tokensOut };
  const preFeeAmount = toBigIntSafe(tokensOut);
  const feeWithheld = toBigIntSafe(
    calculateEpochFee(transferFeeInfo.transferFeeConfig, Number(transferFeeInfo.epoch), preFeeAmount)
  );
  const tokensReceived = tokensOut > feeWithheld ? tokensOut - feeWithheld : 0n;
  return { feeWithheld, tokensReceived };
}

function quoteTokensOutForSpendableSol(virtualTokenReserves, virtualSolReserves, spendableSolIn, protocolFeeBps, creatorFeeBps) {
  if (spendableSolIn <= 0n) return 0n;
  const totalFeeBps = protocolFeeBps + creatorFeeBps;
  // IDL formula step 1: net_sol = floor(spendable * 10000 / (10000 + totalFeeBps))
  let netSol = (spendableSolIn * 10000n) / (10000n + totalFeeBps);
  if (netSol <= 1n) return 0n;
  // IDL step 2+3: verify net_sol + fees <= spendable, adjust if not
  const fees =
    ceilDiv(netSol * protocolFeeBps, 10000n) +
    ceilDiv(netSol * creatorFeeBps, 10000n);
  if (netSol + fees > spendableSolIn) netSol = netSol - (netSol + fees - spendableSolIn);
  if (netSol <= 1n) return 0n;
  // IDL step 4: tokens_out = floor((net_sol - 1) * vT / (vS + net_sol - 1))
  const effectiveNetSol = netSol - 1n;
  return (effectiveNetSol * virtualTokenReserves) / (virtualSolReserves + effectiveNetSol);
}

function findMaxTokensOutForSpendableSolBuy(virtualTokenReserves, virtualSolReserves, spendableSolBudget, totalFeeBps, maxTokenOutCap = null) {
  if (spendableSolBudget <= 0n) return 0n;
  let lo = 0n;
  let hi = virtualTokenReserves > 0n ? virtualTokenReserves - 1n : 0n;
  if (maxTokenOutCap !== null && hi > maxTokenOutCap) hi = maxTokenOutCap;
  while (lo < hi) {
    const mid = lo + (hi - lo + 1n) / 2n;
    const spendable = quoteSpendableSolForTokens(virtualTokenReserves, virtualSolReserves, mid, totalFeeBps);
    if (spendable !== null && spendable <= spendableSolBudget) {
      lo = mid;
    } else {
      hi = mid - 1n;
    }
  }
  return lo;
}

function quoteSpendableSolForTokens(virtualTokenReserves, virtualSolReserves, tokensOut, totalFeeBps) {
  if (tokensOut <= 0n) return 0n;
  if (tokensOut >= virtualTokenReserves) return null;
  const denom = virtualTokenReserves - tokensOut;
  const netSol = ceilDiv(tokensOut * virtualSolReserves, denom) + 1n;
  return ceilDiv(netSol * (10000n + totalFeeBps), 10000n);
}

function quoteGrossSolCostForTokens(virtualTokenReserves, virtualSolReserves, tokensOut) {
  if (tokensOut <= 0n) return 0n;
  if (tokensOut >= virtualTokenReserves) return null;
  const newVirtualTokenReserves = virtualTokenReserves - tokensOut;
  const k = virtualTokenReserves * virtualSolReserves;
  const newVirtualSolReserves = k / newVirtualTokenReserves;
  if (newVirtualSolReserves < virtualSolReserves) return null;
  return newVirtualSolReserves - virtualSolReserves;
}

function findMaxTokensOutForGrossSolBuy(virtualTokenReserves, virtualSolReserves, grossSolBudget, maxTokenOutCap = null) {
  if (grossSolBudget <= 0n) return 0n;
  let lo = 0n;
  let hi = virtualTokenReserves > 0n ? virtualTokenReserves - 1n : 0n;
  if (maxTokenOutCap !== null && hi > maxTokenOutCap) hi = maxTokenOutCap;
  while (lo < hi) {
    const mid = lo + (hi - lo + 1n) / 2n;
    const grossCost = quoteGrossSolCostForTokens(virtualTokenReserves, virtualSolReserves, mid);
    if (grossCost !== null && grossCost <= grossSolBudget) {
      lo = mid;
    } else {
      hi = mid - 1n;
    }
  }
  return lo;
}

// ---------------------------------------------------------------------------
// performBuy
// ---------------------------------------------------------------------------

async function performBuy(connection, mintAddress, payerKeypair, amountInLamports, slippage = 0.10, retries = 2) {
  console.log(
    '[performBuy types]',
    typeof connection, typeof mintAddress, typeof payerKeypair,
    typeof amountInLamports, typeof slippage, typeof retries
  );
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      const { instructions, tokenAmount, tokenPrice } = await buildPumpFunBuy(
        connection, mintAddress, payerKeypair, amountInLamports, slippage
      );
      const tx = new Transaction().add(...instructions);
      const sig = await sendAndConfirmTransaction(connection, tx, [payerKeypair], { commitment: 'confirmed' });
      console.log(`[BUY] Buy confirmed: https://solscan.io/tx/${sig}`);
      addTokenLamports(mintAddress.toBase58(), tokenAmount, tokenPrice);
      return sig;
    } catch (err) {
      console.error(`[BUY] Buy attempt ${attempt} failed for ${mintAddress.toBase58()}:`, err.message);
      if (attempt > retries) throw err;
      await new Promise(res => setTimeout(res, 100));
    }
  }
}

// ---------------------------------------------------------------------------
// getBondingCurveReserves
// ---------------------------------------------------------------------------

async function getBondingCurveReserves(connection, bondingCurve) {
  const info = await connection.getAccountInfo(bondingCurve);
  if (!info?.data) throw new Error("Failed to fetch bonding curve data");
  const data = info.data;
  // 0:  discriminator (8)
  // 8:  virtual_token_reserves (u64)
  // 16: virtual_sol_reserves (u64)
  // 24: real_token_reserves (u64)
  // 32: real_sol_reserves (u64)
  // 40: token_total_supply (u64)
  // 48: complete (bool)
  // 49: creator (Pubkey, 32 bytes)
  return {
    virtualTokenReserves:   data.readBigUInt64LE(8),
    virtualSolReserves:     data.readBigUInt64LE(16),
    realTokenReserves:      data.readBigUInt64LE(24),
    realSolReserves:        data.readBigUInt64LE(32),
    tokenTotalSupply:       data.readBigUInt64LE(40),
    bondingCurveIsComplete: data[48] === 1,
    creatorPublicKey:       new PublicKey(data.slice(49, 81)),
    isMayhemMode:           data.length > 81 ? data[81] === 1 : false,
    isCashbackCoin:         data.length > 82 ? data[82] === 1 : false,
  };
}

// ---------------------------------------------------------------------------
// buildPumpFunBuy
// ---------------------------------------------------------------------------

async function buildPumpFunBuy(connection, mint, userKeypair, lamportsAmount, slippage = 0.03, mode = "buy", trackVolume = true) {
  console.log(
    '[buildPumpFunBuy types]',
    typeof connection, typeof mint, typeof userKeypair, typeof lamportsAmount, typeof slippage,
  );
  const userPubkey = userKeypair.publicKey;
  console.log(`Building Pump.fun buy for ${mint.toBase58()} amount: ${Number(lamportsAmount) / LAMPORTS_PER_SOL}`);

  const [bondingCurve] = PublicKey.findProgramAddressSync(
    [Buffer.from("bonding-curve"), mint.toBuffer()], PUMPFUN_PROGRAM_ID
  );
  const {
    virtualTokenReserves,
    virtualSolReserves,
    realTokenReserves,
    bondingCurveIsComplete,
    creatorPublicKey,
    isCashbackCoin,
  } = await getBondingCurveReserves(connection, bondingCurve);

  switch (Number(bondingCurveIsComplete)) {
    case PumpProgramType.PUMP_FUN:
      console.log("[BUY] Bonding curve still active -> using Pump.fun buy path");
      break;
    case PumpProgramType.PUMP_SWAP:
      console.log("[BUY] Bonding curve complete -> redirecting to PumpSwap buy path");
      return await buildPumpSwapBuy(connection, mint, userPubkey, lamportsAmount, slippage, creatorPublicKey, trackVolume, isCashbackCoin);
    default:
      console.warn("[BUY] Unknown PumpProgramType, aborting buy");
      return;
  }

  // --- PDAs ---
  const [global]                  = PublicKey.findProgramAddressSync([Buffer.from("global")], PUMPFUN_PROGRAM_ID);
  const tokenProgramId            = await getTokenProgramId(connection, mint);
  const effectiveMode = mode === "buy_exact_sol_in" ? "buy_exact_sol_in" : "buy";
  const [associatedBondingCurve]  = PublicKey.findProgramAddressSync(
    [bondingCurve.toBuffer(), tokenProgramId.toBuffer(), mint.toBuffer()], ASSOCIATED_TOKEN_PROGRAM_ID
  );
  const [eventAuthority]          = PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], PUMPFUN_PROGRAM_ID);
  const [globalVolumeAccumulator] = PublicKey.findProgramAddressSync([Buffer.from("global_volume_accumulator")], PUMPFUN_PROGRAM_ID);
  const [userVolumeAccumulator]   = PublicKey.findProgramAddressSync([Buffer.from("user_volume_accumulator"), userPubkey.toBuffer()], PUMPFUN_PROGRAM_ID);
  const [feeConfig]               = PublicKey.findProgramAddressSync([Buffer.from("fee_config"), FEE_SEED_CONST], FEE_PROGRAM_ID);
  const [creatorVault]            = PublicKey.findProgramAddressSync([Buffer.from("creator-vault"), creatorPublicKey.toBuffer()], PUMPFUN_PROGRAM_ID);
  const bondingCurveV2            = derivePumpFunBondingCurveV2PDA(mint);
  const includeBondingCurveV2     = await shouldIncludeV2Account(connection, bondingCurveV2);

  const globalAccountInfo = await connection.getAccountInfo(global);
  if (!globalAccountInfo?.data) throw new Error("Failed to fetch Global account data");
  const feeRecipient = parseGlobalFeeRecipient(globalAccountInfo.data);

  // --- Live fee bps: read directly from feeConfig account (avoids simulation blockhash issues) ---
  const { protocolBps, creatorBps, totalBps: totalFeeBps } = await getLiveFeeBps(connection, feeConfig);
  console.log("[BUY] Total fee bps:", totalFeeBps.toString());

  // --- ATA: idempotent create ---
  const associatedUser = await getAssociatedTokenAddress(
    mint, userPubkey, false, tokenProgramId, ASSOCIATED_TOKEN_PROGRAM_ID
  );
  const associatedUserInfo = await connection.getAccountInfo(associatedUser);
  const ataCreateIx = !associatedUserInfo
    ? createAssociatedTokenAccountIdempotentInstruction(
        userPubkey, associatedUser, userPubkey, mint, tokenProgramId, ASSOCIATED_TOKEN_PROGRAM_ID
      )
    : null;

  // --- Quotes ---
  const solIn = BigInt(lamportsAmount);
  const tokenOutQuoted = quoteTokensOutForSpendableSol(
    virtualTokenReserves, virtualSolReserves, solIn, protocolBps, creatorBps
  );
  const tokenOutQuotedCapped = tokenOutQuoted > realTokenReserves ? realTokenReserves : tokenOutQuoted;

  const tokenOutForBuyRaw = findMaxTokensOutForSpendableSolBuy(
    virtualTokenReserves,
    virtualSolReserves,
    solIn,
    totalFeeBps,
    realTokenReserves
  );
  // Keep legacy buy quote conservative relative to the exact-sol quote path.
  const tokenOutForBuy = tokenOutForBuyRaw > tokenOutQuotedCapped ? tokenOutQuotedCapped : tokenOutForBuyRaw;

  const tokenPriceInNative = tokenOutQuotedCapped > 0n
    ? (Number(solIn) / Number(tokenOutQuotedCapped)) * 10 ** (6 - 9)
    : 0;

  console.log("[BUY] Expected token output:", tokenOutQuotedCapped.toString(), "lamports");
  if (effectiveMode === "buy") {
    const legacyQuotedSpendable = quoteSpendableSolForTokens(
      virtualTokenReserves,
      virtualSolReserves,
      tokenOutForBuy,
      totalFeeBps
    );
    console.log("[BUY] Legacy buy quoted spendable SOL:", (legacyQuotedSpendable ?? 0n).toString(), "lamports");
    console.log("[BUY] Legacy buy token amount (pre-slippage):", tokenOutForBuy.toString(), "lamports");
  }
  console.log("[BUY] Estimated token price:", tokenPriceInNative, "priceInNative");

  const slippageBps = BigInt(Math.floor(slippage * 10000));
  const conservativeTokenOut = tokenOutForBuy * (10000n - slippageBps) / 10000n;
  const spendableForTokens =
    quoteSpendableSolForTokens(virtualTokenReserves, virtualSolReserves, conservativeTokenOut, totalFeeBps) ?? solIn;
  const maxSolCost = ceilDiv(spendableForTokens * (10000n + slippageBps), 10000n);
  let minTokensOutBase = tokenOutQuotedCapped;

  if (effectiveMode === "buy_exact_sol_in") {
    const transferFeeInfo = await getToken2022TransferFeeInfo(connection, mint, tokenProgramId);
    if (transferFeeInfo) {
      const { feeWithheld, tokensReceived } = applyTokenTransferFee(tokenOutQuotedCapped, transferFeeInfo);
      minTokensOutBase = tokensReceived;
      console.log(
        "[BUY] Token-2022 transfer fee: epoch:", transferFeeInfo.epoch.toString(),
        "withheld:", feeWithheld.toString(), "received:", tokensReceived.toString()
      );
    }
  }

  const minTokensOut = minTokensOutBase * (10000n - slippageBps) / 10000n;

  // --- Instruction data ---
  // Working legacy `buy` txs use 26 bytes (8 + 8 + 8 + 2-byte OptionBool).
  // Keep 24-byte compat only when enabled and trackVolume is not explicitly disabled.
  const use24ByteEncoding = PUMPFUN_BUY_USE_24B_COMPAT_ENCODING && trackVolume !== false;
  const data = Buffer.alloc(use24ByteEncoding ? 24 : 26);
  if (effectiveMode === "buy_exact_sol_in") {
    BUY_EXACT_SOL_IN_DISCRIMINATOR.copy(data, 0);
    data.writeBigUInt64LE(solIn, 8);          // spendable_sol_in
    data.writeBigUInt64LE(minTokensOut, 16);  // min_tokens_out
  } else {
    BUY_DISCRIMINATOR.copy(data, 0);
    data.writeBigUInt64LE(conservativeTokenOut, 8);  // amount
    data.writeBigUInt64LE(maxSolCost, 16);            // max_sol_cost
  }
  if (!use24ByteEncoding) {
    encodeOptionBool(trackVolume).copy(data, 24);
  }

  const buyIx = new TransactionInstruction({
    programId: PUMPFUN_PROGRAM_ID,
    keys: [
      { pubkey: global,                  isSigner: false, isWritable: false },
      { pubkey: feeRecipient,            isSigner: false, isWritable: true  },
      { pubkey: mint,                    isSigner: false, isWritable: false },
      { pubkey: bondingCurve,            isSigner: false, isWritable: true  },
      { pubkey: associatedBondingCurve,  isSigner: false, isWritable: true  },
      { pubkey: associatedUser,          isSigner: false, isWritable: true  },
      { pubkey: userPubkey,              isSigner: true,  isWritable: true  },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: tokenProgramId,          isSigner: false, isWritable: false },
      { pubkey: creatorVault,            isSigner: false, isWritable: true  },
      { pubkey: eventAuthority,          isSigner: false, isWritable: false },
      { pubkey: PUMPFUN_PROGRAM_ID,      isSigner: false, isWritable: false },
      { pubkey: globalVolumeAccumulator, isSigner: false, isWritable: false }, // IDL: writable=false
      { pubkey: userVolumeAccumulator,   isSigner: false, isWritable: true  },
      { pubkey: feeConfig,               isSigner: false, isWritable: false },
      { pubkey: FEE_PROGRAM_ID,          isSigner: false, isWritable: false },
      ...(includeBondingCurveV2 ? [{ pubkey: bondingCurveV2, isSigner: false, isWritable: false }] : []),
    ],
    data,
  });

  const instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
    ...(ataCreateIx ? [ataCreateIx] : []),
    buyIx,
  ];

  return {
    instructions,
    tokenAmount: effectiveMode === "buy_exact_sol_in" ? minTokensOut : conservativeTokenOut,
    tokenPrice:  tokenPriceInNative,
  };
}

async function buildPumpFunBuyExactSolIn(connection, mint, userKeypair, lamportsAmount, slippage = 0.03, trackVolume = true) {
  return buildPumpFunBuy(connection, mint, userKeypair, lamportsAmount, slippage, "buy_exact_sol_in", trackVolume);
}

// ---------------------------------------------------------------------------
// PumpSwap helpers
// ---------------------------------------------------------------------------

function derivePumpSwapPoolPDA(mint, quoteMint = WSOL_MINT, index = 0) {
  const [poolAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool-authority"), mint.toBuffer()], PUMPFUN_PROGRAM_ID
  );
  const poolIndexBuffer = Buffer.alloc(2);
  poolIndexBuffer.writeUInt16LE(index, 0);
  const [poolPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), poolIndexBuffer, poolAuthority.toBuffer(), mint.toBuffer(), quoteMint.toBuffer()],
    PUMP_SWAP_PROGRAM_ID
  );
  return poolPDA;
}

function derivePumpFunBondingCurveV2PDA(mint) {
  const [bondingCurveV2] = PublicKey.findProgramAddressSync(
    [Buffer.from("bonding-curve-v2"), mint.toBuffer()],
    PUMPFUN_PROGRAM_ID
  );
  return bondingCurveV2;
}

function derivePumpSwapPoolV2PDA(mint) {
  const [poolV2] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool-v2"), mint.toBuffer()],
    PUMP_SWAP_PROGRAM_ID
  );
  return poolV2;
}

async function buildPumpSwapBuy(connection, mint, userPubkey, lamportsAmount, slippage = 0.03, creatorPublicKey, trackVolume = true, isCashbackCoin = false) {
  const quoteMint = WSOL_MINT;
  const PUMP_SWAP_PROGRAM_ID_LOCAL        = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
  const FEE_PROGRAM_ID_LOCAL              = new PublicKey("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ");
  const QUOTE_TOKEN_PROGRAM_ID            = TOKEN_PROGRAM_ID;
  const baseTokenProgramId               = await getTokenProgramId(connection, mint);

  const pool          = derivePumpSwapPoolPDA(mint, quoteMint, 0);
  const [globalConfig] = PublicKey.findProgramAddressSync([Buffer.from("global_config")], PUMP_SWAP_PROGRAM_ID_LOCAL);

  const userBaseTokenAccount  = await getAssociatedTokenAddress(mint, userPubkey, false, baseTokenProgramId, ASSOCIATED_TOKEN_PROGRAM_ID);
  const userQuoteTokenAccount = await getAssociatedTokenAddress(quoteMint, userPubkey, false, QUOTE_TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);

  const instructions = [];
  if (!await connection.getAccountInfo(userQuoteTokenAccount)) {
    console.log("[BUY] Creating user WSOL ATA:", userQuoteTokenAccount.toBase58());
    instructions.push(createAssociatedTokenAccountInstruction(
      userPubkey, userQuoteTokenAccount, userPubkey, quoteMint, QUOTE_TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
    ));
  }
  if (!await connection.getAccountInfo(userBaseTokenAccount)) {
    console.log("[BUY] Creating user base token ATA:", userBaseTokenAccount.toBase58());
    instructions.push(createAssociatedTokenAccountInstruction(
      userPubkey, userBaseTokenAccount, userPubkey, mint, baseTokenProgramId, ASSOCIATED_TOKEN_PROGRAM_ID
    ));
  }

  const poolBaseTokenAccount  = await getAssociatedTokenAddress(mint, pool, true, baseTokenProgramId, ASSOCIATED_TOKEN_PROGRAM_ID);
  const poolQuoteTokenAccount = await getAssociatedTokenAddress(quoteMint, pool, true, QUOTE_TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);

  const protocolFeeRecipient = new PublicKey("62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV");
  const protocolFeeRecipientTokenAccount = await getAssociatedTokenAddress(quoteMint, protocolFeeRecipient, true);

  const CREATOR_VAULT_SEED = Buffer.from("creator_vault");
  const [coinCreatorVaultAuthority] = PublicKey.findProgramAddressSync(
    [CREATOR_VAULT_SEED, creatorPublicKey.toBuffer()], PUMP_SWAP_PROGRAM_ID_LOCAL
  );
  const [coinCreatorVaultAta] = PublicKey.findProgramAddressSync(
    [coinCreatorVaultAuthority.toBuffer(), QUOTE_TOKEN_PROGRAM_ID.toBuffer(), quoteMint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const FEE_CONFIG_MAGIC = Buffer.from([
    12, 20, 222, 252, 130, 94, 198, 118, 148, 37, 8, 24, 187, 101, 64, 101,
    244, 41, 141, 49, 86, 213, 113, 180, 212, 248, 9, 12, 24, 233, 168, 99
  ]);
  const [feeConfig] = PublicKey.findProgramAddressSync([Buffer.from("fee_config"), FEE_CONFIG_MAGIC], FEE_PROGRAM_ID_LOCAL);

  const [globalVolumeAccumulator] = PublicKey.findProgramAddressSync([Buffer.from("global_volume_accumulator")], PUMP_SWAP_PROGRAM_ID_LOCAL);
  const [userVolumeAccumulator]   = PublicKey.findProgramAddressSync([Buffer.from("user_volume_accumulator"), userPubkey.toBuffer()], PUMP_SWAP_PROGRAM_ID_LOCAL);

  const cashbackUserVolumeAccumulatorWsolAta = isCashbackCoin
    ? await getAssociatedTokenAddress(
        quoteMint, userVolumeAccumulator, true, QUOTE_TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
      )
    : null;

  const [eventAuthority] = PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], PUMP_SWAP_PROGRAM_ID_LOCAL);
  const poolV2 = derivePumpSwapPoolV2PDA(mint);
  const includePoolV2 = await shouldIncludeV2Account(connection, poolV2);

  const baseBalResp  = await connection.getTokenAccountBalance(poolBaseTokenAccount);
  const quoteBalResp = await connection.getTokenAccountBalance(poolQuoteTokenAccount);
  const realTokenReserves = BigInt(baseBalResp.value.amount);
  const realSolReserves   = BigInt(quoteBalResp.value.amount);
  if (realTokenReserves <= 0n || realSolReserves <= 0n) throw new Error("Invalid pool reserves");

  const feeBps = 30n;
  const tokenOut = BigInt(lamportsAmount);
  if (realTokenReserves < tokenOut) throw new Error(`[BUY] Insufficient token reserves: need ${tokenOut}, have ${realTokenReserves}`);

  const k = realTokenReserves * realSolReserves;
  const newTokenReservesAfterOut = realTokenReserves - tokenOut;
  if (newTokenReservesAfterOut <= 0n) throw new Error("[BUY] Cannot buy all reserves");

  let solIn = (k / newTokenReservesAfterOut) - realSolReserves;
  if (k % newTokenReservesAfterOut !== 0n) solIn += 1n;
  if (solIn < 0n) solIn = 0n;

  let solInWithFee = (solIn * 10000n) / (10000n - feeBps);
  if ((solIn * 10000n) % (10000n - feeBps) !== 0n) solInWithFee += 1n;

  const slippageBps = BigInt(Math.floor(slippage * 10000));
  let maxQuoteAmountIn = solInWithFee * (10000n + slippageBps) / 10000n;
  if (solInWithFee * (10000n + slippageBps) % 10000n !== 0n) maxQuoteAmountIn += 1n;

  const tokenPriceInNative = tokenOut > 0n
    ? (Number(solInWithFee) / Number(tokenOut)) * 10 ** (6 - 9)
    : 0;

  const wrapAmount = maxQuoteAmountIn + 500000n;
  instructions.push(
    SystemProgram.transfer({ fromPubkey: userPubkey, toPubkey: userQuoteTokenAccount, lamports: Number(wrapAmount) }),
    createSyncNativeInstruction(userQuoteTokenAccount, TOKEN_PROGRAM_ID)
  );

  const BUY_DISCRIMINATOR_SWAP = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);
  const data = Buffer.alloc(25);
  BUY_DISCRIMINATOR_SWAP.copy(data, 0);
  data.writeBigUInt64LE(tokenOut, 8);
  data.writeBigUInt64LE(maxQuoteAmountIn, 16);
  data.writeUInt8(trackVolume ? 1 : 0, 24);

  const buyIx = new TransactionInstruction({
    programId: PUMP_SWAP_PROGRAM_ID_LOCAL,
    keys: [
      { pubkey: pool,                             isSigner: false, isWritable: true  },
      { pubkey: userPubkey,                       isSigner: true,  isWritable: true  },
      { pubkey: globalConfig,                     isSigner: false, isWritable: false },
      { pubkey: mint,                             isSigner: false, isWritable: false },
      { pubkey: quoteMint,                        isSigner: false, isWritable: false },
      { pubkey: userBaseTokenAccount,             isSigner: false, isWritable: true  },
      { pubkey: userQuoteTokenAccount,            isSigner: false, isWritable: true  },
      { pubkey: poolBaseTokenAccount,             isSigner: false, isWritable: true  },
      { pubkey: poolQuoteTokenAccount,            isSigner: false, isWritable: true  },
      { pubkey: protocolFeeRecipient,             isSigner: false, isWritable: false },
      { pubkey: protocolFeeRecipientTokenAccount, isSigner: false, isWritable: true  },
      { pubkey: baseTokenProgramId,               isSigner: false, isWritable: false },
      { pubkey: QUOTE_TOKEN_PROGRAM_ID,           isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId,          isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID,      isSigner: false, isWritable: false },
      { pubkey: eventAuthority,                   isSigner: false, isWritable: false },
      { pubkey: PUMP_SWAP_PROGRAM_ID_LOCAL,       isSigner: false, isWritable: false },
      { pubkey: coinCreatorVaultAta,              isSigner: false, isWritable: true  },
      { pubkey: coinCreatorVaultAuthority,        isSigner: false, isWritable: false },
      { pubkey: globalVolumeAccumulator,          isSigner: false, isWritable: true  },
      { pubkey: userVolumeAccumulator,            isSigner: false, isWritable: true  },
      { pubkey: feeConfig,                        isSigner: false, isWritable: false },
      { pubkey: FEE_PROGRAM_ID_LOCAL,             isSigner: false, isWritable: false },
      ...(isCashbackCoin && cashbackUserVolumeAccumulatorWsolAta
        ? [{ pubkey: cashbackUserVolumeAccumulatorWsolAta, isSigner: false, isWritable: true }]
        : []),
      ...(includePoolV2 ? [{ pubkey: poolV2, isSigner: false, isWritable: false }] : []),
    ],
    data
  });

  instructions.push(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 500_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
    buyIx
  );

  return { instructions, tokenAmount: tokenOut, tokenPrice: tokenPriceInNative };
}

module.exports = { buildPumpFunBuy, buildPumpFunBuyExactSolIn, performBuy };
