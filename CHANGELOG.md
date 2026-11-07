# Changelog

## v0.1.0 (2026-11-07): first release

- Contract `contracts/delivery_escrow.py` (GenVM `v0.2.16`): pay-on-delivery escrow settled by reading a public parcel-tracking page.
  - `create_order` (payable), `set_tracking` (seller, once, before `ship_by`, on the buyer's tracking host), `resolve` (anyone), `confirm_receipt` (buyer), `cancel` (seller), `flag_dispute` (buyer, once), `finalize` (anyone, timeouts).
  - Views: `get_order`, `list_orders`, `get_orders_of`, `get_stats`.
  - Normalized reading (status, delivered date/time, destination) grounded against the page: evidence line must be on the page, delivered date must be written in it, destination fields not on the page are dropped.
  - Custom validator: exact agreement on DELIVERED / RETURNED, delivered date, destination match and the settlement decision; pending statuses are equivalent; free text is never compared.
  - Guards: tracking set once (no URL swaps), host pinned by the buyer, URL must contain the tracking number, stale tracking numbers (delivered before the order) refund, single settlement point with state flipped before transfer, deterministic timeouts so funds never stick.
- Tests: 144 direct-mode tests (`genlayer-test==0.29.2`), tracking pages and LLM readings mocked.
- `genvm-lint check`: passes.
- Studionet: deployed and run end to end against Japan Post's live Track & Trace page. Record in `deployments/studionet.json`.
- Lifecycle script: every transaction is written to the deployment record the moment it is submitted, and runs resume by hash (fixes the lost-setup-records issue of the earlier bounty-payout script).
