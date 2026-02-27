// File: src/instructions/testBuy.js
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
    PublicKey, 
    Transaction, 
    sendAndConfirmTransaction, 
    LAMPORTS_PER_SOL ,
    Keypair
} = require("@solana/web3.js");
const { buildPumpFunBuy, buildPumpFunBuyExactSolIn } = require("../buy.js");
const PUMPFUN_PROGRAM_ID = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");

function isPumpOverflowError(err) {
  const msg = String(err?.message || "");
  const logs = Array.isArray(err?.transactionLogs) ? err.transactionLogs.join("\n") : "";
  return msg.includes("0x1788") || logs.includes("Error Code: Overflow");
}

function appendPumpBuyRemainingAccount(instructions, remainingAccountPubkey, isWritable = false) {
  if (!remainingAccountPubkey) return;
  const pumpIx = instructions.find((ix) => ix?.programId?.equals && ix.programId.equals(PUMPFUN_PROGRAM_ID));
  if (!pumpIx) return;
  const pubkey = new PublicKey(remainingAccountPubkey);
  const alreadyPresent = pumpIx.keys.some((k) => k.pubkey.equals(pubkey));
  if (alreadyPresent) return;
  pumpIx.keys.push({ pubkey, isSigner: false, isWritable });
  console.log(`[BUY TEST] Appended Pump buy remaining account: ${pubkey.toBase58()} writable=${isWritable}`);
}

function logPumpBuyIxDebug(instructions) {
  const pumpIx = instructions.find((ix) => ix?.programId?.equals && ix.programId.equals(PUMPFUN_PROGRAM_ID));
  if (!pumpIx) return;
  console.log(`[BUY TEST] Pump ix accounts=${pumpIx.keys.length} dataLen=${pumpIx.data.length}`);
}

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
        // --- Token to buy
        const mint = new PublicKey("3WaDEAD8oFehQUHLiap7R6WSgoMguoyKA3evtUgcpump");

        const solToBuy = 0.001; // Adjust based on decimals (1e6 = 1 token if 6 decimals)
        const lamportsToBuy = solToBuy * LAMPORTS_PER_SOL;
        const slippage = 0.03; //3%
        const buyMode = process.env.BUY_MODE || "buy";
        const trackVolume = (process.env.TRACK_VOLUME || "true").toLowerCase() !== "false";
        const allowExactSolFallback = (process.env.BUY_FALLBACK_EXACT_SOL_IN || "false").toLowerCase() === "true";
        const pumpfunBuyRemainingAccount = process.env.PUMPFUN_BUY_REMAINING_ACCOUNT;
        const pumpfunBuyRemainingAccountWritable =
          (process.env.PUMPFUN_BUY_REMAINING_ACCOUNT_WRITABLE || "false").toLowerCase() === "true";
     
        try {
          const exactSolBuilder = buildPumpFunBuyExactSolIn
            ? (connection, mint, wallet, lamportsToBuy, slippage, trackVolume) =>
                buildPumpFunBuyExactSolIn(connection, mint, wallet, lamportsToBuy, slippage, trackVolume)
            : (connection, mint, wallet, lamportsToBuy, slippage, trackVolume) =>
                buildPumpFunBuy(connection, mint, wallet, lamportsToBuy, slippage, "buy_exact_sol_in", trackVolume);

          const legacyBuyBuilder = (connection, mint, wallet, lamportsToBuy, slippage, trackVolume) =>
            buildPumpFunBuy(connection, mint, wallet, lamportsToBuy, slippage, "buy", trackVolume);

          const builder = buyMode === "buy_exact_sol_in" ? exactSolBuilder : legacyBuyBuilder;
          console.log(`Using buy mode: ${buyMode}`);
          console.log(`Track volume: ${trackVolume}`);
          console.log(`Allow exact-sol fallback: ${allowExactSolFallback}`);
          if (pumpfunBuyRemainingAccount) {
            console.log(`Pump buy extra remaining account: ${pumpfunBuyRemainingAccount}`);
            console.log(`Pump buy extra remaining account writable: ${pumpfunBuyRemainingAccountWritable}`);
          }
          const { instructions } = await builder(connection, mint, wallet, lamportsToBuy, slippage, trackVolume);
          appendPumpBuyRemainingAccount(
            instructions,
            pumpfunBuyRemainingAccount,
            pumpfunBuyRemainingAccountWritable
          );
          logPumpBuyIxDebug(instructions);

          const tx = new Transaction().add(...instructions);

          // --- Send and confirm transaction
          try {
              console.log("Sending transaction...");
              const sig = await sendAndConfirmTransaction(connection, tx, [wallet]);
              console.log(`Buy confirmed: https://solscan.io/tx/${sig}`);
          } catch (err) {
              if (buyMode === "buy" && allowExactSolFallback && isPumpOverflowError(err)) {
                console.log("[BUY TEST] Legacy buy overflowed, retrying with buy_exact_sol_in...");
                const { instructions: retryInstructions } = await exactSolBuilder(
                  connection,
                  mint,
                  wallet,
                  lamportsToBuy,
                  slippage,
                  false
                );
                appendPumpBuyRemainingAccount(
                  retryInstructions,
                  pumpfunBuyRemainingAccount,
                  pumpfunBuyRemainingAccountWritable
                );
                logPumpBuyIxDebug(retryInstructions);
                const retryTx = new Transaction().add(...retryInstructions);
                const retrySig = await sendAndConfirmTransaction(connection, retryTx, [wallet]);
                console.log(`Buy confirmed (buy_exact_sol_in fallback): https://solscan.io/tx/${retrySig}`);
              } else {
                console.error("Error sending buy transaction:", err);
              }
          }
        } catch (err) {
          console.error("Error running testBuy:", err);
        }   
    } catch (err) {
        console.error("Error running testBuy:", err);
    }
})();
