// End-to-end lifecycle of Delivery Escrow on GenLayer Studionet, against a REAL carrier tracking page.
//
//   npm install
//   node scripts/lifecycle-studionet.mjs          # run (or resume) the whole lifecycle
//   FRESH=1 node scripts/lifecycle-studionet.mjs  # throw away the previous run and start over
//
// Tracking source: Japan Post's public Track & Trace page, which returns plain HTML for a
// GET with the item number in the query string (no JavaScript, cookies or API key):
//   https://trackings.post.japanpost.jp/services/srv/search/direct?reqCodeNo1=<number>&locale=en
// Parcels used (publicly posted tracking numbers, read live by the validators):
//   4370-9143-5196  LETTERPACK Lite, Final delivery 2026-09-26 17:27 JST at TAKANAWA, TOKYO 108-8799
//   EN549083494JP   EMS to China, posted 2026-10-30, not delivered (held at Guangzhou)
//
// Orders (one contract; on-chain ids in creation order):
//   #1 not shipped      : ship_by +4 min, no tracking -> anyone finalizes after ship_by             -> REFUND_NOT_SHIPPED
//   #2 live release     : backdated not_before (2026-09-20 JST) so the real delivery belongs to it -> RELEASE
//   #3 stale-tracking   : same delivered parcel, default not_before (= order time)                -> REFUND_STALE_TRACKING
//   #4 live wait+confirm: EMS item still in transit -> resolve leaves it SHIPPED; buyer confirms early  -> RELEASE
//   #5 dispute          : 1h dispute window -> HOLD; buyer flags once; re-check reads the page again -> RELEASE
//   #6 cancel           : seller cancels voluntarily                                             -> CANCELLED (refund)
// plus negative paths (outsider/seller swaps tracking, double resolve, double dispute, payout after close).
//
// Robustness (fix for the earlier lost-records bug): every transaction is appended to
// deployments/studionet.json the moment it is SUBMITTED (hash first, receipt later), and the
// file is rewritten after every change. Re-running resumes: finished steps are skipped,
// submitted-but-unconfirmed steps are awaited by hash, never re-sent. A per-run time budget
// (BUDGET_S, default unlimited) lets the run be split across short shells.

import fs from "node:fs";
import { createClient, createAccount, generatePrivateKey } from "genlayer-js";
import { studionet } from "genlayer-js/chains";

const BUDGET_MS = Number(process.env.BUDGET_S || 0) * 1000;
const T0 = Date.now();
const UNIT = 1_000_000n; // contract amounts are plain integers; small units keep funding simple
const KEYS = new URL("../artifacts/keys.json", import.meta.url);
const OUT = new URL("../deployments/studionet.json", import.meta.url);
const HOST = "trackings.post.japanpost.jp";
const jpUrl = (n) => `https://${HOST}/services/srv/search/direct?reqCodeNo1=${n.replace(/[^0-9A-Za-z]/g, "")}&locale=en`;
const DELIVERED_NO = "4370-9143-5196";
const TRANSIT_NO = "EN549083494JP";

const client = createClient({ chain: studionet });
const json = (v) => JSON.parse(JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x instanceof Map ? Object.fromEntries(x) : x)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (d) => d.toISOString().replace(/\.\d+Z$/, "Z");
const jst = (d) => new Date(d.getTime() + 9 * 3600_000).toISOString().replace(/\.\d+Z$/, "+09:00");

class OutOfTime extends Error {}
function checkBudget() {
  if (BUDGET_MS && Date.now() - T0 > BUDGET_MS) throw new OutOfTime("time budget used; re-run to resume");
}

if (process.env.FRESH && fs.existsSync(OUT)) fs.renameSync(OUT, new URL(`../artifacts/studionet-${Date.now()}.json`, import.meta.url));
const state = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : { transactions: [] };
const log = state.transactions;

function save(extra = {}) {
  fs.mkdirSync(new URL("../deployments/", import.meta.url), { recursive: true });
  Object.assign(state, extra, { network: "studionet", chain_id: 61999, rpc: "https://studio.genlayer.com/api",
    updated_at: new Date().toISOString() });
  const s = log.filter((t) => t.status);
  state.summary = {
    total: log.length,
    finalized: s.filter((t) => t.status === "FINALIZED").length,
    majority_agree: s.filter((t) => t.consensus === "MAJORITY_AGREE").length,
    success: s.filter((t) => t.ok).length,
    expected_reverts: s.filter((t) => t.expected_ok === false && t.ok === false).length,
    unexpected: s.filter((t) => t.ok !== t.expected_ok).map((t) => t.label),
    not_finalized: log.filter((t) => t.status !== "FINALIZED").map((t) => `${t.label}: ${t.status ?? "SUBMITTED"}`),
  };
  state.summary.all_as_expected = state.summary.unexpected.length === 0 && state.summary.not_finalized.length === 0;
  const tmp = new URL("../deployments/studionet.json.tmp", import.meta.url);
  fs.writeFileSync(tmp, JSON.stringify(json(state), null, 2) + "\n");
  fs.renameSync(tmp, OUT);
}

function describe(receipt) {
  const r = json(receipt);
  const leader = r.consensus_data?.leader_receipt?.[0] ?? r.consensus_data?.leader_receipt ?? {};
  const execution = leader.execution_result ?? r.txExecutionResultName ?? "UNKNOWN";
  const status = r.status_name ?? r.statusName ?? r.status;
  const consensus = r.result_name ?? r.resultName ?? r.result;
  let returnValue = leader.result?.payload?.readable ?? leader.result?.payload ?? null;
  if (returnValue && typeof returnValue !== "string") returnValue = JSON.stringify(returnValue);
  return { status, consensus, execution, ok: execution === "SUCCESS", returnValue };
}

async function retry(fn, tries = 8) {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (e) {
      if (i >= tries) throw e;
      process.stdout.write(`(rpc retry ${i}: ${String(e.shortMessage || e.message).slice(0, 60)}) `);
      await sleep(4000 * i);
    }
  }
}

async function waitFinal(hash) {
  // poll ourselves so a run can stop on its time budget and resume by hash later
  for (;;) {
    checkBudget();
    const tx = await retry(() => client.getTransaction({ hash }));
    const name = tx?.statusName ?? tx?.status_name ?? tx?.status;
    if (name === "FINALIZED") return tx;
    if (["CANCELED", "UNDETERMINED", "LEADER_TIMEOUT", "VALIDATORS_TIMEOUT"].includes(name)) return tx;
    await sleep(5000);
  }
}

// One logged transaction. `key` makes it idempotent across resumed runs.
async function step(key, label, account, fn, expectOk = true, expectText = null) {
  let rec = log.find((t) => t.key === key);
  if (rec?.status === "FINALIZED") { console.log(`- ${label}: done (${rec.execution}) ${String(rec.returnValue ?? "").slice(0, 160)}`); return rec; }
  checkBudget();
  if (!rec) {
    process.stdout.write(`- ${label} ... `);
    const hash = await retry(() => fn(account));
    rec = { key, label, hash, from: account.address, expected_ok: expectOk, submitted_at: new Date().toISOString() };
    log.push(rec);
    save(); // record the hash before waiting, so it can never be lost
  } else {
    process.stdout.write(`- ${label} (resuming ${rec.hash.slice(0, 10)}) ... `);
  }
  const receipt = await waitFinal(rec.hash);
  Object.assign(rec, describe(receipt), { finished_at: new Date().toISOString() });
  save();
  console.log(`${rec.status}/${rec.consensus}/${rec.execution}${rec.returnValue ? " " + String(rec.returnValue).slice(0, 400) : ""}`);
  if (rec.status !== "FINALIZED") throw new Error(`"${label}" did not finalize: ${rec.status}`);
  if (rec.ok !== expectOk) console.log(`  !! unexpected outcome for "${label}"`);
  if (expectOk && expectText && !String(rec.returnValue ?? "").includes(expectText)) console.log(`  !! "${label}" did not return ${expectText}`);
  return rec;
}

const write = (address, functionName, args, value = 0n) => (account) =>
  client.writeContract({ account, address, functionName, args, value });
const read = (address, functionName, args) => retry(() => client.readContract({ address, functionName, args }));
const field = (o, k) => json(o)[k];

async function main() {
  // ----- accounts (throwaway keys, git-ignored)
  if (!fs.existsSync(KEYS)) {
    fs.mkdirSync(new URL("../artifacts/", import.meta.url), { recursive: true });
    fs.writeFileSync(KEYS, JSON.stringify({ buyer: generatePrivateKey(), seller: generatePrivateKey(), outsider: generatePrivateKey() }, null, 2));
  }
  const keys = JSON.parse(fs.readFileSync(KEYS, "utf8"));
  const [buyer, seller, outsider] = [keys.buyer, keys.seller, keys.outsider].map((k) => createAccount(k));
  if (!state.accounts) {
    for (const a of [buyer, seller, outsider]) {
      await retry(() => client.request({ method: "sim_fundAccount", params: [a.address, 1_000_000_000_000] }));
    }
    save({ accounts: { buyer: buyer.address, seller: seller.address, outsider: outsider.address },
      tracking_source: { carrier: "Japan Post", host: HOST, delivered_parcel: jpUrl(DELIVERED_NO), in_transit_parcel: jpUrl(TRANSIT_NO) } });
  }

  // ----- deploy
  if (!state.contract) {
    const code = fs.readFileSync(new URL("../contracts/delivery_escrow.py", import.meta.url), "utf8");
    const d = await step("deploy", "deploy contract", buyer, (account) => client.deployContract({ account, code, args: [] }));
    const receipt = await retry(() => client.getTransaction({ hash: d.hash }));
    const r = json(receipt);
    const address = r.data?.contract_address ?? r.recipient ?? r.to_address ?? r.txDataDecoded?.contractAddress;
    if (!address) throw new Error("no contract address in deploy receipt");
    save({ contract: address });
    console.log(`  contract: ${address}`);
  }
  const C = state.contract;

  // ----- fixed order timings, chosen once and stored so resumed runs reuse them
  if (!state.timing) {
    const now = new Date();
    save({ timing: {
      ship_by: iso(new Date(now.getTime() + 3 * 3600_000)),
      deadline: jst(new Date(now.getTime() + 10 * 24 * 3600_000)),
      short_ship_by: iso(new Date(now.getTime() + 4 * 60_000)),
      short_deadline: jst(new Date(now.getTime() + 24 * 3600_000)),
    } });
  }
  const T = state.timing;
  const order = (key, label, over = {}, amount = 100n) => {
    const a = { item: "Lifecycle demo item", carrier: "Japan Post", tracking_host: HOST, dest_postal: "108",
      dest_city: "Tokyo", ship_by: T.ship_by, delivery_deadline: T.deadline, grace_hours: 24, dispute_hours: 0,
      not_before: "", ...over };
    return step(key, label, buyer, write(C, "create_order", [seller.address, a.item, a.carrier, a.tracking_host,
      a.dest_postal, a.dest_city, a.ship_by, a.delivery_deadline, a.grace_hours, a.dispute_hours, a.not_before], amount * UNIT))
      .then((rec) => { if (rec.ok && !rec.order_id) { rec.order_id = Number(rec.returnValue); rec.label += ` -> order id ${rec.order_id}`; save(); } return rec; });
  };
  const BACKDATE = "2026-09-20T00:00:00+09:00";
  // order ids come from the create_order return values (never assumed from call order)
  const ID = {};
  const N = (k) => { const v = Number(ID[k] ?? log.find((t) => t.key === k)?.returnValue); if (!v) throw new Error(`no order id for ${k}`); return v; };

  // #6 first: its 4-minute ship_by runs out while the rest of the lifecycle executes
  ID.o6 = (await order("o6", `create_order demo 6 (not-shipped demo, ship_by +4 min)`, { item: "Never shipped", ship_by: T.short_ship_by, delivery_deadline: T.short_deadline }, 10n)).returnValue;
  ID.o1 = (await order("o1", `create_order demo 1 (live release: Japan Post 4370-9143-5196 to Tokyo 108, not_before 2026-09-20 JST)`, { item: "Letter Pack to Takanawa", not_before: BACKDATE })).returnValue;
  ID.o2 = (await order("o2", `create_order demo 2 (stale-tracking guard: same parcel, not_before = order time)`, { item: "Stale tracking demo" }, 50n)).returnValue;
  ID.o3 = (await order("o3", `create_order demo 3 (EMS EN549083494JP, in transit -> buyer confirms)`, { item: "EMS to Guangzhou", dest_postal: "", dest_city: "Guangzhou" }, 40n)).returnValue;
  ID.o4 = (await order("o4", `create_order demo 4 (dispute demo: 1h window, same delivered parcel)`, { item: "Dispute demo", not_before: BACKDATE, dispute_hours: 1 }, 30n)).returnValue;
  ID.o5 = (await order("o5", `create_order demo 5 (cancel demo)`, { item: "Cancel demo" }, 20n)).returnValue;
  await step("o0", "create_order with no value (must be rejected)", buyer, write(C, "create_order", [seller.address, "No money", "Japan Post", HOST, "108", "Tokyo", T.ship_by, T.deadline, 24, 0, ""]), false);

  // order #1: tracking once, swap guard, live resolve -> release
  await step("t1x", `set_tracking #${N("o1")} by outsider (must be rejected)`, outsider, write(C, "set_tracking", [N("o1"),DELIVERED_NO, jpUrl(DELIVERED_NO)]), false);
  await step("t1h", `set_tracking #${N("o1")} on a different host (must be rejected)`, seller, write(C, "set_tracking", [N("o1"),DELIVERED_NO, `https://evil.example.com/t?n=${DELIVERED_NO}`]), false);
  await step("t1", `set_tracking #${N("o1")} by seller (${DELIVERED_NO})`, seller, write(C, "set_tracking", [N("o1"),DELIVERED_NO, jpUrl(DELIVERED_NO)]));
  await step("t1s", `set_tracking #${N("o1")} again (swap attempt, must be rejected)`, seller, write(C, "set_tracking", [N("o1"),TRANSIT_NO, jpUrl(TRANSIT_NO)]), false);
  await step("r1", `resolve #${N("o1")} by outsider (validators read Japan Post live; expect RELEASE)`, outsider, write(C, "resolve", [N("o1")]), true, "RELEASE");
  await step("r1x", `resolve #${N("o1")} again (double payout, must be rejected)`, outsider, write(C, "resolve", [N("o1")]), false);
  await step("c1x", `confirm_receipt #${N("o1")} after release (must be rejected)`, buyer, write(C, "confirm_receipt", [N("o1")]), false);

  // order #2: same delivered parcel, but delivered before the order existed -> refund
  await step("t2", `set_tracking #${N("o2")} by seller (${DELIVERED_NO}, delivered before this order)`, seller, write(C, "set_tracking", [N("o2"),DELIVERED_NO, jpUrl(DELIVERED_NO)]));
  await step("r2", `resolve #${N("o2")} (live read; expect REFUND_STALE_TRACKING)`, outsider, write(C, "resolve", [N("o2")]), true, "REFUND_STALE_TRACKING");

  // order #3: live in-transit read (no state change), then buyer confirms early
  await step("t3", `set_tracking #${N("o3")} by seller (${TRANSIT_NO})`, seller, write(C, "set_tracking", [N("o3"),TRANSIT_NO, jpUrl(TRANSIT_NO)]));
  await step("r3", `resolve #${N("o3")} (live read of an undelivered EMS item; expect WAIT, no payout)`, outsider, write(C, "resolve", [N("o3")]), true, "WAIT");
  const o3 = await read(C, "get_order", [N("o3")]);
  if (["SHIPPED", "OPEN"].includes(field(o3, "state"))) {
    await step("c3", `confirm_receipt #${N("o3")} by buyer (early release to seller)`, buyer, write(C, "confirm_receipt", [N("o3")]));
  } else console.log(`  order #3 already ${field(o3, "state")}; skipping buyer confirm`);
  await step("x3", `cancel #${N("o3")} after release (must be rejected)`, seller, write(C, "cancel", [N("o3")]), false);

  // order #4: dispute window
  await step("t4", `set_tracking #${N("o4")} by seller (${DELIVERED_NO})`, seller, write(C, "set_tracking", [N("o4"),DELIVERED_NO, jpUrl(DELIVERED_NO)]));
  await step("r4", `resolve #${N("o4")} (live read; expect HOLD_FOR_DISPUTE_WINDOW)`, outsider, write(C, "resolve", [N("o4")]), true, "HOLD_FOR_DISPUTE_WINDOW");
  await step("d4x", `flag_dispute #${N("o4")} by seller (must be rejected)`, seller, write(C, "flag_dispute", [N("o4"),"not my call"]), false);
  await step("d4", `flag_dispute #${N("o4")} by buyer`, buyer, write(C, "flag_dispute", [N("o4"),"Lifecycle demo: please re-check the scan"]), true, "DISPUTED");
  await step("d4y", `flag_dispute #${N("o4")} again (only once, must be rejected)`, buyer, write(C, "flag_dispute", [N("o4"),"again"]), false);
  await step("r4b", `resolve #${N("o4")} re-check (live read again; expect RELEASE)`, outsider, write(C, "resolve", [N("o4")]), true, "RELEASE");

  // order #5: seller cancels
  await step("x5x", `cancel #${N("o5")} by buyer (must be rejected)`, buyer, write(C, "cancel", [N("o5")]), false);
  await step("x5", `cancel #${N("o5")} by seller (refund to buyer)`, seller, write(C, "cancel", [N("o5")]));

  // order #6: never shipped -> finalize refunds after ship_by
  const wait = new Date(T.short_ship_by).getTime() - Date.now() + 15_000;
  if (wait > 0) {
    if (BUDGET_MS && Date.now() - T0 + wait > BUDGET_MS) throw new OutOfTime(`order #6 ship_by not reached (${Math.ceil(wait / 1000)}s left)`);
    console.log(`  waiting ${Math.ceil(wait / 1000)}s for order #6 ship_by...`); await sleep(wait);
  }
  await step("f6", `finalize #${N("o6")} after ship_by, no tracking (anyone; refund to buyer)`, outsider, write(C, "finalize", [N("o6")]), true, "REFUND_NOT_SHIPPED");

  save({ final_state: { orders: json(await read(C, "list_orders", [0, 10])), stats: json(await read(C, "get_stats", [])) } });
  console.log("\nDONE. Wrote deployments/studionet.json", JSON.stringify(state.summary));
}

main().catch((e) => {
  save();
  if (e instanceof OutOfTime) { console.log(`\nPAUSED: ${e.message}`); process.exit(3); }
  console.error(e); process.exit(1);
});
