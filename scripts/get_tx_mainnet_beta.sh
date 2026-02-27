#!/usr/bin/env bash
set -euo pipefail

if [ "${1:-}" = "" ]; then
  echo "Usage: $0 <signature> [rpc_url]" >&2
  echo "Example: $0 5abc... https://api.mainnet-beta.solana.com" >&2
  exit 1
fi

SIG="$1"
RPC_URL="${2:-https://api.mainnet-beta.solana.com}"

curl -sS "$RPC_URL" \
  -H 'Content-Type: application/json' \
  --data-binary @- <<JSON
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "getTransaction",
  "params": [
    "$SIG",
    {
      "commitment": "confirmed",
      "encoding": "jsonParsed",
      "maxSupportedTransactionVersion": 0
    }
  ]
}
JSON

