const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
// Prefer repo root .env, fallback to local instructions/.env if present
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config({ path: path.join(__dirname, '.env') });

const bs58 = require("bs58");
const bs58Decode = bs58.decode || (bs58.default && bs58.default.decode);
const {
  Connection,
  Transaction,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
} = require("@solana/web3.js");
const { 
    getAssociatedTokenAddress, 
    TOKEN_2022_PROGRAM_ID,
} = require("@solana/spl-token");

// Your custom sell function (must export buildSellTransaction)
const { buildPumpFunSell } = require("../sell.js");

dotenv.config();

(async () => {
  try {
    // --- Load env values
    const heliusUrl = process.env.HELIUS_URL;
    const privateKeyBase58 = process.env.PRIVATE_KEY;

    if (!heliusUrl || !privateKeyBase58) {
      throw new Error("Missing HELIUS_URL or PRIVATE_KEY in .env file");
    }

    // --- Setup connection and wallet
    const connection = new Connection(heliusUrl, "confirmed");
    if (!bs58Decode) {
      throw new Error("bs58.decode not available; check bs58 version/import");
    }
    const wallet = Keypair.fromSecretKey(bs58Decode(privateKeyBase58));
    console.log(`Wallet: ${wallet.publicKey.toBase58()}`);

    // --- Token + amount setup
    const tokenMint = new PublicKey("BxPkRK7ZZZsm4r6TCdBf2W4j85BktAzL8GD4oKfypump"); // replace this
    const mintInfo = await connection.getAccountInfo(tokenMint, "confirmed");
    if (!mintInfo?.owner) {
      throw new Error(`Mint account not found: ${tokenMint.toBase58()}`);
    }
    const tokenProgramId = mintInfo.owner;
    const isToken2022 = tokenProgramId.equals(TOKEN_2022_PROGRAM_ID);
    console.log(`Token program: ${tokenProgramId.toBase58()}${isToken2022 ? " (Token-2022)" : ""}`);

    // Find your associated token account (ATA), respecting token program
    const userTokenATA = await getAssociatedTokenAddress(
      tokenMint,
      wallet.publicKey,
      false,
      tokenProgramId,
    );

    const parsedInfo = await connection.getParsedAccountInfo(userTokenATA, "confirmed");

    const tokenLamportsToSell = BigInt(parsedInfo.value?.data?.parsed?.info?.tokenAmount?.amount || 0);

    console.log(
      `Preparing to sell ${tokenLamportsToSell} lamports of ${tokenMint.toBase58()}`
    );
    if (tokenLamportsToSell <= 0n) {
      console.log("No token balance to sell. Aborting without sending transaction.");
      return;
    }
    const closeTokenAta = true;
    // --- Build the sell transaction

    const { instructions } = await buildPumpFunSell(
        connection,           // Connection
        tokenMint,            // PublicKey
        wallet.publicKey,     // user's public key
        tokenLamportsToSell,   // amount to sell as bigint
        closeTokenAta        // Close Token Ata true or false
    );

    // --- Wrap instructions in a Transaction
    const tx = new Transaction().add(...instructions);

    // --- Send and confirm transaction
    try {
        console.log("Sending transaction...");
        const sig = await sendAndConfirmTransaction(connection, tx, [wallet]);
        console.log(`Sell confirmed: https://solscan.io/tx/${sig}`);
    } catch (err) {
        console.error("Error sending sell transaction:", err);
    }

  } catch (err) {
    console.error("Error running testSell:", err);
  }
})();
