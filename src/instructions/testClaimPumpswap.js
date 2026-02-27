const path = require('path');
const dotenv = require('dotenv');
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config({ path: path.join(__dirname, '.env') });

const bs58 = require('bs58');
const bs58Decode = bs58.decode || (bs58.default && bs58.default.decode);
const { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } = require('@solana/web3.js');
const { TOKEN_PROGRAM_ID } = require('@solana/spl-token');
const { buildPumpSwapClaimCashback } = require('../claimCashback.js');

(async () => {
  try {
    const heliusUrl = process.env.HELIUS_URL;
    const privateKeyBase58 = process.env.PRIVATE_KEY;

    if (!heliusUrl || !privateKeyBase58) {
      throw new Error('Missing HELIUS_URL or PRIVATE_KEY in .env file');
    }

    const connection = new Connection(heliusUrl, 'confirmed');
    if (!bs58Decode) throw new Error('bs58.decode not available; check bs58 version/import');
    const wallet = Keypair.fromSecretKey(bs58Decode(privateKeyBase58));

    const quoteMint = new PublicKey(
      process.env.CLAIM_PUMPSWAP_QUOTE_MINT || 'So11111111111111111111111111111111111111112'
    );
    const quoteTokenProgram = new PublicKey(
      process.env.CLAIM_PUMPSWAP_QUOTE_TOKEN_PROGRAM || TOKEN_PROGRAM_ID.toBase58()
    );

    console.log(`Wallet: ${wallet.publicKey.toBase58()}`);
    console.log(`Quote mint: ${quoteMint.toBase58()}`);
    console.log(`Quote token program: ${quoteTokenProgram.toBase58()}`);

    const { instructions, userVolumeAccumulator, userVolumeAccumulatorQuoteAta, userQuoteAta } =
      await buildPumpSwapClaimCashback(
        connection,
        wallet.publicKey,
        quoteMint,
        quoteTokenProgram,
        true
      );

    console.log(`PumpSwap UserVolumeAccumulator: ${userVolumeAccumulator.toBase58()}`);
    console.log(`Accumulator quote ATA: ${userVolumeAccumulatorQuoteAta.toBase58()}`);
    console.log(`User quote ATA: ${userQuoteAta.toBase58()}`);

    const tx = new Transaction().add(...instructions);

    console.log('Sending PumpSwap claim_cashback transaction...');
    const sig = await sendAndConfirmTransaction(connection, tx, [wallet]);
    console.log(`Claim confirmed: https://solscan.io/tx/${sig}`);
  } catch (err) {
    console.error('Error running testClaimPumpswap:', err);
  }
})();
