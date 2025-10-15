const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
dotenv.config({ path: __dirname + '/.env' });

const bs58 = require("bs58");
const {
  Connection,
  Transaction,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
} = require("@solana/web3.js");
const { 
    getAssociatedTokenAddress, 
    getAccount 
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
    const wallet = Keypair.fromSecretKey(bs58.decode(privateKeyBase58));
    console.log(`Wallet: ${wallet.publicKey.toBase58()}`);

    // --- Token + amount setup
    const tokenMint = new PublicKey("BZm5a6GoqGAhEYgSAPjHhPmu8Z38ijnfp1XCBSMNpump"); // replace this
    // Find your associated token account (ATA)
    const userTokenATA = await getAssociatedTokenAddress(tokenMint, wallet.publicKey);

    const parsedInfo = await connection.getParsedAccountInfo(userTokenATA, "confirmed");

    const tokenLamportsToSell = BigInt(parsedInfo.value?.data?.parsed?.info?.tokenAmount?.amount || 0);

    // Get the token account info
    

    console.log(
      `Preparing to sell ${tokenLamportsToSell} lamports of ${tokenMint.toBase58()}`
    );
    const closeTokenAta = true;
    // --- Build the sell transaction

    const sellTxInstruction = await buildPumpFunSell(
        connection,           // Connection
        tokenMint,            // PublicKey
        wallet.publicKey,     // user's public key
        tokenLamportsToSell,   // amount to sell as bigint
        closeTokenAta        // Close Token Ata true or false
    );

    // --- Wrap instructions in a Transaction
    const tx = new Transaction().add(...sellTxInstruction);

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
