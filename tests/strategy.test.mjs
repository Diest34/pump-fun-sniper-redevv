// Local unit tests for the FreshTape Sniper strategy (node --test).
// Synthetic hello/batches only — no network, no clock, no randomness.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BotState } from '../vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS, sellValueLamports, priceRatioBps } from '../strategy.ts';

const MINT = '7xKXtt2Khs1p6kP9zQmR8vN3wY4bL5cD6eF7gH8jK9m';
const MINT2 = '8yLYuu3Lht2q7lQ0aRnS9wO4xZ5cM6dE7fG8hI9jK0n';
const CREATOR = 'Creat0r11111111111111111111111111111111111111';
const U1 = 'User1111111111111111111111111111111111111111';
const U2 = 'User2222222222222222222222222222222222222222';
const U3 = 'User3333333333333333333333333333333333333333';

const HELLO = {
  type: 'hello',
  protocol: 'agent-fun/replay/v2',
  seed: '1351489192800835981',
  universe: {
    program: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
    quote: 'SOL',
    mayhem: 'excluded',
    exclude_cashback: true,
    sample: { hash: 'sha256', modulus: 16, residue: 15 },
  },
  capital: { lamports: '10000000000' },
  caps: { max_open_positions: 5, max_order_bps_of_real_reserve: 100, max_orders_per_batch: 16, shorts: false, leverage: false },
  latency_slots: 2,
  fees: { protocol_bps_fallback: 95, creator_bps_fallback: 30, base_fee_lamports: '5000', priority_fee_lamports: '100000', failed_tx_bps: 200 },
};

const VQ0 = 30_000_000_000n;
const VT0 = 1_073_000_000_000_000n;

function createEvent(slot, mint, creator) {
  return {
    event: 'CreateEvent', slot, signature: `sig-create-${slot}-${mint.slice(0, 4)}`, block_time: 1793588943 + slot,
    chain_seq: 0, name: 'Test', symbol: 'TST', uri: '', mint, bonding_curve: mint, user: creator, creator,
    timestamp: '1793588943', virtual_token_reserves: VT0.toString(), virtual_sol_reserves: VQ0.toString(),
    real_token_reserves: VT0.toString(), token_total_supply: VT0.toString(),
    token_program: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', is_mayhem_mode: false,
    is_cashback_enabled: false, quote_mint: '11111111111111111111111111111111',
    virtual_quote_reserves: VQ0.toString(), creator_fee_bps: '0', is_holder_reward: false, depth: 0,
  };
}

function tradeEvent(slot, seq, mint, user, isBuy, solLamports, vq, vt, rq) {
  return {
    event: 'TradeEvent', slot, signature: `sig-trade-${slot}-${seq}`, block_time: 1793588943 + slot,
    chain_seq: seq, mint, sol_amount: solLamports.toString(), token_amount: '1000000000000',
    is_buy: isBuy, user, timestamp: '1793588943',
    virtual_sol_reserves: vq.toString(), virtual_token_reserves: vt.toString(),
    real_sol_reserves: rq.toString(), real_token_reserves: vt.toString(),
    fee_recipient: CREATOR, fee_basis_points: '95', fee: '0', creator: CREATOR,
    creator_fee_basis_points: '30', creator_fee: '0', track_volume: true,
    total_unclaimed_tokens: '0', total_claimed_tokens: '0', current_sol_volume: '0',
    last_update_timestamp: '1793588943', ix_name: 'buy', mayhem_mode: false,
    cashback_fee_basis_points: '0', cashback: '0', buyback_fee_basis_points: '0', buyback: '0',
    shareholders: [], quote_mint: '11111111111111111111111111111111', quote_amount: '0',
    virtual_quote_reserves: vq.toString(), real_quote_reserves: rq.toString(),
    holder_rewards_bps: '0', holder_rewards: '0', creator_fee_unclaimed: '0',
  };
}

function batch(seq, slot, events, marks = [], fills = [], account = null) {
  return {
    type: 'batch', seq, slot, events, marks, fills,
    account: account ?? { cash_lamports: '10000000000', positions: [] },
  };
}

/** A launch whose opening tape passes every filter: creator buys 0.5 SOL in
 *  the create slot, two outsiders buy 0.3 + 0.2 SOL, real reserve ends at 1 SOL. */
function qualifyingLaunch(slot, mint = MINT, creator = CREATOR) {
  return [
    createEvent(slot, mint, creator),
    tradeEvent(slot, 1, mint, creator, true, 500_000_000, 30_500_000_000n, 1_056_000_000_000_000n, 500_000_000n),
    tradeEvent(slot + 1, 2, mint, U1, true, 300_000_000, 30_800_000_000n, 1_046_000_000_000_000n, 800_000_000n),
    tradeEvent(slot + 1, 3, mint, U2, true, 200_000_000, 31_000_000_000n, 1_040_000_000_000_000n, 1_000_000_000n),
  ];
}

function drive(batches, params = DEFAULT_PARAMS) {
  const state = new BotState(HELLO);
  const strategy = createStrategy(params);
  const allOrders = [];
  for (const b of batches) {
    state.applyBatch(b);
    const orders = strategy.onBatch(state, b);
    allOrders.push(orders);
    // Validate through the shim exactly as the harness would.
    state.recordOrders(state.toOrders(orders));
  }
  return allOrders;
}

test('sellValueLamports: constant-product sale minus 1.25% curve fees', () => {
  const tokens = 1_000_000_000_000n;
  const gross = (tokens * VQ0) / (VT0 + tokens);
  const expected = gross - ((gross * 125n + 10_000n - 1n) / 10_000n);
  assert.equal(sellValueLamports(tokens, VQ0, VT0), expected);
  assert.equal(sellValueLamports(0n, VQ0, VT0), 0n);
});

test('priceRatioBps: +10% move reads 11000', () => {
  assert.equal(priceRatioBps(33_000_000_000n, VT0, VQ0, VT0), 11000n);
  assert.equal(priceRatioBps(VQ0, VT0, VQ0, VT0), 10000n);
});

test('entry: a qualifying launch gets a first buy of exactly the 0.01 SOL guardrail minimum', () => {
  // Real reserve 1 SOL -> 1% cap = 0.01 SOL; first-buy target is 0.02 SOL,
  // so the capped buy is exactly 10,000,000 lamports (the round-trip minimum).
  const orders = drive([
    batch(0, 100, qualifyingLaunch(100)),
    batch(1, 101, []),
    batch(2, 102, []),
  ]);
  const buys = orders.flat().filter((o) => o.side === 'buy');
  assert.equal(buys.length, 1);
  assert.equal(buys[0].mint, MINT);
  assert.equal(buys[0].quote_lamports, 10_000_000n);
});

test('entry: no buy when the creator sold before entry', () => {
  // The creator sells in the same slot-101 batch as the outside buys, so the
  // bot sees devSold=true before any buy could be decided.
  const devSell = tradeEvent(101, 4, MINT, CREATOR, false, 100_000_000, 30_900_000_000n, 1_042_000_000_000_000n, 900_000_000n);
  const launch = qualifyingLaunch(100);
  const orders = drive([
    batch(0, 100, launch.slice(0, 2)),
    batch(1, 101, [...launch.slice(2), devSell]),
    batch(2, 102, []),
  ]);
  assert.equal(orders.flat().filter((o) => o.side === 'buy').length, 0);
});

test('entry: no buy when the creator never bought (zero dev buy)', () => {
  const events = [
    createEvent(100, MINT2, CREATOR),
    tradeEvent(100, 1, MINT2, U1, true, 300_000_000, 30_300_000_000n, 1_062_000_000_000_000n, 300_000_000n),
    tradeEvent(101, 2, MINT2, U2, true, 200_000_000, 30_500_000_000n, 1_056_000_000_000_000n, 500_000_000n),
    tradeEvent(101, 3, MINT2, U3, true, 500_000_000, 31_000_000_000n, 1_040_000_000_000_000n, 1_000_000_000n),
  ];
  const orders = drive([batch(0, 100, events.slice(0, 2)), batch(1, 101, events.slice(2)), batch(2, 102, [])]);
  assert.equal(orders.flat().filter((o) => o.side === 'buy').length, 0);
});

test('entry: no buy once the launch is older than maxAge', () => {
  // The second buyer only shows up at slot 109 (age 9, past maxAge 8):
  // before that the coin has 0 outside buyers, after that it is done.
  const late = [
    createEvent(100, MINT, CREATOR),
    tradeEvent(100, 1, MINT, CREATOR, true, 500_000_000, 30_500_000_000n, 1_056_000_000_000_000n, 500_000_000n),
  ];
  const lateBuyer = tradeEvent(109, 2, MINT, U1, true, 300_000_000, 30_800_000_000n, 1_046_000_000_000_000n, 800_000_000n);
  const batches = [batch(0, 100, late)];
  for (let s = 101; s <= 108; s++) batches.push(batch(s - 100, s, []));
  batches.push(batch(9, 109, [lateBuyer]));
  batches.push(batch(10, 110, []));
  const orders = drive(batches);
  assert.equal(orders.flat().filter((o) => o.side === 'buy').length, 0);
});

test('exits: +30% mark triggers the rung-1 partial sell of half the tokens', () => {
  const tokens = 350_000_000_000n;
  const buyFill = {
    client_id: 'o1', mint: MINT, side: 'buy', status: 'filled', reason: null,
    decided_slot: 102, slot: 104, quote_lamports: '10000000', token_amount: tokens.toString(),
    fee_lamports: '125000', tx_fee_lamports: '105000', fee_fallback: false,
  };
  const account = { cash_lamports: '9989895000', positions: [{ mint: MINT, token_amount: tokens.toString(), cost_lamports: '10000000' }] };
  // Price +30%: vq/vt 1.3x the buy-time ratio (buy-time vq 31e9 / vt 1.04e15).
  const upMark = { mint: MINT, slot: 105, virtual_token_reserves: '1040000000000000', virtual_quote_reserves: '40300000000', real_token_reserves: '1040000000000000', real_quote_reserves: '1000000000' };
  const orders = drive([
    batch(0, 100, qualifyingLaunch(100)),
    batch(1, 101, []),
    batch(2, 102, []),
    batch(3, 104, [], [], [buyFill], account),
    batch(4, 105, [], [upMark], [], account),
  ]);
  const sells = orders[4].filter((o) => o.side === 'sell');
  assert.equal(sells.length, 1);
  assert.equal(sells[0].token_amount, tokens / 2n);
});

test('exits: -15% mark triggers the hard-stop full sell', () => {
  const tokens = 350_000_000_000n;
  const buyFill = {
    client_id: 'o1', mint: MINT, side: 'buy', status: 'filled', reason: null,
    decided_slot: 102, slot: 104, quote_lamports: '10000000', token_amount: tokens.toString(),
    fee_lamports: '125000', tx_fee_lamports: '105000', fee_fallback: false,
  };
  const account = { cash_lamports: '9989895000', positions: [{ mint: MINT, token_amount: tokens.toString(), cost_lamports: '10000000' }] };
  // Price -15% vs buy time: vq 26.35e9 / vt 1.04e15.
  const downMark = { mint: MINT, slot: 105, virtual_token_reserves: '1040000000000000', virtual_quote_reserves: '26350000000', real_token_reserves: '1040000000000000', real_quote_reserves: '1000000000' };
  const orders = drive([
    batch(0, 100, qualifyingLaunch(100)),
    batch(1, 101, []),
    batch(2, 102, []),
    batch(3, 104, [], [], [buyFill], account),
    batch(4, 105, [], [downMark], [], account),
  ]);
  const sells = orders[4].filter((o) => o.side === 'sell');
  assert.equal(sells.length, 1);
  assert.equal(sells[0].token_amount, tokens);
});

test('determinism: the same batches twice give byte-identical order streams', () => {
  const script = [
    batch(0, 100, qualifyingLaunch(100)),
    batch(1, 101, []),
    batch(2, 102, []),
    batch(3, 103, [], [{ mint: MINT, slot: 103, virtual_token_reserves: '1040000000000000', virtual_quote_reserves: '31000000000', real_token_reserves: '1040000000000000', real_quote_reserves: '1000000000' }]),
    batch(4, 104, []),
    batch(5, 105, []),
  ];
  const first = drive(script);
  const second = drive(script);
  const stringify = (v) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x));
  assert.equal(stringify(first), stringify(second));
  assert.ok(first.flat().some((o) => o.side === 'buy'));
});
