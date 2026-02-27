const {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  Transaction,
  sendAndConfirmTransaction,
} = require("@solana/web3.js");
const {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountIdempotentInstruction,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} = require("@solana/spl-token");

const PUMPFUN_PROGRAM_ID = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const PUMP_SWAP_PROGRAM_ID = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const CLAIM_CASHBACK_DISCRIMINATOR = Buffer.from([37, 58, 35, 126, 190, 53, 228, 197]);

function deriveUserVolumeAccumulatorPda(programId, userPubkey) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("user_volume_accumulator"), userPubkey.toBuffer()],
    programId
  );
  return pda;
}

function deriveEventAuthorityPda(programId) {
  const [eventAuthority] = PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], programId);
  return eventAuthority;
}

function buildPumpFunClaimCashback(userPubkey) {
  const userVolumeAccumulator = deriveUserVolumeAccumulatorPda(PUMPFUN_PROGRAM_ID, userPubkey);
  const eventAuthority = deriveEventAuthorityPda(PUMPFUN_PROGRAM_ID);

  const claimIx = new TransactionInstruction({
    programId: PUMPFUN_PROGRAM_ID,
    keys: [
      { pubkey: userPubkey, isSigner: true, isWritable: true },
      { pubkey: userVolumeAccumulator, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: eventAuthority, isSigner: false, isWritable: false },
      { pubkey: PUMPFUN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: CLAIM_CASHBACK_DISCRIMINATOR,
  });

  return { instructions: [claimIx], userVolumeAccumulator };
}

async function buildPumpSwapClaimCashback(
  connection,
  userPubkey,
  quoteMint = WSOL_MINT,
  quoteTokenProgramId = TOKEN_PROGRAM_ID,
  createUserQuoteAta = true,
  createAccumulatorQuoteAta = true
) {
  const userVolumeAccumulator = deriveUserVolumeAccumulatorPda(PUMP_SWAP_PROGRAM_ID, userPubkey);
  const userVolumeAccumulatorQuoteAta = await getAssociatedTokenAddress(
    quoteMint,
    userVolumeAccumulator,
    true,
    quoteTokenProgramId,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  const userQuoteAta = await getAssociatedTokenAddress(
    quoteMint,
    userPubkey,
    false,
    quoteTokenProgramId,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const eventAuthority = deriveEventAuthorityPda(PUMP_SWAP_PROGRAM_ID);

  const instructions = [];

  if (createUserQuoteAta) {
    instructions.push(
      createAssociatedTokenAccountIdempotentInstruction(
        userPubkey,
        userQuoteAta,
        userPubkey,
        quoteMint,
        quoteTokenProgramId,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );
  }
  if (createAccumulatorQuoteAta) {
    instructions.push(
      createAssociatedTokenAccountIdempotentInstruction(
        userPubkey,
        userVolumeAccumulatorQuoteAta,
        userVolumeAccumulator,
        quoteMint,
        quoteTokenProgramId,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );
  }

  const claimIx = new TransactionInstruction({
    programId: PUMP_SWAP_PROGRAM_ID,
    keys: [
      { pubkey: userPubkey, isSigner: true, isWritable: true },
      { pubkey: userVolumeAccumulator, isSigner: false, isWritable: true },
      { pubkey: quoteMint, isSigner: false, isWritable: false },
      { pubkey: quoteTokenProgramId, isSigner: false, isWritable: false },
      { pubkey: userVolumeAccumulatorQuoteAta, isSigner: false, isWritable: true },
      { pubkey: userQuoteAta, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: eventAuthority, isSigner: false, isWritable: false },
      { pubkey: PUMP_SWAP_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: CLAIM_CASHBACK_DISCRIMINATOR,
  });

  instructions.push(claimIx);

  return {
    instructions,
    userVolumeAccumulator,
    userVolumeAccumulatorQuoteAta,
    userQuoteAta,
  };
}

async function performPumpFunClaimCashback(connection, userKeypair) {
  const { instructions } = buildPumpFunClaimCashback(userKeypair.publicKey);
  const tx = new Transaction().add(...instructions);
  return sendAndConfirmTransaction(connection, tx, [userKeypair], { commitment: "confirmed" });
}

async function performPumpSwapClaimCashback(connection, userKeypair, quoteMint = WSOL_MINT, quoteTokenProgramId = TOKEN_PROGRAM_ID) {
  const { instructions } = await buildPumpSwapClaimCashback(
    connection,
    userKeypair.publicKey,
    quoteMint,
    quoteTokenProgramId,
    true,
    true
  );
  const tx = new Transaction().add(...instructions);
  return sendAndConfirmTransaction(connection, tx, [userKeypair], { commitment: "confirmed" });
}

module.exports = {
  buildPumpFunClaimCashback,
  buildPumpSwapClaimCashback,
  performPumpFunClaimCashback,
  performPumpSwapClaimCashback,
};
