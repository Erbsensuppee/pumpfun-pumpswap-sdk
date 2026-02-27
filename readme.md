# PumpFun-PumpSwap SDK

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

This is a Node.js SDK for building buy, sell, and cashback-claim transactions on [Pump.fun](https://pump.fun) and [PumpSwap](https://pumpswap.fun) (Solana). It automatically detects whether a mint is still on the bonding curve and switches to PumpSwap when migrated. The SDK uses manual transaction instructions (no Anchor runtime dependency) and supports slippage, retries, Token-2022 mints, and cashback account flows.

Key features:
- **Auto-Switching**: Handles Pump.fun buys/sells and redirects to PumpSwap when the bonding curve is complete.
- **Cashback Support**: Supports `claim_cashback` for Pump.fun and PumpSwap.
- **Token-2022 Aware**: Correct ATA derivation and instruction account handling for Token-2022 mints.
- **V2 Account Layout Support**: Optional trailing `bonding_curve_v2` / `pool_v2` accounts for upgraded program layouts.
- **Test Scripts**: Ready-to-run scripts for buy, sell, and cashback claims.

**Note**: This SDK interacts with mainnet Solana programs. Always test with small amounts first.

## Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/Erbsensuppee/pumpfun-pumpswap-sdk.git
   cd pumpfun-pumpswap-sdk
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

## Setup

1. **Create a `.env` file** and set at least:
   ```env
   HELIUS_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_API_KEY
   PRIVATE_KEY=YourBase58PrivateKeyHere
   ```

2. **Optional env variables**:
   ```env
   BUY_MODE=buy
   TRACK_VOLUME=true
   BUY_FALLBACK_EXACT_SOL_IN=false

   # Program layout compatibility
   # true  -> always include v2 trailing accounts (recommended/default)
   # false -> never include v2 trailing accounts
   PUMP_INCLUDE_V2_ACCOUNTS=true

   # PumpSwap claim config (defaults shown)
   CLAIM_PUMPSWAP_QUOTE_MINT=So11111111111111111111111111111111111111112
   CLAIM_PUMPSWAP_QUOTE_TOKEN_PROGRAM=TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA
   ```

3. **IDLs Folder**

   The `idls/` folder contains Pump.fun and PumpSwap IDLs for reference and verification.

4. **Cache Manager**

   `src/cacheManager/cacheManager.js` is used by `performBuy`/`performSell` helper flows. You can customize or stub it if not needed.

## Usage

Core files:
- `src/buy.js`
- `src/sell.js`
- `src/claimCashback.js`

### Key Concepts
- **Pump.fun vs PumpSwap**: Bonding curve state decides route automatically.
- **Slippage**: Defaults to `0.03` (3%).
- **Token Program Awareness**: Mint owner is used to derive base token ATAs correctly (Token vs Token-2022).
- **Cashback Remaining Accounts**: Added conditionally based on `is_cashback_coin`.
- **V2 Trailing Accounts**: Included by default (`PUMP_INCLUDE_V2_ACCOUNTS=true`).

### Buy Function: `buildPumpFunBuy`

Builds instructions to buy with SOL.

```javascript
const { buildPumpFunBuy } = require('./src/buy.js');

const { instructions, tokenAmount, tokenPrice } = await buildPumpFunBuy(
  connection,
  mint,
  userKeypair,
  1_000_000n, // 0.001 SOL
  0.03,
  'buy_exact_sol_in',
  true // trackVolume
);

const tx = new Transaction().add(...instructions);
const sig = await sendAndConfirmTransaction(connection, tx, [userKeypair]);
console.log(`Buy confirmed: https://solscan.io/tx/${sig}`);
```

Also available:
- `buildPumpFunBuyExactSolIn(...)`
- `performBuy(...)` (with retries + cache updates)

### Sell Function: `buildPumpFunSell`

Builds instructions to sell token units for SOL.

```javascript
const { buildPumpFunSell } = require('./src/sell.js');

const { instructions, lamportsOut } = await buildPumpFunSell(
  connection,
  mint,
  userPubkey,
  tokenLamports,
  true,  // close token ATA after sell
  0.03
);

const tx = new Transaction().add(...instructions);
const sig = await sendAndConfirmTransaction(connection, tx, [userKeypair]);
console.log(`Sell confirmed: https://solscan.io/tx/${sig}`);
```

Also available:
- `performSell(...)` (percentage-based + retries + cache updates)

### Claim Cashback: Pump.fun

Claims native SOL cashback from Pump `user_volume_accumulator`.

```javascript
const { buildPumpFunClaimCashback } = require('./src/claimCashback.js');

const { instructions } = buildPumpFunClaimCashback(userKeypair.publicKey);
const tx = new Transaction().add(...instructions);
const sig = await sendAndConfirmTransaction(connection, tx, [userKeypair]);
console.log(`Claim confirmed: https://solscan.io/tx/${sig}`);
```

### Claim Cashback: PumpSwap

Claims WSOL cashback from PumpSwap accumulator WSOL ATA to user WSOL ATA.

```javascript
const { buildPumpSwapClaimCashback } = require('./src/claimCashback.js');
const { TOKEN_PROGRAM_ID } = require('@solana/spl-token');

const { instructions } = await buildPumpSwapClaimCashback(
  connection,
  userKeypair.publicKey,
  new PublicKey('So11111111111111111111111111111111111111112'),
  TOKEN_PROGRAM_ID,
  true, // create user WSOL ATA idempotently
  true  // create accumulator WSOL ATA idempotently
);

const tx = new Transaction().add(...instructions);
const sig = await sendAndConfirmTransaction(connection, tx, [userKeypair]);
console.log(`Claim confirmed: https://solscan.io/tx/${sig}`);
```

## Cashback Rules (Important)

Reference: `docs/PUMP_CASHBACK_README.md`

- **Pump.fun Buy**: no extra manual remaining account needed for cashback in this SDK path.
- **Pump.fun Sell**: appends `user_volume_accumulator` only if `is_cashback_coin=true`.
- **PumpSwap Buy** cashback coin: appends accumulator WSOL ATA as remaining account[0].
- **PumpSwap Sell** cashback coin: appends accumulator WSOL ATA + accumulator PDA.

## V2 Trailing Accounts

`PUMP_INCLUDE_V2_ACCOUNTS` modes:
- `true` (default): always append v2 trailing accounts.
- `false`: never append v2 trailing accounts.

Trailing accounts:
- Pump.fun: `bonding_curve_v2` (`bonding-curve-v2`, mint)
- PumpSwap: `pool_v2` (`pool-v2`, mint)

Use `false` only if you explicitly target an older layout.

## Examples / Test Scripts

- Buy: `npm run test:buy`
- Sell: `npm run test:sell`
- Claim Pump.fun cashback: `npm run test:claim:pumpfun`
- Claim PumpSwap cashback: `npm run test:claim:pumpswap`

Update hardcoded mint values in:
- `src/instructions/testBuy.js`
- `src/instructions/testSell.js`

## Troubleshooting

- **`AccountNotInitialized: associated_user` (sell)**:
  Usually wrong ATA/token program derivation. This SDK now derives sell ATAs using mint owner program.

- **`Overflow (0x1788)` on legacy buy**:
  Try `BUY_MODE=buy_exact_sol_in`.

- **PumpSwap claim error on accumulator WSOL ATA not initialized**:
  Ensure `buildPumpSwapClaimCashback(..., true, true)` is used.

- **RPC `fetch failed`**:
  Usually endpoint/network issue; retry or switch RPC.

## License

MIT License. See [LICENSE](LICENSE).

## Disclaimer

This SDK is for educational/integration use. Solana trading and on-chain interaction can result in loss of funds. Use at your own risk.
