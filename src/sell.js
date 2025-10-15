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
} = require('./cacheManager/cacheManager.js'); // Adjust path if needed
/**
 * Enum for Pump program types
 */
const PumpProgramType = {
  PUMP_FUN: 0,
  PUMP_SWAP: 1,
};

// PUMPFUN
const PUMPFUN_PROGRAM_ID = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const FEE_PROGRAM_ID = new PublicKey("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ");
const SELL_DISCRIMINATOR = Buffer.from([51, 230, 133, 164, 1, 127, 131, 173]);

// PUMPSWAP
const PUMP_SWAP_PROGRAM_ID = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');

// From IDL "value" array
const FEE_SEED_CONST = new Uint8Array([
  1, 86, 224, 246, 147, 102, 90, 207, 68, 219,
  21, 104, 191, 23, 91, 170, 81, 137, 203, 151,
  245, 210, 255, 59, 101, 93, 43, 182, 253, 109, 24, 176
]);

/**
 * Performs a sell (percentage-based) with up to 3 retries on failure (no delay between retries).
 * Calls buildPumpFunSell and sends the transaction.
 * Updates cache on success.
 * @param {Connection} connection
 * @param {string} mintAddress - Mint as string (from cache)
 * @param {PublicKey} userPubkey
 * @param {Keypair} payerKeypair
 * @param {number} percent - 50, 100, etc.
 * @param {number} slippage
 */
async function performSell(connection, mintAddress, userPubkey, payerKeypair, percent, slippage = 0.10) {
  console.log(
    '[performSell types]',
    typeof lamportsToBuy,
    typeof slippage
  );

  const closeTokenAta = percent === 100;
  const tokenLamportAmountToSell = getAmountToSellFromCache(mintAddress, percent);
  if (tokenLamportAmountToSell === 0n) {
    console.log(`[SELL] No tokens to sell for ${mintAddress}`);
    return;
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const { instructions, lamportsOut } = await buildPumpFunSell(
        connection,
        new PublicKey(mintAddress),
        userPubkey,
        tokenLamportAmountToSell,
        closeTokenAta,
        slippage
      );
      const tx = new Transaction().add(...instructions);

      const sig = await sendAndConfirmTransaction(
        connection,
        tx,
        [payerKeypair],
        { commitment: 'confirmed' }
      );
      console.log(`[SELL] Sell confirmed (attempt ${attempt}): https://solscan.io/tx/${sig}`);

      // Update cache on success
      reduceTokenLamports(mintAddress, tokenLamportAmountToSell);
      addSolLamports(lamportsOut);
      return; // Success: exit function
    } catch (err) {
      console.error(`[SELL] Sell attempt ${attempt} failed for ${mintAddress}:`, err.message);
      if (attempt === 3) {
        console.error(`[SELL] All 3 sell attempts failed for ${mintAddress}. Skipping.`);
        // Continue without throwing—bot keeps running
      }
      // No delay: continue to next attempt immediately
    }
  }
}

/**
 * Helper: decode bonding curve reserves
 */
async function getBondingCurveReserves(connection, bondingCurve) {
  const info = await connection.getAccountInfo(bondingCurve);
  if (!info?.data) throw new Error("[SELL] Failed to fetch bonding curve data");

  const data = info.data;

  // Struct layout from Pump.fun docs:
  // 0:  discriminator / padding (8 bytes)
  // 8:  virtual_token_reserves (u64)
  // 16: virtual_sol_reserves (u64)
  // 24: real_token_reserves (u64)
  // 32: real_sol_reserves (u64)
  // 40: token_total_supply (u64)
  // 48: complete (bool)
  // 49: creator (Pubkey, 32 bytes)
  const virtualTokenReserves = data.readBigUInt64LE(8);
  const virtualSolReserves = data.readBigUInt64LE(16);
  const realTokenReserves = data.readBigUInt64LE(24);
  const realSolReserves = data.readBigUInt64LE(32);
  const tokenTotalSupply = data.readBigUInt64LE(40);
  const bondingCurveIsComplete = data[48] === 1; // bool is 1 byte (0 or 1)

  // Extract the creator's public key from the account data
  const creatorStart = 49;
  const creatorEnd = creatorStart + 32;
  const creatorBytes = data.slice(creatorStart, creatorEnd); // 32 bytes for the public key
  const creatorPublicKey = new PublicKey(creatorBytes);

  return { 
    virtualTokenReserves, 
    virtualSolReserves, 
    realTokenReserves, 
    realSolReserves, 
    tokenTotalSupply,
    bondingCurveIsComplete,
    creatorPublicKey };
}

/**
 * Builds a Pump.fun sell instruction using bonding curve reserves
 * @param {Connection} connection
 * @param {PublicKey} mint
 * @param {PublicKey} userPubkey
 * @param {bigint} tokenLamports - token amount to sell
 * @param {number} slippage - e.g. 0.03 for 3%
 */
async function buildPumpFunSell(connection, mint, userPubkey, tokenLamports, closeTokenAta = false, slippage = 0.03) {
  console.log("[SELL] Building Pump.fun sell for", mint.toBase58(), "amount:", tokenLamports.toString());

  // --- check for bonding Curve Complete, if true switch to pumpSwap
  const [bondingCurve] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("bonding-curve"), 
      mint.toBuffer()
    ],
    PUMPFUN_PROGRAM_ID
  );
  const { virtualTokenReserves, virtualSolReserves, bondingCurveIsComplete, creatorPublicKey } = await getBondingCurveReserves(connection, bondingCurve);
  const curveStatus = Number(bondingCurveIsComplete);

  switch (curveStatus) {
    case PumpProgramType.PUMP_FUN:
      console.log("[SELL] Bonding curve still active → using Pump.fun sell path");
      break;

    case PumpProgramType.PUMP_SWAP:
      console.log("[SELL] Bonding curve complete → redirecting to PumpSwap sell path");
      return await buildPumpSwapSell(connection, mint, userPubkey, tokenLamports, closeTokenAta, slippage, creatorPublicKey);

    default:
      console.warn("[SELL] Unknown PumpProgramType, aborting sell");
      return;
  }
  // --- Derive PDAs ---
  const [global] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("global")
    ], 
    PUMPFUN_PROGRAM_ID
  );
  const [associatedBondingCurve] = PublicKey.findProgramAddressSync(
    [
      bondingCurve.toBuffer(),
      TOKEN_PROGRAM_ID.toBuffer(),
      mint.toBuffer()
    ],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const [eventAuthority] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("__event_authority")
    ],
    PUMPFUN_PROGRAM_ID
  );

  const [feeConfig] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("fee_config"), 
      FEE_SEED_CONST
    ],
    FEE_PROGRAM_ID // or the actual program that owns it
  );

  const feeRecipient = new PublicKey("CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM");
  const associatedUser = await getAssociatedTokenAddress(mint, userPubkey);

  // --- Fetch bonding curve reserves ---

  const [creatorVault] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("creator-vault"),
      creatorPublicKey.toBuffer()
    ],
    PUMPFUN_PROGRAM_ID
  );

  // --- Compute SOL output from bonding curve formula ---
  const k = virtualTokenReserves * virtualSolReserves;
  const newTokenReserves = virtualTokenReserves + tokenLamports;
  const newSolReserves = k / newTokenReserves;
  const solOut = virtualSolReserves - newSolReserves;

  // Apply slippage tolerance
  const slippageBps = BigInt(Math.floor(slippage * 10000));
  const minSolOut = solOut * (10000n - slippageBps) / 10000n;

  // --- Build instruction data ---
  const data = Buffer.alloc(24);
  SELL_DISCRIMINATOR.copy(data, 0);
  data.writeBigUInt64LE(tokenLamports, 8);
  data.writeBigUInt64LE(minSolOut, 16);

  // --- Construct sell instruction ---
  const sellIx = new TransactionInstruction({
    programId: PUMPFUN_PROGRAM_ID,
    keys: [
      { pubkey: global, isSigner: false, isWritable: false },
      { pubkey: feeRecipient, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: bondingCurve, isSigner: false, isWritable: true },
      { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
      { pubkey: associatedUser, isSigner: false, isWritable: true },
      { pubkey: userPubkey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: creatorVault, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: eventAuthority, isSigner: false, isWritable: false },
      { pubkey: PUMPFUN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: feeConfig, isSigner: false, isWritable: false },
      { pubkey: FEE_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });

  const instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
    sellIx,
  ];

  if (closeTokenAta) {
    const closeIx = createCloseAccountInstruction(
      associatedUser,  // token account
      userPubkey,      // destination (refund rent here)
      userPubkey       // owner
    );
    instructions.push(closeIx);
    console.log("[SELL] Adding instruction to close token account after sell");
  }

  console.log(`[SELL] Pump.fun sell built: expecting ~${Number(solOut) / LAMPORTS_PER_SOL} SOL output`);

    // Return both instructions and expected SOL output
  return {
    instructions,
    lamportsOut: solOut, // BigInt

  };
}

/**
 * Derives the on-chain PumpSwap pool PDA for a given token mint.
 * This matches the official SDK + verified bot logic.
 *
 * @param {PublicKey} mint - Token mint (base token)
 * @param {PublicKey} [quoteMint=WSOL_MINT] - Quote token (default = WSOL)
 * @param {number} [index=0] - Pool index (usually 0)
 * @returns {PublicKey} pool PDA
 */
function derivePumpSwapPoolPDA(mint, quoteMint = WSOL_MINT, index = 0) {
  // 1 Derive the Pump "pool-authority" PDA
  const [poolAuthority] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("pool-authority"), mint.toBuffer()
    ],
    PUMPFUN_PROGRAM_ID
  );

  // 2 Encode index (u16 little-endian)
  const poolIndexBuffer = Buffer.alloc(2);
  poolIndexBuffer.writeUInt16LE(index, 0);

  // 3 Derive the PumpSwap pool PDA
  const [poolPDA] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("pool"),
      poolIndexBuffer,
      poolAuthority.toBuffer(),  // must be derived as above
      mint.toBuffer(),           // base mint
      quoteMint.toBuffer(),      // quote mint (usually WSOL)
    ],
    PUMP_SWAP_PROGRAM_ID
  );

  return poolPDA;
}


/**
 * Builds a PumpSwap sell instruction using the Pool model
 * @param {Connection} connection
 * @param {PublicKey} mint - The base token mint (the token being sold)
 * @param {PublicKey} userPubkey - The user's wallet address
 * @param {bigint} tokenLamports - Token amount to sell (in base token smallest units)
 * @param {boolean} closeTokenAta - Whether to close the ATA after selling
 * @param {number} slippage - Slippage tolerance (e.g. 0.03 for 3%)
 * @param {PublicKey} creatorPublicKey - The coin creator's public key
 */
async function buildPumpSwapSell(connection, mint, userPubkey, tokenLamports, closeTokenAta = false, slippage = 0.03, creatorPublicKey, closeWsolAta = true) {
  const quoteMint = WSOL_MINT;
  const PUMP_SWAP_PROGRAM_ID = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
  const FEE_PROGRAM_ID = new PublicKey("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ");
  const TOKEN_2022_PROGRAM_ID = new PublicKey([
    140, 151, 37, 143, 78, 36, 137, 241, 187, 61, 16, 41, 20, 142, 13, 131,
    11, 90, 19, 153, 218, 255, 16, 132, 4, 142, 123, 216, 219, 233, 248, 89
  ]);  // Token-2022 from IDL

  // --- Pool derivation ---
  const pool = derivePumpSwapPoolPDA(mint, quoteMint, 0);
  //console.log("[SELL] Derived Pool:", pool.toBase58());

  const [globalConfig] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("global_config")
    ], 
    PUMP_SWAP_PROGRAM_ID);

  // --- User accounts ---
  const userBaseTokenAccount = await getAssociatedTokenAddress(mint, userPubkey);
  const userQuoteTokenAccount = await getAssociatedTokenAddress(quoteMint, userPubkey);

  // --- Check and create userQuoteTokenAccount if not initialized ---
  const instructions = [];
  const userQuoteAccountInfo = await connection.getAccountInfo(userQuoteTokenAccount);
  if (!userQuoteAccountInfo) {
    //console.log("[SELL] Creating user WSOL ATA:", userQuoteTokenAccount.toBase58());
    const createAtaIx = createAssociatedTokenAccountInstruction(
      userPubkey, // payer
      userQuoteTokenAccount, // ATA address
      userPubkey, // owner
      quoteMint, // mint
      TOKEN_PROGRAM_ID, // token program (WSOL uses standard SPL)
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    instructions.push(createAtaIx);
  }

  // --- Pool token accounts (off-curve) ---
  const poolBaseTokenAccount = await getAssociatedTokenAddress(mint, pool, true);
  const poolQuoteTokenAccount = await getAssociatedTokenAddress(quoteMint, pool, true);

  // --- Protocol fee recipient (user-provided fix) ---
  const protocolFeeRecipient = new PublicKey("62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV");
  const protocolFeeRecipientTokenAccount = await getAssociatedTokenAddress(quoteMint, protocolFeeRecipient, true);
  //console.log("[SELL] Protocol Fee TA:", protocolFeeRecipientTokenAccount.toBase58());  // Verify on Solscan

  // --- Coin creator vault ---
  const [coinCreatorVaultAuthority] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("creator_vault"), 
      creatorPublicKey.toBuffer()
    ],
    PUMP_SWAP_PROGRAM_ID
  );
  const [coinCreatorVaultAta] = PublicKey.findProgramAddressSync(
    [
      coinCreatorVaultAuthority.toBuffer(),
      TOKEN_PROGRAM_ID.toBuffer(),
      quoteMint.toBuffer(),
    ],
    TOKEN_2022_PROGRAM_ID
  );
  //console.log("[SELL] Creator Vault Auth:", coinCreatorVaultAuthority.toBase58());
  //console.log("[SELL] Creator Vault ATA:", coinCreatorVaultAta.toBase58());  // Verify on Solscan

  // --- Fee config ---
  const FEE_CONFIG_MAGIC = Buffer.from([
    12, 20, 222, 252, 130, 94, 198, 118, 148, 37, 8, 24, 187, 101, 64, 101,
    244, 41, 141, 49, 86, 213, 113, 180, 212, 248, 9, 12, 24, 233, 168, 99
  ]);
  const [feeConfig] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("fee_config"), 
      FEE_CONFIG_MAGIC
    ],
    FEE_PROGRAM_ID
  );

  const [eventAuthority] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("__event_authority")
    ],
     PUMP_SWAP_PROGRAM_ID);

  // --- Fetch reserves & calculate ---
  const baseBalResp = await connection.getTokenAccountBalance(poolBaseTokenAccount);
  const quoteBalResp = await connection.getTokenAccountBalance(poolQuoteTokenAccount);
  const realTokenReserves = BigInt(baseBalResp.value.amount);
  const realSolReserves = BigInt(quoteBalResp.value.amount);
  if (realTokenReserves <= 0n || realSolReserves <= 0n) throw new Error("Invalid pool reserves");

  const feeBps = 30n;  // Pool fee
  const tokenInWithFee = BigInt(tokenLamports) * (10000n - feeBps) / 10000n;
  const newTokenReserve = realTokenReserves + tokenInWithFee;
  const product = realTokenReserves * realSolReserves;
  let quoteOut = realSolReserves - (product / newTokenReserve);
  if (quoteOut < 0n) quoteOut = 0n;

  const slippageBps = BigInt(Math.floor(slippage * 10000));
  const minQuoteAmountOut = quoteOut * (10000n - slippageBps) / 10000n;

  // --- Data ---
  const SELL_DISCRIMINATOR = Buffer.from([51, 230, 133, 164, 1, 127, 131, 173]);
  const data = Buffer.alloc(24);
  SELL_DISCRIMINATOR.copy(data, 0);
  data.writeBigUInt64LE(BigInt(tokenLamports), 8);
  data.writeBigUInt64LE(minQuoteAmountOut, 16);

  // --- Instruction ---
  const sellIx = new TransactionInstruction({
    programId: PUMP_SWAP_PROGRAM_ID,
    keys: [
      { pubkey: pool, isSigner: false, isWritable: true },  // pool
      { pubkey: userPubkey, isSigner: true, isWritable: true },  // user
      { pubkey: globalConfig, isSigner: false, isWritable: false },  // global_config
      { pubkey: mint, isSigner: false, isWritable: false },  // base_mint
      { pubkey: quoteMint, isSigner: false, isWritable: false },  // quote_mint
      { pubkey: userBaseTokenAccount, isSigner: false, isWritable: true },  // user_base_token_account
      { pubkey: userQuoteTokenAccount, isSigner: false, isWritable: true },  // user_quote_token_account
      { pubkey: poolBaseTokenAccount, isSigner: false, isWritable: true },  // pool_base_token_account
      { pubkey: poolQuoteTokenAccount, isSigner: false, isWritable: true },  // pool_quote_token_account
      { pubkey: protocolFeeRecipient, isSigner: false, isWritable: false },  // protocol_fee_recipient
      { pubkey: protocolFeeRecipientTokenAccount, isSigner: false, isWritable: true },  // protocol_fee_recipient_token_account
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },  // base_token_program
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },  // quote_token_program
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },  // system_program
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },  // associated_token_program
      { pubkey: eventAuthority, isSigner: false, isWritable: false },  // event_authority
      { pubkey: PUMP_SWAP_PROGRAM_ID, isSigner: false, isWritable: false },  // program
      { pubkey: coinCreatorVaultAta, isSigner: false, isWritable: true },  // coin_creator_vault_ata
      { pubkey: coinCreatorVaultAuthority, isSigner: false, isWritable: false },  // coin_creator_vault_authority
      { pubkey: feeConfig, isSigner: false, isWritable: false },  // fee_config
      { pubkey: FEE_PROGRAM_ID, isSigner: false, isWritable: false }  // fee_program
    ],
    data
  });

  instructions.push(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
    sellIx
  );

  if (closeTokenAta) {
    const closeIx = createCloseAccountInstruction(userBaseTokenAccount, userPubkey, userPubkey);
    instructions.push(closeIx);
  }

  // --- Optionally sync and close WSOL ATA ---
  if (closeWsolAta) {
    const syncIx = createSyncNativeInstruction(userQuoteTokenAccount, TOKEN_PROGRAM_ID);
    const closeWsolIx = createCloseAccountInstruction(
      userQuoteTokenAccount, // account to close
      userPubkey, // destination for SOL
      userPubkey, // owner
      TOKEN_PROGRAM_ID // token program
    );
    instructions.push(syncIx, closeWsolIx);
  }

  return { 
    instructions, 
    lamportsOut: minQuoteAmountOut };
}



module.exports = { buildPumpFunSell, performSell };
