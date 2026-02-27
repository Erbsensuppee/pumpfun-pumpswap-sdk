// File: sdk/buildPumpFunSell.js
const {
  Connection,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  ComputeBudgetProgram,
  Transaction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL
} = require("@solana/web3.js");
const { 
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createCloseAccountInstruction,
  createAssociatedTokenAccountInstruction,
  createSyncNativeInstruction
} = require("@solana/spl-token");
const { 
  reduceTokenLamports, 
  addSolLamports, 
  getAmountToSellFromCache 
} = require('./cacheManager/cacheManager.js');

const PumpProgramType = {
  PUMP_FUN: 0,
  PUMP_SWAP: 1,
};

// PUMPFUN
const PUMPFUN_PROGRAM_ID = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const FEE_PROGRAM_ID     = new PublicKey("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ");
const SELL_DISCRIMINATOR = Buffer.from([51, 230, 133, 164, 1, 127, 131, 173]);

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
  245, 210, 255, 59, 101, 93, 43, 182, 253, 109, 24, 176
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Fetch live fee bps from the fee program (per-coin override aware).
 * Falls back to Global account offsets, then hard fallback of 125n.
 */
async function getLiveFeeBps(connection, feeConfigPda) {
  const GET_FEES_DISCRIMINATOR = Buffer.from([124, 254, 211, 168, 174, 57, 138, 150]);
  const ix = new TransactionInstruction({
    programId: FEE_PROGRAM_ID,
    keys: [{ pubkey: feeConfigPda, isSigner: false, isWritable: false }],
    data: GET_FEES_DISCRIMINATOR,
  });

  try {
    const { value } = await connection.simulateTransaction(
      new Transaction().add(ix), undefined, false
    );
    if (value?.returnData?.data) {
      const raw = Buffer.from(value.returnData.data[0], 'base64');
      if (raw.length >= 24) {
        const protocolBps = raw.readBigUInt64LE(8);
        const creatorBps  = raw.readBigUInt64LE(16);
        const total = protocolBps + creatorBps;
        if (total > 0n) return total;
      }
    }
  } catch (_) { /* fall through */ }

  const [global] = PublicKey.findProgramAddressSync([Buffer.from("global")], PUMPFUN_PROGRAM_ID);
  const gInfo = await connection.getAccountInfo(global);
  if (gInfo?.data && gInfo.data.length >= 162) {
    const protocolBps = gInfo.data.readBigUInt64LE(105);
    const creatorBps  = gInfo.data.readBigUInt64LE(154);
    const total = protocolBps + creatorBps;
    if (total > 0n) return total;
  }
  return 125n;
}

function parseGlobalFeeRecipient(globalAccountData) {
  const offset = 8 + 1 + 32;
  if (!globalAccountData || globalAccountData.length < offset + 32) {
    throw new Error("Invalid Global account data for fee_recipient");
  }
  return new PublicKey(globalAccountData.slice(offset, offset + 32));
}

async function shouldIncludeV2Account(connection, pda) {
  if (V2_ACCOUNT_MODE === "off") return false;
  return true;
}

async function getTokenProgramId(connection, mint) {
  const info = await connection.getAccountInfo(mint);
  if (!info?.owner) throw new Error("Mint account not found");
  return info.owner;
}

// ---------------------------------------------------------------------------
// performSell
// ---------------------------------------------------------------------------

async function performSell(connection, mintAddress, userPubkey, payerKeypair, percent, slippage = 0.10) {
  const closeTokenAta = percent === 100;
  const tokenLamportAmountToSell = getAmountToSellFromCache(mintAddress, percent);
  console.log('[performSell types]', typeof tokenLamportAmountToSell, typeof slippage);
  if (tokenLamportAmountToSell === 0n) {
    console.log(`[SELL] No tokens to sell for ${mintAddress}`);
    return;
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const { instructions, lamportsOut } = await buildPumpFunSell(
        connection, new PublicKey(mintAddress), userPubkey,
        tokenLamportAmountToSell, closeTokenAta, slippage
      );
      const tx = new Transaction().add(...instructions);
      const sig = await sendAndConfirmTransaction(connection, tx, [payerKeypair], { commitment: 'confirmed' });
      console.log(`[SELL] Sell confirmed (attempt ${attempt}): https://solscan.io/tx/${sig}`);
      reduceTokenLamports(mintAddress, tokenLamportAmountToSell);
      addSolLamports(lamportsOut);
      return;
    } catch (err) {
      console.error(`[SELL] Sell attempt ${attempt} failed for ${mintAddress}:`, err.message);
      if (attempt === 3) console.error(`[SELL] All 3 sell attempts failed for ${mintAddress}. Skipping.`);
    }
  }
}

// ---------------------------------------------------------------------------
// getBondingCurveReserves
// ---------------------------------------------------------------------------

async function getBondingCurveReserves(connection, bondingCurve) {
  const info = await connection.getAccountInfo(bondingCurve);
  if (!info?.data) throw new Error("[SELL] Failed to fetch bonding curve data");
  const d = info.data;
  return {
    virtualTokenReserves:   d.readBigUInt64LE(8),
    virtualSolReserves:     d.readBigUInt64LE(16),
    realTokenReserves:      d.readBigUInt64LE(24),
    realSolReserves:        d.readBigUInt64LE(32),
    tokenTotalSupply:       d.readBigUInt64LE(40),
    bondingCurveIsComplete: d[48] === 1,
    creatorPublicKey:       new PublicKey(d.slice(49, 81)),
    isMayhemMode:           d.length > 81 ? d[81] === 1 : false,
    isCashbackCoin:         d.length > 82 ? d[82] === 1 : false,
  };
}

// ---------------------------------------------------------------------------
// buildPumpFunSell
// ---------------------------------------------------------------------------

async function buildPumpFunSell(connection, mint, userPubkey, tokenLamports, closeTokenAta = false, slippage = 0.03) {
  console.log("[SELL] Building Pump.fun sell for", mint.toBase58(), "amount:", tokenLamports.toString());

  const [bondingCurve] = PublicKey.findProgramAddressSync(
    [Buffer.from("bonding-curve"), mint.toBuffer()], PUMPFUN_PROGRAM_ID
  );
  const { virtualTokenReserves, virtualSolReserves, bondingCurveIsComplete, creatorPublicKey, isCashbackCoin } =
    await getBondingCurveReserves(connection, bondingCurve);

  switch (Number(bondingCurveIsComplete)) {
    case PumpProgramType.PUMP_FUN:
      console.log("[SELL] Bonding curve still active → using Pump.fun sell path");
      break;
    case PumpProgramType.PUMP_SWAP:
      console.log("[SELL] Bonding curve complete → redirecting to PumpSwap sell path");
      return await buildPumpSwapSell(connection, mint, userPubkey, tokenLamports, closeTokenAta, slippage, creatorPublicKey, true, isCashbackCoin);
    default:
      console.warn("[SELL] Unknown PumpProgramType, aborting sell");
      return;
  }

  // --- PDAs ---
  const [global]         = PublicKey.findProgramAddressSync([Buffer.from("global")], PUMPFUN_PROGRAM_ID);
  const [eventAuthority] = PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], PUMPFUN_PROGRAM_ID);
  const [feeConfig]      = PublicKey.findProgramAddressSync([Buffer.from("fee_config"), FEE_SEED_CONST], FEE_PROGRAM_ID);
  const [creatorVault]   = PublicKey.findProgramAddressSync([Buffer.from("creator-vault"), creatorPublicKey.toBuffer()], PUMPFUN_PROGRAM_ID);
  const bondingCurveV2   = derivePumpFunBondingCurveV2PDA(mint);
  const includeBondingCurveV2 = await shouldIncludeV2Account(connection, bondingCurveV2);

  // Cashback: userVolumeAccumulator for Pump program (remaining_accounts[0])
  const [userVolumeAccumulator] = PublicKey.findProgramAddressSync(
    [Buffer.from("user_volume_accumulator"), userPubkey.toBuffer()], PUMPFUN_PROGRAM_ID
  );

  // Token-2022 aware associatedBondingCurve
  const tokenProgramId = await getTokenProgramId(connection, mint);
  const [associatedBondingCurve] = PublicKey.findProgramAddressSync(
    [bondingCurve.toBuffer(), tokenProgramId.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const globalAccountInfo = await connection.getAccountInfo(global);
  if (!globalAccountInfo?.data) throw new Error("Failed to fetch Global account data");
  const feeRecipient = parseGlobalFeeRecipient(globalAccountInfo.data);

  const associatedUser = await getAssociatedTokenAddress(
    mint,
    userPubkey,
    false,
    tokenProgramId,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  // --- SOL output quote using bonding curve constant-product ---
  const k = virtualTokenReserves * virtualSolReserves;
  const newTokenReserves = virtualTokenReserves + tokenLamports;
  const newSolReserves   = k / newTokenReserves;
  const solOut = virtualSolReserves - newSolReserves;

  const slippageBps = BigInt(Math.floor(slippage * 10000));
  const minSolOut   = solOut * (10000n - slippageBps) / 10000n;

  // --- Instruction data: sell(amount, min_sol_output) ---
  const data = Buffer.alloc(24);
  SELL_DISCRIMINATOR.copy(data, 0);
  data.writeBigUInt64LE(tokenLamports, 8);
  data.writeBigUInt64LE(minSolOut, 16);

  const sellIx = new TransactionInstruction({
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
      { pubkey: creatorVault,            isSigner: false, isWritable: true  },
      { pubkey: tokenProgramId,          isSigner: false, isWritable: false }, // correct program for this mint
      { pubkey: eventAuthority,          isSigner: false, isWritable: false },
      { pubkey: PUMPFUN_PROGRAM_ID,      isSigner: false, isWritable: false },
      { pubkey: feeConfig,               isSigner: false, isWritable: false },
      { pubkey: FEE_PROGRAM_ID,          isSigner: false, isWritable: false },
      // remaining_accounts[0]: userVolumeAccumulator for Pump program (cashback)
      ...(isCashbackCoin ? [{ pubkey: userVolumeAccumulator, isSigner: false, isWritable: true }] : []),
      ...(includeBondingCurveV2 ? [{ pubkey: bondingCurveV2, isSigner: false, isWritable: false }] : []),
    ],
    data,
  });

  const instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
    sellIx,
  ];

  if (closeTokenAta) {
    instructions.push(createCloseAccountInstruction(associatedUser, userPubkey, userPubkey, [], tokenProgramId));
    console.log("[SELL] Adding instruction to close token account after sell");
  }

  console.log(`[SELL] Pump.fun sell built: expecting ~${Number(solOut) / LAMPORTS_PER_SOL} SOL output`);
  return { instructions, lamportsOut: solOut };
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

async function buildPumpSwapSell(connection, mint, userPubkey, tokenLamports, closeTokenAta = false, slippage = 0.03, creatorPublicKey, closeWsolAta = true, isCashbackCoin = false) {
  const quoteMint = WSOL_MINT;
  const PUMP_SWAP_PROGRAM_ID_LOCAL = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
  const FEE_PROGRAM_ID_LOCAL       = new PublicKey("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ");
  const QUOTE_TOKEN_PROGRAM_ID_LOCAL = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
  const ASSOCIATED_TOKEN_PROGRAM_ID_LOCAL = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
  const baseTokenProgramId = await getTokenProgramId(connection, mint);

  const pool = derivePumpSwapPoolPDA(mint, quoteMint, 0);
  const [globalConfig] = PublicKey.findProgramAddressSync([Buffer.from("global_config")], PUMP_SWAP_PROGRAM_ID_LOCAL);

  const userBaseTokenAccount = await getAssociatedTokenAddress(
    mint, userPubkey, false, baseTokenProgramId, ASSOCIATED_TOKEN_PROGRAM_ID_LOCAL
  );
  const userQuoteTokenAccount = await getAssociatedTokenAddress(
    quoteMint, userPubkey, false, QUOTE_TOKEN_PROGRAM_ID_LOCAL, ASSOCIATED_TOKEN_PROGRAM_ID_LOCAL
  );

  const instructions = [];
  if (!await connection.getAccountInfo(userQuoteTokenAccount)) {
    instructions.push(createAssociatedTokenAccountInstruction(
      userPubkey, userQuoteTokenAccount, userPubkey, quoteMint,
      QUOTE_TOKEN_PROGRAM_ID_LOCAL, ASSOCIATED_TOKEN_PROGRAM_ID_LOCAL
    ));
  }

  const poolBaseTokenAccount = await getAssociatedTokenAddress(
    mint, pool, true, baseTokenProgramId, ASSOCIATED_TOKEN_PROGRAM_ID_LOCAL
  );
  const poolQuoteTokenAccount = await getAssociatedTokenAddress(
    quoteMint, pool, true, QUOTE_TOKEN_PROGRAM_ID_LOCAL, ASSOCIATED_TOKEN_PROGRAM_ID_LOCAL
  );

  const protocolFeeRecipient = new PublicKey("62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV");
  const protocolFeeRecipientTokenAccount = await getAssociatedTokenAddress(
    quoteMint, protocolFeeRecipient, true, QUOTE_TOKEN_PROGRAM_ID_LOCAL, ASSOCIATED_TOKEN_PROGRAM_ID_LOCAL
  );

  const [coinCreatorVaultAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("creator_vault"), creatorPublicKey.toBuffer()], PUMP_SWAP_PROGRAM_ID_LOCAL
  );
  const [coinCreatorVaultAta] = PublicKey.findProgramAddressSync(
    [coinCreatorVaultAuthority.toBuffer(), QUOTE_TOKEN_PROGRAM_ID_LOCAL.toBuffer(), quoteMint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID_LOCAL
  );

  const FEE_CONFIG_MAGIC = Buffer.from([
    12, 20, 222, 252, 130, 94, 198, 118, 148, 37, 8, 24, 187, 101, 64, 101,
    244, 41, 141, 49, 86, 213, 113, 180, 212, 248, 9, 12, 24, 233, 168, 99
  ]);
  const [feeConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from("fee_config"), FEE_CONFIG_MAGIC], FEE_PROGRAM_ID_LOCAL
  );

  const [eventAuthority] = PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], PUMP_SWAP_PROGRAM_ID_LOCAL);
  const poolV2 = derivePumpSwapPoolV2PDA(mint);
  const includePoolV2 = await shouldIncludeV2Account(connection, poolV2);

  // Cashback remaining accounts
  const [userVolumeAccumulatorAmm] = PublicKey.findProgramAddressSync(
    [Buffer.from("user_volume_accumulator"), userPubkey.toBuffer()], PUMP_SWAP_PROGRAM_ID_LOCAL
  );
  const cashbackUserVolumeAccumulatorWsolAta = isCashbackCoin
    ? await getAssociatedTokenAddress(
        quoteMint, userVolumeAccumulatorAmm, true, TOKEN_PROGRAM_ID_LOCAL, ASSOCIATED_TOKEN_PROGRAM_ID_LOCAL
      )
    : null;

  const baseBalResp  = await connection.getTokenAccountBalance(poolBaseTokenAccount);
  const quoteBalResp = await connection.getTokenAccountBalance(poolQuoteTokenAccount);
  const realTokenReserves = BigInt(baseBalResp.value.amount);
  const realSolReserves   = BigInt(quoteBalResp.value.amount);
  if (realTokenReserves <= 0n || realSolReserves <= 0n) throw new Error("Invalid pool reserves");

  const feeBps = 30n;
  const tokenInWithFee = BigInt(tokenLamports) * (10000n - feeBps) / 10000n;
  const newTokenReserve = realTokenReserves + tokenInWithFee;
  const product = realTokenReserves * realSolReserves;
  let quoteOut = realSolReserves - (product / newTokenReserve);
  if (quoteOut < 0n) quoteOut = 0n;

  const slippageBps = BigInt(Math.floor(slippage * 10000));
  const minQuoteAmountOut = quoteOut * (10000n - slippageBps) / 10000n;

  const SELL_DISCRIMINATOR_SWAP = Buffer.from([51, 230, 133, 164, 1, 127, 131, 173]);
  const data = Buffer.alloc(24);
  SELL_DISCRIMINATOR_SWAP.copy(data, 0);
  data.writeBigUInt64LE(BigInt(tokenLamports), 8);
  data.writeBigUInt64LE(minQuoteAmountOut, 16);

  const sellIx = new TransactionInstruction({
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
      { pubkey: QUOTE_TOKEN_PROGRAM_ID_LOCAL,     isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId,          isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID_LOCAL,isSigner: false, isWritable: false },
      { pubkey: eventAuthority,                   isSigner: false, isWritable: false },
      { pubkey: PUMP_SWAP_PROGRAM_ID_LOCAL,       isSigner: false, isWritable: false },
      { pubkey: coinCreatorVaultAta,              isSigner: false, isWritable: true  },
      { pubkey: coinCreatorVaultAuthority,        isSigner: false, isWritable: false },
      { pubkey: feeConfig,                        isSigner: false, isWritable: false },
      { pubkey: FEE_PROGRAM_ID_LOCAL,             isSigner: false, isWritable: false },
      // remaining_accounts[0]: WSOL ATA of userVolumeAccumulator (cashback)
      ...(isCashbackCoin && cashbackUserVolumeAccumulatorWsolAta
        ? [{ pubkey: cashbackUserVolumeAccumulatorWsolAta, isSigner: false, isWritable: true }]
        : []),
      // remaining_accounts[1]: userVolumeAccumulator for AMM program (cashback)
      ...(isCashbackCoin ? [{ pubkey: userVolumeAccumulatorAmm, isSigner: false, isWritable: true }] : []),
      ...(includePoolV2 ? [{ pubkey: poolV2, isSigner: false, isWritable: false }] : []),
    ],
    data
  });

  instructions.push(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
    sellIx
  );

  if (closeTokenAta) {
    instructions.push(createCloseAccountInstruction(userBaseTokenAccount, userPubkey, userPubkey, [], baseTokenProgramId));
  }
  if (closeWsolAta) {
    instructions.push(
      createSyncNativeInstruction(userQuoteTokenAccount, TOKEN_PROGRAM_ID),
      createCloseAccountInstruction(userQuoteTokenAccount, userPubkey, userPubkey, [], QUOTE_TOKEN_PROGRAM_ID_LOCAL)
    );
  }

  return { instructions, lamportsOut: minQuoteAmountOut };
}

module.exports = { buildPumpFunSell, performSell };
