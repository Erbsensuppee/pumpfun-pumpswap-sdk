// diagnose_fee.js - run once to inspect feeConfig account bytes
// npm run test:diagnose:fee

const path = require("path");
const dotenv = require("dotenv");
dotenv.config({ path: path.resolve(__dirname, "../../.env") });
dotenv.config({ path: path.join(__dirname, ".env") });

const { Connection, PublicKey } = require('@solana/web3.js');

const RPC_URL    = process.env.HELIUS_URL || process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const FEE_PROGRAM_ID     = new PublicKey("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ");

const FEE_SEED_CONST = new Uint8Array([
  1, 86, 224, 246, 147, 102, 90, 207, 68, 219,
  21, 104, 191, 23, 91, 170, 81, 137, 203, 151,
  245, 210, 255, 59, 101, 93, 43, 182, 253, 109, 24, 176,
]);

async function main() {
  const connection = new Connection(RPC_URL, 'confirmed');

  const [feeConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from("fee_config"), FEE_SEED_CONST],
    FEE_PROGRAM_ID
  );

  console.log("feeConfig PDA:", feeConfig.toBase58());
  const info = await connection.getAccountInfo(feeConfig);
  if (!info) { console.error("feeConfig account not found"); return; }

  const d = info.data;
  console.log("feeConfig data length:", d.length, "bytes");
  console.log("feeConfig owner:", info.owner.toBase58());
  console.log();

  // Print all bytes as hex
  console.log("Raw hex:");
  console.log(d.toString('hex'));
  console.log();

  // Try to find the values 95 and 30 by scanning all u64 offsets
  // We know GetFees returns: lp=0, protocol=95, creator=30
  console.log("Scanning for u64 values:");
  for (let i = 0; i <= d.length - 8; i += 1) {
    const val = d.readBigUInt64LE(i);
    if (val === 95n || val === 30n || val === 0n) {
      process.stdout.write(`  offset ${i}: ${val.toString()}`);
      if (val === 95n) process.stdout.write("  ← PROTOCOL FEE?");
      if (val === 30n) process.stdout.write("  ← CREATOR FEE?");
      if (val === 0n && i > 0) process.stdout.write("  ← LP FEE?");
      process.stdout.write("\n");
    }
  }

  console.log();
  console.log("All u64 values at 8-byte aligned offsets:");
  for (let i = 0; i <= d.length - 8; i += 8) {
    const val = d.readBigUInt64LE(i);
    console.log(`  offset ${i}: ${val.toString()}`);
  }
}

main().catch(console.error);
