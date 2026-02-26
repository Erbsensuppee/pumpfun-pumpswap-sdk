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
  getOrCreateAssociatedTokenAccount,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createSyncNativeInstruction
} = require("@solana/spl-token");
const { 
  addTokenLamports 
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
const BUY_DISCRIMINATOR = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);

// PUMPSWAP
const PUMP_SWAP_PROGRAM_ID = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');


const FEE_SEED_CONST = new Uint8Array([
  1, 86, 224, 246, 147, 102, 90, 207, 68, 219,
  21, 104, 191, 23, 91, 170, 81, 137, 203, 151,
  245, 210, 255, 59, 101, 93, 43, 182, 253, 109, 24, 176,
]);

function parseGlobalFeeRecipient(globalAccountData) {
  // Anchor discriminator (8) + initialized (1) + authority (32) = 41
  const feeRecipientOffset = 8 + 1 + 32;
  if (!globalAccountData || globalAccountData.length < feeRecipientOffset + 32) {
    throw new Error("Invalid Global account data for fee_recipient");
  }
  return new PublicKey(globalAccountData.slice(feeRecipientOffset, feeRecipientOffset + 32));
}

/**
 * Performs a buy with retries (up to 2 retries on failure).
 * Calls buildPumpFunBuy and sends the transaction.
 * Updates cache on success.
 * @param {Connection} connection
 * @param {PublicKey} mintAddress
 * @param {Keypair} payerKeypair
 * @param {bigint} amountInLamports
 * @param {number} slippage
 * @param {number} retries
 * @returns {string} signature on success
 */
async function performBuy(connection, mintAddress, payerKeypair, amountInLamports, slippage = 0.10, retries = 2) {
  console.log(
    '[performBuy types]',
    typeof connection,
    typeof mintAddress,
    typeof payerKeypair,
    typeof amountInLamports,
    typeof slippage,
    typeof retries
  );

  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      const { instructions, tokenAmount, tokenPrice } = await buildPumpFunBuy(
        connection,
        mintAddress,
        payerKeypair,
        amountInLamports,
        slippage
      );
      const tx = new Transaction().add(...instructions);

      const sig = await sendAndConfirmTransaction(
        connection,
        tx,
        [payerKeypair],
        { commitment: 'confirmed' }
      );
      console.log(`[BUY] Buy confirmed: https://solscan.io/tx/${sig}`);

      // Update cache
      addTokenLamports(mintAddress.toBase58(), tokenAmount, tokenPrice);

      return sig;
    } catch (err) {
      console.error(`[BUY] Buy attempt ${attempt} failed for ${mintAddress.toBase58()}:`, err.message);
      if (attempt > retries) throw err;
      await new Promise(res => setTimeout(res, 100)); // 0.1s delay
    }
  }
}

/**
 * Helper: decode bonding curve reserves
 */
async function getBondingCurveReserves(connection, bondingCurve) {
  const info = await connection.getAccountInfo(bondingCurve);
  if (!info?.data) throw new Error("Failed to fetch bonding curve data");

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

// --- Build Buy Instruction ---
async function buildPumpFunBuy(connection, mint, userKeypair, lamportsAmount, slippage = 0.03) {
    console.log(
    '[buildPumpFunBuy types]',
    typeof connection,
    typeof mint,
    typeof userKeypair,
    typeof lamportsAmount,
    typeof slippage,
  );
  const userPubkey = userKeypair.publicKey;
  console.log(`Building Pump.fun buy for ${mint.toBase58()} amount: ${Number(lamportsAmount) / LAMPORTS_PER_SOL}`);

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
      console.log("[BUY] Bonding curve still active → using Pump.fun buy path");
      break;

    case PumpProgramType.PUMP_SWAP:
      console.log("[BUY] Bonding curve complete → redirecting to PumpSwap buy path");
      return await buildPumpSwapBuy(connection, mint, userPubkey, lamportsAmount, slippage, creatorPublicKey);

    default:
      console.warn("[BUY] Unknown PumpProgramType, aborting buy");
      return;
  }
  // --- PDAs ---
  const [global] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("global")
    ], 
    PUMPFUN_PROGRAM_ID);
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

  const [globalVolumeAccumulator] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("global_volume_accumulator")
    ],
    PUMPFUN_PROGRAM_ID
  );

  const [userVolumeAccumulator] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("user_volume_accumulator"), 
      userPubkey.toBuffer()
    ],
    PUMPFUN_PROGRAM_ID
  );

  const [feeConfig] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("fee_config"), 
      FEE_SEED_CONST
    ],
    FEE_PROGRAM_ID
  );

  const globalAccountInfo = await connection.getAccountInfo(global);
  if (!globalAccountInfo?.data) {
    throw new Error("Failed to fetch Global account data");
  }
  const feeRecipient = parseGlobalFeeRecipient(globalAccountInfo.data);
  // --- Ensure the user has an associated token account (ATA) ---
  const associatedUser = await getOrCreateAssociatedTokenAccount(
    connection,
    userKeypair,       // payer
    mint,              // mint
    userKeypair.publicKey // owner
  );

  const [creatorVault] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("creator-vault"), 
      creatorPublicKey.toBuffer()
    ],
    PUMPFUN_PROGRAM_ID
  );

  // --- Bonding curve buy formula (SOL -> token) ---
  const solIn = BigInt(lamportsAmount);           // SOL in lamports
  const k = virtualTokenReserves * virtualSolReserves;
  const newSolReserves = virtualSolReserves + solIn;   // SOL after deposit
  const newTokenReserves = k / newSolReserves;         // constant-product
  const tokenOut = virtualTokenReserves - newTokenReserves; // expected token amount (BigInt)

  // price per token (SOL per full token) — still Number
  const tokenDecimals = 6;
  const solDecimals = 9;

  // convert BigInt → Number only here for price calculation
  const tokenPriceInNative = (Number(solIn) / Number(tokenOut)) * 10 ** (tokenDecimals - solDecimals);

  console.log("[BUY] Expected token output:", tokenOut.toString(), "lamports");
  console.log("[BUY] Estimated token price:", tokenPriceInNative, "priceInNative");

  // Apply slippage safely in BigInt space
  const slippageBps = BigInt(Math.floor(slippage * 10000));
  const maxSolCost = solIn * (10000n + slippageBps) / 10000n;

  // --- Instruction data ---
  const data = Buffer.alloc(25);
  BUY_DISCRIMINATOR.copy(data, 0);
  data.writeBigUInt64LE(tokenOut, 8);
  data.writeBigUInt64LE(maxSolCost, 16);
  data.writeUInt8(1, 24); // track_volume = Some(true)

  // --- Build instruction ---
  const buyIx = new TransactionInstruction({
    programId: PUMPFUN_PROGRAM_ID,
    keys: [
      { pubkey: global, isSigner: false, isWritable: false },
      { pubkey: feeRecipient, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: bondingCurve, isSigner: false, isWritable: true },
      { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
      { pubkey: associatedUser.address, isSigner: false, isWritable: true },
      { pubkey: userPubkey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: creatorVault, isSigner: false, isWritable: true },
      { pubkey: eventAuthority, isSigner: false, isWritable: false },
      { pubkey: PUMPFUN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: globalVolumeAccumulator, isSigner: false, isWritable: true },
      { pubkey: userVolumeAccumulator, isSigner: false, isWritable: true },
      { pubkey: feeConfig, isSigner: false, isWritable: false },
      { pubkey: FEE_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });

  const instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
    buyIx,
  ];

  return {
    instructions,
    tokenAmount: tokenOut,
    tokenPrice: tokenPriceInNative
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
 * Builds a PumpSwap buy instruction using the Pool model
 * @param {Connection} connection
 * @param {PublicKey} mint - The base token mint (the token being bought)
 * @param {PublicKey} userPubkey - The user's wallet address
 * @param {bigint} lamportsAmount - Token amount to buy (in lamports token smallest units)
 * @param {boolean} closeTokenAta - Whether to close the base token ATA after buying
 * @param {number} slippage - Slippage tolerance (e.g. 0.03 for 3%)
 * @param {PublicKey} creatorPublicKey - The coin creator's public key
 * @param {boolean} closeWsolAta - Whether to close the WSOL ATA after buying
 * @param {boolean} trackVolume - Whether to track trading volume (default: true)
 */
async function buildPumpSwapBuy(connection, mint, userPubkey, lamportsAmount, slippage = 0.03, creatorPublicKey, trackVolume = true) {
  const quoteMint = WSOL_MINT;
  const PUMP_SWAP_PROGRAM_ID = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
  const FEE_PROGRAM_ID = new PublicKey("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ");
  const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");  // Standard SPL Token for both base and quote in this pool
  const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

  // --- Pool derivation ---
  const pool = derivePumpSwapPoolPDA(mint, quoteMint, 0);
  //console.log("[BUY] Derived Pool:", pool.toBase58());

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
    console.log("[BUY] Creating user WSOL ATA:", userQuoteTokenAccount.toBase58());
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

  // --- Check and create userBaseTokenAccount if not initialized ---
  const userBaseAccountInfo = await connection.getAccountInfo(userBaseTokenAccount);
  if (!userBaseAccountInfo) {
    console.log("[BUY] Creating user base token ATA:", userBaseTokenAccount.toBase58());
    const createBaseAtaIx = createAssociatedTokenAccountInstruction(
      userPubkey, // payer
      userBaseTokenAccount, // ATA address
      userPubkey, // owner
      mint, // mint
      TOKEN_PROGRAM_ID, // base token uses standard SPL Token (fixed from logs)
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    instructions.push(createBaseAtaIx);
  }

  // --- Pool token accounts (off-curve) ---
  const poolBaseTokenAccount = await getAssociatedTokenAddress(mint, pool, true);
  const poolQuoteTokenAccount = await getAssociatedTokenAddress(quoteMint, pool, true);

  // --- Protocol fee recipient ---
  const protocolFeeRecipient = new PublicKey("62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV");
  const protocolFeeRecipientTokenAccount = await getAssociatedTokenAddress(quoteMint, protocolFeeRecipient, true);
  //console.log("[BUY] Protocol Fee TA:", protocolFeeRecipientTokenAccount.toBase58());  // Verify on Solscan

  // --- Coin creator vault ---
  const CREATOR_VAULT_SEED = Buffer.from("creator_vault");
  const [coinCreatorVaultAuthority] = PublicKey.findProgramAddressSync(
    [CREATOR_VAULT_SEED, creatorPublicKey.toBuffer()],
    PUMP_SWAP_PROGRAM_ID
  );
  const [coinCreatorVaultAta] = PublicKey.findProgramAddressSync(
    [
      coinCreatorVaultAuthority.toBuffer(),
      TOKEN_PROGRAM_ID.toBuffer(),
      quoteMint.toBuffer(),
    ],
    ASSOCIATED_TOKEN_PROGRAM_ID  // Fixed: Use ATA program for derivation (not Token-2022); matches standard token
  );
  //console.log("[BUY] Creator Vault Auth:", coinCreatorVaultAuthority.toBase58());
  //console.log("[BUY] Creator Vault ATA:", coinCreatorVaultAta.toBase58());  // Verify on Solscan

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

  // --- Volume accumulators ---
  const GLOBAL_VOLUME_SEED = Buffer.from("global_volume_accumulator");
  const [globalVolumeAccumulator] = PublicKey.findProgramAddressSync(
    [GLOBAL_VOLUME_SEED],
    PUMP_SWAP_PROGRAM_ID
  );
  const USER_VOLUME_SEED = Buffer.from("user_volume_accumulator");
  const [userVolumeAccumulator] = PublicKey.findProgramAddressSync(
    [USER_VOLUME_SEED, userPubkey.toBuffer()],
    PUMP_SWAP_PROGRAM_ID
  );

  const EVENT_AUTHORITY_SEED = Buffer.from("__event_authority");
  const [eventAuthority] = PublicKey.findProgramAddressSync([EVENT_AUTHORITY_SEED], PUMP_SWAP_PROGRAM_ID);

  // --- Fetch reserves & calculate ---
  const baseBalResp = await connection.getTokenAccountBalance(poolBaseTokenAccount);
  const quoteBalResp = await connection.getTokenAccountBalance(poolQuoteTokenAccount);
  const realTokenReserves = BigInt(baseBalResp.value.amount);
  const realSolReserves = BigInt(quoteBalResp.value.amount);
  //console.log("[BUY] Pool Reserves - Tokens:", realTokenReserves.toString(), "SOL:", realSolReserves.toString());
  if (realTokenReserves <= 0n || realSolReserves <= 0n) throw new Error("Invalid pool reserves");

  const feeBps = 30n;  // 0.3% - matches Pump.fun
  const tokenOut = BigInt(lamportsAmount);  // Desired token amount out (lamports) - user specifies tokens to buy
  if (realTokenReserves < tokenOut) throw new Error(`[BUY] Insufficient token reserves: need ${tokenOut}, have ${realTokenReserves}`);

  // --- Exact mirror of Pump.fun bonding curve buy formula, inverted for tokenOut specification ---
  // Pump.fun: solIn specified, tokenOut = virtualToken - k / (virtualSol + solIn)
  // Inverse: tokenOut specified, solIn = (k / (realToken - tokenOut)) - realSol  (real reserves = post-migration virtuals)
  // This ensures identical constant-product behavior, integer precision, and user experience
  const k = realTokenReserves * realSolReserves;
  const newTokenReservesAfterOut = realTokenReserves - tokenOut;
  if (newTokenReservesAfterOut <= 0n) throw new Error("[BUY] Cannot buy all reserves");

  // solIn before fee: ceiling div to match Pump.fun's conservative integer math (avoids underpay)
  let solIn = (k / newTokenReservesAfterOut) - realSolReserves;
  if (k % newTokenReservesAfterOut !== 0n) solIn += 1n;
  if (solIn < 0n) solIn = 0n;

  // Gross up for fee on input (0.3% fee deducted from input, so need more SOL to net solIn after fee)
  let solInWithFee = (solIn * 10000n) / (10000n - feeBps);
  if ((solIn * 10000n) % (10000n - feeBps) !== 0n) solInWithFee += 1n;
  if (solInWithFee < 0n) solInWithFee = 0n;

  // Slippage tolerance on max SOL input (mirrors Pump.fun's maxSolCost = solIn * (1 + slippage))
  const slippageBps = BigInt(Math.floor(slippage * 10000));
  let maxQuoteAmountIn = solInWithFee * (10000n + slippageBps) / 10000n;
  if (solInWithFee * (10000n + slippageBps) % 10000n !== 0n) maxQuoteAmountIn += 1n;

  // Optional min threshold (commented in your code; uncomment if needed for dust protection)
  // const minQuoteIn = 100000n;
  // if (maxQuoteAmountIn < minQuoteIn) throw new Error(`Calculated input too small (${maxQuoteAmountIn} lamports). Increase buy amount.`);

  // tokenPrice mirror: effective SOL cost per token received (with fee)
  // Assume TOKEN_DECIMALS = 6, SOL_DECIMALS = 9
  const TOKEN_DECIMALS = 6;
  const SOL_DECIMALS = 9;

  let tokenPrice = 0;
  let tokenPriceInNative = 0;

  if (tokenOut > 0n) {
    // SOL lamports per token lamport (full token)
    tokenPrice = Number(solInWithFee) / Number(tokenOut);

    // Adjust for decimals to get price per lamport in native SOL terms
    tokenPriceInNative = tokenPrice * 10 ** (TOKEN_DECIMALS - SOL_DECIMALS);
  }


  //console.log("[BUY] Expected token output:", tokenOut.toString(), "lamports");
  //console.log("[BUY] Estimated token price:", tokenPrice, "SOL per token lamport");
  //console.log("[BUY] solIn:", solIn.toString(), "solInWithFee:", solInWithFee.toString());
  //console.log("[BUY] Max SOL cost:", Number(maxQuoteAmountIn) / Number(LAMPORTS_PER_SOL), "SOL");

  // --- Wrap SOL to WSOL for the trade (fix insufficient funds) ---
  // User WSOL ATA created but empty; transfer from native SOL and sync
  const wrapAmount = maxQuoteAmountIn + 500000n;  // Buffer for fees/rent (~0.0005 SOL extra)
  const wrapIx = SystemProgram.transfer({
    fromPubkey: userPubkey,
    toPubkey: userQuoteTokenAccount,
    lamports: Number(wrapAmount),
  });
  const syncIx = createSyncNativeInstruction(userQuoteTokenAccount, TOKEN_PROGRAM_ID);
  instructions.push(wrapIx, syncIx);

  // --- Data for PumpSwap Buy ix ---
  const BUY_DISCRIMINATOR = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);
  const data = Buffer.alloc(25); // 8 disc + 8 base_out + 8 max_quote_in + 1 track_volume
  BUY_DISCRIMINATOR.copy(data, 0);
  data.writeBigUInt64LE(tokenOut, 8);  // base_amount_out = expected/min token out (program may enforce based on max in)
  data.writeBigUInt64LE(maxQuoteAmountIn, 16);  // max_quote_amount_in = max SOL willing to pay
  data.writeUInt8(trackVolume ? 1 : 0, 24); // OptionBool for volume tracking

  // --- Instruction ---
  const buyIx = new TransactionInstruction({
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
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },  // base_token_program (fixed to standard SPL)
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },  // quote_token_program (standard SPL)
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },  // system_program
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },  // associated_token_program
      { pubkey: eventAuthority, isSigner: false, isWritable: false },  // event_authority
      { pubkey: PUMP_SWAP_PROGRAM_ID, isSigner: false, isWritable: false },  // program
      { pubkey: coinCreatorVaultAta, isSigner: false, isWritable: true },  // coin_creator_vault_ata
      { pubkey: coinCreatorVaultAuthority, isSigner: false, isWritable: false },  // coin_creator_vault_authority
      { pubkey: globalVolumeAccumulator, isSigner: false, isWritable: true },  // global_volume_accumulator
      { pubkey: userVolumeAccumulator, isSigner: false, isWritable: true },  // user_volume_accumulator
      { pubkey: feeConfig, isSigner: false, isWritable: false },  // fee_config
      { pubkey: FEE_PROGRAM_ID, isSigner: false, isWritable: false }  // fee_program
    ],
    data
  });

  instructions.push(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 500_000 }), // Increased for ATA creation and volume tracking
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
    buyIx
  );

  return { 
    instructions, 
    tokenAmount: tokenOut, 
    tokenPrice: tokenPriceInNative };
  
}

module.exports = { buildPumpFunBuy, performBuy };
