// File: src/instructions/testBuy.js
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
dotenv.config({ path: __dirname + '/.env' });

const bs58 = require("bs58");
const { 
    Connection, 
    PublicKey, 
    Transaction, 
    sendAndConfirmTransaction, 
    LAMPORTS_PER_SOL ,
    Keypair
} = require("@solana/web3.js");
const { buildPumpFunBuy } = require("../buy.js");

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
        // --- Token to buy
        const mint = new PublicKey("BZm5a6GoqGAhEYgSAPjHhPmu8Z38ijnfp1XCBSMNpump");

        const solToBuy = 0.01; // Adjust based on decimals (1e6 = 1 token if 6 decimals)
        const lamportsToBuy = solToBuy * LAMPORTS_PER_SOL;
        const slippage = 0.03; //3%
     
        try {
          const instructions = await buildPumpFunBuy(connection, mint, wallet, lamportsToBuy, slippage);
      
          const tx = new Transaction().add(...instructions);
      
          // --- Send and confirm transaction
          try {
              console.log("Sending transaction...");
              const sig = await sendAndConfirmTransaction(connection, tx, [wallet]);
              console.log(`Buy confirmed: https://solscan.io/tx/${sig}`);
          } catch (err) {
              console.error("Error sending sell transaction:", err);
          }
        } catch (err) {
          console.error("Error running testBuy:", err);
        }   
    } catch (err) {
        console.error("Error running testBuy:", err);
    }
})();
