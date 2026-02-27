// diagnose.js - run this to identify buy overflow root causes
// npm run test:diagnose

const path = require("path");
const dotenv = require("dotenv");
dotenv.config({ path: path.resolve(__dirname, "../../.env") });
dotenv.config({ path: path.join(__dirname, ".env") });

const { Connection, PublicKey, LAMPORTS_PER_SOL } = require("@solana/web3.js");
const {
  getMint,
  TOKEN_2022_PROGRAM_ID,
  getTransferFeeConfig,
} = require("@solana/spl-token");

const RPC_URL = process.env.HELIUS_URL || "https://api.mainnet-beta.solana.com";
const MINT_ADDRESS = process.env.DIAGNOSE_MINT || process.env.TEST_MINT || "3WaDEAD8oFehQUHLiap7R6WSgoMguoyKA3evtUgcpump";
const WALLET_ADDRESS = process.env.DIAGNOSE_WALLET || process.env.TEST_WALLET || "5Q7an5dLhbs7SZwt8eJrPbRdqopUkPVTei4u3TyGM9pE";

const PUMPFUN_PROGRAM_ID = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");

async function diagnose() {
  const connection = new Connection(RPC_URL, "confirmed");
  const mint = new PublicKey(MINT_ADDRESS);
  const wallet = new PublicKey(WALLET_ADDRESS);

  console.log("=== CONFIG ===");
  console.log("RPC:", RPC_URL);
  console.log("Mint:", mint.toBase58());
  console.log("Wallet:", wallet.toBase58());

  console.log("\n=== WALLET ===");
  const walletBal = await connection.getBalance(wallet);
  console.log("Balance:", walletBal, "lamports =", walletBal / LAMPORTS_PER_SOL, "SOL");
  console.log("Has enough for 0.001 SOL trade + rent (~6500 lamps)?", walletBal > 1_010_000);

  console.log("\n=== MINT ===");
  const mintInfo = await connection.getAccountInfo(mint);
  if (!mintInfo) {
    console.log("Mint account not found");
    return;
  }
  const tokenProgram = mintInfo.owner.toBase58();
  console.log("Token program:", tokenProgram);
  console.log("Is Token-2022?", tokenProgram === TOKEN_2022_PROGRAM_ID.toBase58());

  if (tokenProgram === TOKEN_2022_PROGRAM_ID.toBase58()) {
    const decoded = await getMint(connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
    const transferFeeConfig = getTransferFeeConfig(decoded);
    if (transferFeeConfig) {
      console.log("TransferFee extension detected:");
      console.log("  newer feeBps:", transferFeeConfig.newerTransferFee.transferFeeBasisPoints);
      console.log("  newer maxFee:", transferFeeConfig.newerTransferFee.maximumFee.toString());
      console.log("  older feeBps:", transferFeeConfig.olderTransferFee.transferFeeBasisPoints);
      console.log("  older maxFee:", transferFeeConfig.olderTransferFee.maximumFee.toString());
    } else {
      console.log("No TransferFee extension");
    }
  }

  console.log("\n=== BONDING CURVE ===");
  const [bondingCurve] = PublicKey.findProgramAddressSync(
    [Buffer.from("bonding-curve"), mint.toBuffer()],
    PUMPFUN_PROGRAM_ID
  );
  console.log("Bonding curve PDA:", bondingCurve.toBase58());
  const bcInfo = await connection.getAccountInfo(bondingCurve);
  if (!bcInfo) {
    console.log("Bonding curve not found");
    return;
  }
  const d = bcInfo.data;
  const vT = d.readBigUInt64LE(8);
  const vS = d.readBigUInt64LE(16);
  const rT = d.readBigUInt64LE(24);
  const rS = d.readBigUInt64LE(32);
  const complete = d[48];
  const creator = new PublicKey(d.slice(49, 81));
  const isMayhemMode = d[81];
  const isCashbackCoin = d[82];
  console.log("virtual_token_reserves:", vT.toString());
  console.log("virtual_sol_reserves:", vS.toString());
  console.log("real_token_reserves:", rT.toString());
  console.log("real_sol_reserves:", rS.toString());
  console.log("complete:", complete);
  console.log("creator:", creator.toBase58());
  console.log("is_mayhem_mode (offset 81):", isMayhemMode, isMayhemMode ? "MAYHEM MODE" : "");
  console.log("is_cashback_coin (offset 82):", isCashbackCoin, isCashbackCoin ? "CASHBACK COIN" : "");
  console.log("raw bytes [79-85]:", Buffer.from(d.slice(79, 86)).toString("hex"));

  console.log("\n=== PDAs (existence check) ===");
  const [userVolumeAccumulator] = PublicKey.findProgramAddressSync(
    [Buffer.from("user_volume_accumulator"), wallet.toBuffer()],
    PUMPFUN_PROGRAM_ID
  );
  const [creatorVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("creator-vault"), creator.toBuffer()],
    PUMPFUN_PROGRAM_ID
  );
  const uvaInfo = await connection.getAccountInfo(userVolumeAccumulator);
  const cvInfo = await connection.getAccountInfo(creatorVault);
  console.log("userVolumeAccumulator:", userVolumeAccumulator.toBase58());
  console.log("  exists?", !!uvaInfo, uvaInfo ? `(${uvaInfo.lamports} lamports)` : "needs rent");
  console.log("creatorVault:", creatorVault.toBase58());
  console.log("  exists?", !!cvInfo, cvInfo ? `(${cvInfo.lamports} lamports)` : "needs rent");

  console.log("\n=== GLOBAL ACCOUNT FEE BPS ===");
  const [global] = PublicKey.findProgramAddressSync([Buffer.from("global")], PUMPFUN_PROGRAM_ID);
  const gInfo = await connection.getAccountInfo(global);
  if (gInfo) {
    const gd = gInfo.data;
    const feeBps = gd.readBigUInt64LE(105);
    const cFeeBps = gd.readBigUInt64LE(154);
    console.log("fee_basis_points (offset 105):", feeBps.toString());
    console.log("creator_fee_basis_points (offset 154):", cFeeBps.toString());
    console.log("total feeBps:", (feeBps + cFeeBps).toString());
    console.log("(fee program often returns protocol=95, creator=30 => 125 bps)");
  } else {
    console.log("Global account not found");
  }

  console.log("\n=== QUOTE SIMULATION ===");
  const solIn = 1_000_000n;
  const totalFeeBps = 125n;
  const netSol = (solIn * 10000n) / (10000n + totalFeeBps);
  const effectiveNetSol = netSol > 0n ? netSol - 1n : 0n;
  const tokensOut = effectiveNetSol > 0n ? (effectiveNetSol * vT) / (vS + effectiveNetSol) : 0n;
  console.log("spendable_sol_in:", solIn.toString());
  console.log("net_sol:", netSol.toString());
  console.log("tokens_out (quoted):", tokensOut.toString());
  console.log("min_tokens_out (10% slip):", ((tokensOut * 9000n) / 10000n).toString());

  if (isCashbackCoin) {
    console.log("\nCASHBACK COIN DETECTED");
    console.log("If volume/cashback accounting over-allocates, checked math may overflow.");
    console.log("Try TRACK_VOLUME=false while debugging.");
  }
}

diagnose().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
