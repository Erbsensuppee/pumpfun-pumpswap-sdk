const path = require('path');
const dotenv = require('dotenv');
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config({ path: path.join(__dirname, '.env') });

const bs58 = require('bs58');
const bs58Decode = bs58.decode || (bs58.default && bs58.default.decode);
const { Connection, Keypair, Transaction, sendAndConfirmTransaction } = require('@solana/web3.js');
const { buildPumpFunClaimCashback } = require('../claimCashback.js');

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

    console.log(`Wallet: ${wallet.publicKey.toBase58()}`);

    const { instructions, userVolumeAccumulator } = buildPumpFunClaimCashback(wallet.publicKey);
    console.log(`Pump UserVolumeAccumulator: ${userVolumeAccumulator.toBase58()}`);

    const tx = new Transaction().add(...instructions);

    console.log('Sending Pump.fun claim_cashback transaction...');
    const sig = await sendAndConfirmTransaction(connection, tx, [wallet]);
    console.log(`Claim confirmed: https://solscan.io/tx/${sig}`);
  } catch (err) {
    console.error('Error running testClaimPumpfun:', err);
  }
})();
