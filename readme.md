# PumpFun-PumpSwap SDK

[![npm](https://img.shields.io/npm/v/@solana/web3.js?style=flat-square)](https://www.npmjs.com/package/@solana/web3.js) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

This is a Node.js SDK for building buy and sell transactions on [Pump.fun](https://pump.fun) (a Solana-based token launchpad). It automatically detects if the bonding curve is complete and switches to [PumpSwap](https://pumpswap.fun) for seamless trading. The SDK uses manual transaction instructions (no Anchor dependency) and supports slippage, retries, and optional token account closure.

Key features:
- **Auto-Switching**: Handles Pump.fun buys/sells and redirects to PumpSwap when the bonding curve is migrated.
- **Customizable**: Supports slippage tolerance, compute budget prioritization, and volume tracking.
- **Cache Integration**: Includes hooks for caching token amounts and prices (via `cacheManager.js` – implement your own or use as-is).
- **Test Scripts**: Ready-to-run examples for buying and selling.

**Note**: This SDK interacts with Solana programs. Always test on devnet or with small amounts. Trading involves risk; use at your own discretion.

## Installation

1. Clone the repository:
   ```
   git clone https://github.com/yourusername/pumpfun-pumpswap-sdk.git
   cd pumpfun-pumpswap-sdk
   ```

2. Install dependencies:
   ```
   npm install
   ```

   Required packages (these will be installed automatically via `package.json`, but you can install manually if needed):
   - `npm i dotenv` – For loading environment variables.
   - `npm i bs58` – For base58 encoding/decoding of private keys.
   - `npm i @solana/web3.js` – Core Solana web3 library for connections, transactions, and keys.
   - `npm i @solana/spl-token` – For handling SPL tokens, associated token accounts (ATAs), and instructions like `createAssociatedTokenAccountInstruction`.

   No other external dependencies are required. Built-in Node modules like `fs` and `path` are used for file handling.

## Setup

1. **Create a `.env` file**: Copy the provided `.env.example` and fill in your details.
   ```
   cp .env.example .env
   ```

   Example `.env` content:
   ```
   # Your Helius RPC endpoint (get one at https://www.helius.dev)
   HELIUS_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_API_KEY

   # Your wallet's private key (base58-encoded; NEVER commit this to Git!)
   PRIVATE_KEY=YourBase58PrivateKeyHere
   ```

   **Security Note**: Keep your `.env` file secure and add it to `.gitignore`. Never share your private key.

2. **IDLs Folder**: The `idls/` folder contains JSON IDLs for Pump.fun and PumpSwap programs (extracted from their official sources). These are for reference only – the SDK builds instructions manually without Anchor. You can use them for verification or if you extend the SDK.

   - `pumpfun.json`: IDL for the Pump.fun program (`6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`).
   - `pumpswap.json`: IDL for the PumpSwap program (`pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`).

   If you need to update them, fetch from Solana explorers like Solscan or the official repos.

3. **Cache Manager**: The SDK references `src/cacheManager/cacheManager.js` for tracking token balances and prices post-trade. Implement simple functions like `addTokenLamports`, `reduceTokenLamports`, `addSolLamports`, and `getAmountToSellFromCache`. If not needed, you can remove these calls or stub them.

## Usage

The core functions are in `src/buy.js` and `src/sell.js`. They return transaction instructions you can add to a `Transaction` and sign/send.

### Key Concepts
- **Pump.fun vs. PumpSwap**: The functions check the bonding curve status via `getBondingCurveReserves`. If complete (`bondingCurveIsComplete === true`), it switches to PumpSwap logic.
- **Slippage**: Default 3% (0.03). Adjust to tolerate price changes.
- **Compute Budget**: Instructions include priority fees (100,000 microLamports) and unit limits (300,000–500,000) for faster confirmation.
- **WSOL Handling**: For PumpSwap, SOL is wrapped to WSOL automatically.
- **Retries**: Built-in retries (2 for buys, 3 for sells) on failure.

### Buy Function: `buildPumpFunBuy`
Builds instructions to buy a token with SOL.

```javascript
const { buildPumpFunBuy } = require('./src/buy.js');

// Parameters:
// - connection: Solana Connection object
// - mint: PublicKey of the token mint
// - userKeypair: Keypair of the user's wallet
// - lamportsAmount: BigInt amount of SOL lamports to spend (e.g., 0.01 SOL = 10_000_000n)
// - slippage: Number (default 0.03)

// Returns: { instructions: TransactionInstruction[], tokenAmount: BigInt, tokenPrice: Number }
const { instructions, tokenAmount, tokenPrice } = await buildPumpFunBuy(
  connection,
  new PublicKey('TOKEN_MINT_HERE'),
  userKeypair,
  10000000n, // 0.01 SOL
  0.05 // 5% slippage
);

// Example: Send the transaction
const tx = new Transaction().add(...instructions);
const sig = await sendAndConfirmTransaction(connection, tx, [userKeypair]);
console.log(`Buy confirmed: https://solscan.io/tx/${sig}`);
```

There's also `performBuy` which wraps this with retries and cache updates.

### Sell Function: `buildPumpFunSell`
Builds instructions to sell tokens for SOL.

```javascript
const { buildPumpFunSell } = require('./src/sell.js');

// Parameters:
// - connection: Solana Connection object
// - mint: PublicKey of the token mint
// - userPubkey: PublicKey of the user's wallet
// - tokenLamports: BigInt amount of token lamports to sell
// - closeTokenAta: Boolean (true to close the ATA after sell; useful for 100% sells)
// - slippage: Number (default 0.03)

// Returns: { instructions: TransactionInstruction[], lamportsOut: BigInt }
const { instructions, lamportsOut } = await buildPumpFunSell(
  connection,
  new PublicKey('TOKEN_MINT_HERE'),
  userPubkey,
  1000000n, // Token amount in smallest units
  true, // Close ATA
  0.05 // 5% slippage
);

// Example: Send the transaction
const tx = new Transaction().add(...instructions);
const sig = await sendAndConfirmTransaction(connection, tx, [userKeypair]);
console.log(`Sell confirmed: https://solscan.io/tx/${sig}`);
```

There's also `performSell` which handles percentage-based sells (e.g., 50%), retries, and cache updates.

## Examples

Run test scripts after setup:
- Buy: `node src/instructions/testBuy.js` (buys 0.01 SOL worth of a hardcoded token).
- Sell: `node src/instructions/testSell.js` (sells all tokens from your ATA for a hardcoded mint).

Customize the mints and amounts in the scripts.

## Contributing

Fork the repo, make changes, and submit a PR. Ensure tests pass and add documentation for new features.

## License

MIT License. See [LICENSE](LICENSE) for details.

## Disclaimer

This SDK is for educational purposes. Solana trading can result in financial loss. The author is not responsible for any issues or losses.