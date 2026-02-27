const fs = require("fs");
const path = require("path");
const { Connection, Keypair, clusterApiUrl, PublicKey } = require("@solana/web3.js");

let anchor;
try {
  anchor = require("@coral-xyz/anchor");
} catch (_) {
  anchor = require("@project-serum/anchor");
}

const { AnchorProvider, Program, Wallet } = anchor;

const PROGRAM_ADDRESS =
  process.env.PROGRAM_ADDRESS || "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const NETWORK = process.env.SOLANA_NETWORK || "mainnet-beta";
const RPC_URL = process.env.HELIUS_URL || clusterApiUrl(NETWORK);
const OUTPUT_PATH =
  process.env.IDL_PATH ||
  path.resolve(__dirname, `../idls/pumpFun/${PROGRAM_ADDRESS}_idl.json`);

function buildProvider() {
  const connection = new Connection(RPC_URL, "confirmed");
  const wallet = new Wallet(Keypair.generate());
  return new AnchorProvider(connection, wallet, AnchorProvider.defaultOptions());
}

async function fetchAndSaveIdl(provider) {
  try {
    const programId = new PublicKey(PROGRAM_ADDRESS);
    const idl = await Program.fetchIdl(programId, provider);

    if (!idl) {
      console.error("IDL not found for program", PROGRAM_ADDRESS);
      return null;
    }

    fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(idl, null, 2), "utf8");
    console.log(`IDL saved to ${OUTPUT_PATH}`);
    return idl;
  } catch (err) {
    console.error("Error fetching IDL:", err);
    return null;
  }
}

async function main() {
  const provider = buildProvider();

  console.log("Program:", PROGRAM_ADDRESS);
  console.log("RPC:", RPC_URL);

  const idl = fs.existsSync(OUTPUT_PATH)
    ? JSON.parse(fs.readFileSync(OUTPUT_PATH, "utf8"))
    : await fetchAndSaveIdl(provider);

  if (!idl) return;

  const program = new Program(idl, new PublicKey(PROGRAM_ADDRESS), provider);
  console.log("IDL loaded. Program name:", idl.name || "(unknown)");
  console.log("Instructions:", Array.isArray(idl.instructions) ? idl.instructions.length : 0);
  console.log("Program ID:", program.programId.toBase58());
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

