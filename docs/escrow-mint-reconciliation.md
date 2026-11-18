# Escrow mint: what the finalizer decides, and manual reconciliation

The settlement finalizer (`FinalizeIpoEscrowCampaignsService`) mints a contributor's position tokens after a campaign succeeds. Each contributor has one row in `escrow_mint_intents` (status `sending`, `mint_sent`, `recorded`). The row pins the operator nonce of the latest attempt (`mint_nonce`), so a later run can settle an unclear attempt from the chain instead of a clock. It never sends a second mint while an earlier one could still land.

## What it decides on its own

For an intent that is not `recorded`, with a pinned nonce, and either no recorded hash or a recorded hash that has no receipt, it reads the operator's confirmed nonce, then the token's mint logs for this wallet and amount, then the wallet's balance:

| Chain shows | Action |
| --- | --- |
| Exactly one mint log, balance equals the contribution | Adopts that transaction (replacing the recorded hash if it differs) and records the position |
| No log, zero balance, confirmed nonce past the pinned nonce | The mint can never land: new attempt under a fresh nonce |
| No log, zero balance, nonce not yet used, recorded hash | Waits `ESCROW_MINT_IN_FLIGHT_GRACE_MS` (30 min) from the attempt start, then resends under the same nonce |
| No log, zero balance, nonce not yet used, no recorded hash | Resends under the same nonce at once |
| More than one mint log, or a balance that does not match | Refuses (`manual reconciliation required`) |

Intents written before nonces were pinned (`mint_nonce` NULL) keep the older rule: a recorded hash with no receipt is never replaced automatically.

## Reconciling a refused intent by hand

Who: an engineer with write access to the production database, after reading the chain; record the decision and the evidence on the Paperclip task. Whether the founder must approve is **open**; this page proposes yes, because the row decides whether tokens are minted.

1. Read the intent: `SELECT * FROM escrow_mint_intents WHERE piv_id = … AND account_id = …`. Note `holder_wallet_address`, `token_id`, `mint_amount`, `mint_tx_hash`, `mint_nonce`, `search_from_block`.
2. On chain, from `search_from_block`: list the token's `TransferSingle` logs with `from` = zero address, `to` = the wallet, `id` = the token id. Read `balanceOf(wallet, token_id)`. Read the operator's transaction count at `finalized`, and look up `mint_tx_hash` and any transaction that used `mint_nonce`.
3. Decide:
   - **One log of exactly `mint_amount`, balance still equals it** (the position was minted): the finalizer would adopt it. If it refused for another reason, set `mint_tx_hash` to that log's transaction hash and leave `status = 'mint_sent'`; the next run records the position.
   - **More than one log:** the wallet was minted more than once. Do not mint again. Decide with the founder how to correct the wallet (`VistaBloxProperty.burn` needs `BURNER_ROLE`), then repair the row.
   - **Balance differs from the log** (burned, force-transferred, or moved): find where the tokens went before touching the row.
   - **No log, zero balance, nonce used:** set `status = 'sending'`, `mint_tx_hash = NULL` and `mint_nonce` to the operator's current pending nonce; the next run decides again. Normally the finalizer does this itself.
4. Never set `status = 'recorded'` by hand: only `recordEscrowMintedPosition` writes the position and that flip together.
