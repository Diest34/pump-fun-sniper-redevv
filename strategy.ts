// FreshTape Sniper — a pump.fun launch sniper for agent-fun/replay/v2.
//
// Idea: most pump.fun launches fade within minutes, but a minority run 2x-10x
// in their first few hundred slots. This bot buys small and early, only on
// launches whose opening tape shows a real creator stake plus real outside
// buyers, banks gains on a take-profit ladder, cuts losers at a hard stop,
// and lets a runner ride behind a trailing stop. A coin is never re-entered.
//
// A pure function of the batches it is fed: no clock, no randomness, no I/O,
// no environment reads. Iteration order is first-seen order, so the orders
// emitted for a given replay are identical on every run.

import { BPS, type Batch, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Youngest age (slots since create) at which a first buy may be decided. */
  minAge: number;
  /** Oldest age at which a first buy may still be decided. */
  maxAge: number;
  /** Lamports aimed at for the first buy of a coin. */
  firstBuyLamports: number;
  /** Lamports aimed at in total per coin (first buy + adds). */
  totalStakeLamports: number;
  /** Smallest single buy worth paying a tx fee for. */
  minBuyLamports: number;
  /** Adds after the first buy. */
  maxAdds: number;
  /** Slots to wait after the previous buy was decided before an add. */
  addDelaySlots: number;
  /** Latest age (slots) at which an add may still be decided. */
  addMaxAge: number;
  /** An add needs the price at least this far (bps, may be negative) above the last buy's decision price. */
  addMinPriceBps: number;
  /** Real SOL reserve window at decision time (lamports). */
  minRealSol: number;
  maxRealSol: number;
  /** Creator's own buys in the create slot: lamports window. */
  minDevBuy: number;
  maxDevBuy: number;
  /** Trades seen and distinct non-creator buyers seen before entry. */
  minTrades: number;
  minBuyers: number;
  /** Distinct non-creator buyers before entry, at most: a launch bundled by many wallets is a dump in waiting. */
  maxBuyers: number;
  /** Lamports sold by others / lamports bought by others, as bps, at most. */
  maxSellRatioBps: number;
  /** Largest single non-creator sell seen, as bps of the real SOL reserve before it, at most. */
  maxBigSellBps: number;
  /** Price now over the create price, as bps: window. */
  minRunupBps: number;
  maxRunupBps: number;
  /** The recent-flow window (slots) and the minimum net flow (lamports) it must show. */
  flowWindow: number;
  minFlowLamports: number;
  /** Slippage allowed on buys (bps). */
  buySlippageBps: number;
  /** Rung 1: sell tp1PartBps of the position once its value is tp1Bps over its basis. */
  tp1Bps: number;
  tp1PartBps: number;
  /** Rung 2: sell tp2PartBps of what is left once its value is tp2Bps over its basis. */
  tp2Bps: number;
  tp2PartBps: number;
  /** Rung 3: sell everything once its value is tp3Bps over its basis. */
  tp3Bps: number;
  /** Exit when the position is worth this much under its basis (bps). */
  stopBps: number;
  /** Trailing stop: once the best value is at least trailArmBps over basis, exit on a fall of trailBps from the best. */
  trailArmBps: number;
  trailBps: number;
  /** Exit after holding this many slots. */
  maxHoldSlots: number;
  /** Exit when the creator sells while held. */
  exitOnDevSell: boolean;
  /** Exit when no trade has hit the coin for this many slots. */
  staleSlots: number;
  /** Exit when the net flow over exitFlowWindow slots falls below this many lamports. */
  exitFlowWindow: number;
  exitFlowLamports: number;
}

export const DEFAULT_PARAMS: Params = {
  minAge: 1,
  maxAge: 6,
  firstBuyLamports: 20_000_000,
  totalStakeLamports: 50_000_000,
  minBuyLamports: 5_000_000,
  // Adds tested worse in the local sim (they buy into launches that already
  // ran): off by default; the knob stays for research.
  maxAdds: 0,
  addDelaySlots: 3,
  addMaxAge: 20,
  addMinPriceBps: -200,
  minRealSol: 200_000_000,
  maxRealSol: 40_000_000_000,
  minDevBuy: 100_000_000,
  maxDevBuy: 6_000_000_000,
  minTrades: 3,
  minBuyers: 2,
  maxBuyers: 4,
  maxSellRatioBps: 4000,
  maxBigSellBps: 2500,
  minRunupBps: 9500,
  maxRunupBps: 15000,
  flowWindow: 10,
  minFlowLamports: 0,
  buySlippageBps: 2000,
  tp1Bps: 1500,
  tp1PartBps: 5000,
  tp2Bps: 7500,
  tp2PartBps: 5000,
  tp3Bps: 20000,
  stopBps: 1000,
  trailArmBps: 4000,
  trailBps: 2000,
  maxHoldSlots: 240,
  exitOnDevSell: true,
  staleSlots: 90,
  exitFlowWindow: 20,
  exitFlowLamports: -20_000_000,
};

/** Curve fees charged on a sell: protocol 95 bps + creator 30 bps. */
const SELL_FEE_BPS = 125n;

const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

/** What selling `tokens` against reserves (vq, vt) would pay after curve fees. */
export function sellValueLamports(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n || vq <= 0n) return 0n;
  const gross = (tokens * vq) / (vt + tokens);
  return gross - ceilDiv(gross * SELL_FEE_BPS, BPS);
}

/** Price now over price then, as bps: (vqNow * vtThen) / (vtNow * vqThen) in bps. */
export function priceRatioBps(vqNow: bigint, vtNow: bigint, vqThen: bigint, vtThen: bigint): bigint {
  if (vtNow <= 0n || vqThen <= 0n || vtThen <= 0n) return 0n;
  return (vqNow * vtThen * BPS) / (vtNow * vqThen);
}

interface TapeTick {
  slot: number;
  isBuy: boolean;
  sol: bigint;
  user: Pubkey;
}

interface Coin {
  mint: Pubkey;
  createSlot: number;
  creator: Pubkey;
  vq0: bigint;
  vt0: bigint;
  devBuy: bigint;
  devSold: boolean;
  buyers: Set<Pubkey>;
  trades: number;
  boughtByOthers: bigint;
  soldByOthers: bigint;
  bigSellBps: bigint;
  lastTradeSlot: number;
  /** Trades inside the flow windows; pruned as new ones arrive. */
  tape: TapeTick[];
  buysSent: number;
  spentSent: bigint;
  lastBuyVq: bigint;
  lastBuyVt: bigint;
  lastBuySlot: number;
  /** Never buy it again (exited, filtered out for good, or completed). */
  done: boolean;
  complete: boolean;
}

interface Held {
  openedSlot: number;
  /** Tx fees paid on this position's orders so far. */
  txPaid: bigint;
  /** Best sell value seen (lamports, net of one tx fee). */
  bestValue: bigint;
  /** Highest take-profit rung already taken (0, 1 or 2). */
  rung: number;
  devSoldAtOpen: boolean;
}

export interface Strategy {
  onBatch(state: BotState, batch: Batch): OrderInput[];
}

export function createStrategy(params: Params = DEFAULT_PARAMS): Strategy {
  const P = params;
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  /** Mints with a sell already in flight this run. */
  const selling = new Set<Pubkey>();

  function ingest(batch: Batch): void {
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        coins.set(e.mint, {
          mint: e.mint,
          createSlot: e.slot,
          creator: e.creator,
          vq0: BigInt(e.virtual_quote_reserves),
          vt0: BigInt(e.virtual_token_reserves),
          devBuy: 0n,
          devSold: false,
          buyers: new Set(),
          trades: 0,
          boughtByOthers: 0n,
          soldByOthers: 0n,
          bigSellBps: 0n,
          lastTradeSlot: e.slot,
          tape: [],
          buysSent: 0,
          spentSent: 0n,
          lastBuyVq: 0n,
          lastBuyVt: 1n,
          lastBuySlot: 0,
          done: false,
          complete: false,
        });
      } else if (e.event === 'TradeEvent') {
        const c = coins.get(e.mint);
        if (c === undefined) continue;
        const sol = BigInt(e.sol_amount);
        c.trades += 1;
        c.lastTradeSlot = e.slot;
        c.tape.push({ slot: e.slot, isBuy: e.is_buy, sol, user: e.user });
        const isDev = e.user === c.creator;
        if (e.is_buy) {
          if (isDev && e.slot === c.createSlot) c.devBuy += sol;
          else if (!isDev) {
            c.buyers.add(e.user);
            c.boughtByOthers += sol;
          }
        } else if (isDev) {
          c.devSold = true;
        } else {
          c.soldByOthers += sol;
          const reserveBefore = BigInt(e.real_quote_reserves) + sol;
          if (reserveBefore > 0n) {
            const bps = (sol * BPS) / reserveBefore;
            if (bps > c.bigSellBps) c.bigSellBps = bps;
          }
        }
      } else {
        const c = coins.get(e.mint);
        if (c !== undefined) {
          c.complete = true;
          c.done = true;
        }
      }
    }
  }

  /** Net flow (buys minus sells, lamports) and distinct non-creator buyers over the last `window` slots. */
  function flow(c: Coin, slot: number, window: number): { net: bigint; buyers: number } {
    const from = slot - window;
    let drop = 0;
    while (drop < c.tape.length && c.tape[drop]!.slot <= from) drop++;
    if (drop > 0) c.tape.splice(0, drop);
    let net = 0n;
    const buyers = new Set<Pubkey>();
    for (const t of c.tape) {
      if (t.isBuy) {
        net += t.sol;
        if (t.user !== c.creator) buyers.add(t.user);
      } else {
        net -= t.sol;
      }
    }
    return { net, buyers: buyers.size };
  }

  function hasPending(state: BotState, mint: Pubkey, side: 'buy' | 'sell'): boolean {
    for (const p of state.pending.values()) {
      if (p.order.mint === mint && p.order.side === side) return true;
    }
    return false;
  }

  return {
    onBatch(state, batch) {
      ingest(batch);
      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = state.txFeeLamports();
      const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
      for (const m of batch.marks) {
        marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });
      }

      // Fold fills into the held book. A buy that did not fill (rejected or
      // failed) frees the coin for a fresh first buy; a harness close
      // (client_id starting with `_`) ends the position.
      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) {
          held.delete(f.mint);
          selling.delete(f.mint);
          continue;
        }
        const h = held.get(f.mint);
        if (h !== undefined && f.status !== 'rejected') h.txPaid += BigInt(f.tx_fee_lamports);
        if (f.side === 'buy' && f.status === 'filled' && h === undefined) {
          const c = coins.get(f.mint);
          held.set(f.mint, {
            openedSlot: f.slot,
            txPaid: BigInt(f.tx_fee_lamports),
            bestValue: 0n,
            rung: 0,
            devSoldAtOpen: c?.devSold ?? false,
          });
        }
        if (f.side === 'buy' && f.status !== 'filled') {
          const c = coins.get(f.mint);
          if (c !== undefined) {
            c.buysSent = 0;
            c.spentSent = 0n;
            c.lastBuySlot = 0;
          }
        }
        if (f.side === 'sell' && f.status === 'filled') {
          const h2 = held.get(f.mint);
          if (h2 !== undefined && f.token_amount !== undefined) {
            // A partial fill advances the rung only through the exit logic
            // below (it re-reads the position); nothing to do here.
          }
        }
      }
      for (const mint of [...selling]) if (!hasPending(state, mint, 'sell')) selling.delete(mint);
      for (const mint of [...held.keys()]) {
        if (!state.positions.has(mint) && !selling.has(mint) && !hasPending(state, mint, 'buy')) held.delete(mint);
      }

      // ---- Exits first: ladder, stop, trailing stop, time, dev sell, stale, flow.
      for (const [mint, pos] of state.positions) {
        if (orders.length >= cap) break;
        if (selling.has(mint)) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const c = coins.get(mint);
        let h = held.get(mint);
        if (h === undefined) {
          h = { openedSlot: state.slot, txPaid: tx, bestValue: 0n, rung: 0, devSoldAtOpen: c?.devSold ?? false };
          held.set(mint, h);
        }
        const mk = marks.get(mint) ?? { vq: curve.virtual_quote_reserves, vt: curve.virtual_token_reserves };
        const value = sellValueLamports(pos.token_amount, mk.vq, mk.vt) - tx;
        const basis = pos.cost_lamports + h.txPaid;
        if (basis <= 0n) continue;
        if (value > h.bestValue) h.bestValue = value;

        // Take-profit ladder, one rung per batch at most.
        if (h.rung === 0 && value * BPS >= basis * (BPS + BigInt(P.tp1Bps))) {
          const part = (pos.token_amount * BigInt(P.tp1PartBps)) / BPS;
          if (part > 0n && part < pos.token_amount) {
            orders.push({ side: 'sell', mint, token_amount: part, max_slippage_bps: 10_000 });
            selling.add(mint);
            h.rung = 1;
            continue;
          }
        }
        if (h.rung === 1 && value * BPS >= basis * (BPS + BigInt(P.tp2Bps))) {
          const part = (pos.token_amount * BigInt(P.tp2PartBps)) / BPS;
          if (part > 0n && part < pos.token_amount) {
            orders.push({ side: 'sell', mint, token_amount: part, max_slippage_bps: 10_000 });
            selling.add(mint);
            h.rung = 2;
            continue;
          }
        }
        let exit = false;
        if (value * BPS >= basis * (BPS + BigInt(P.tp3Bps))) exit = true;
        if (value * BPS <= basis * (BPS - BigInt(P.stopBps))) exit = true;
        if (h.bestValue * BPS >= basis * (BPS + BigInt(P.trailArmBps)) && value * BPS <= h.bestValue * (BPS - BigInt(P.trailBps))) {
          exit = true;
        }
        if (state.slot - h.openedSlot >= P.maxHoldSlots) exit = true;
        if (c !== undefined) {
          if (P.exitOnDevSell && c.devSold && !h.devSoldAtOpen) exit = true;
          if (state.slot - c.lastTradeSlot >= P.staleSlots) exit = true;
          if (flow(c, state.slot, P.exitFlowWindow).net < BigInt(P.exitFlowLamports)) exit = true;
        }
        if (!exit) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        selling.add(mint);
        if (c !== undefined) c.done = true;
      }

      // ---- Entries and adds.
      let free = state.freeCashLamports() - tx * BigInt(orders.length);
      let open = state.committedPositionCount();
      for (const c of coins.values()) {
        if (orders.length >= cap) break;
        if (c.done || c.complete) continue;
        const age = state.slot - c.createSlot;
        const isAdd = c.buysSent > 0;
        if (!isAdd && age > P.maxAge) {
          c.done = true;
          continue;
        }
        if (!isAdd && age < P.minAge) continue;
        if (isAdd) {
          if (c.buysSent > P.maxAdds) continue;
          if (age > P.addMaxAge) continue;
          if (!state.positions.has(c.mint) || selling.has(c.mint) || hasPending(state, c.mint, 'buy')) continue;
          if (state.slot - c.lastBuySlot < P.addDelaySlots) continue;
        } else if (open >= state.hello.caps.max_open_positions) {
          continue;
        }
        const curve = state.curves.get(c.mint);
        if (curve === undefined || curve.complete) continue;
        if (c.devSold) {
          if (!isAdd) c.done = true;
          continue;
        }
        const vq = curve.virtual_quote_reserves;
        const vt = curve.virtual_token_reserves;

        if (isAdd) {
          // Add only while the tape still looks alive and the price has not
          // faded below the last buy's decision price (beyond tolerance).
          if (priceRatioBps(vq, vt, c.lastBuyVq, c.lastBuyVt) < BPS + BigInt(P.addMinPriceBps)) continue;
          if (flow(c, state.slot, P.flowWindow).net < BigInt(P.minFlowLamports)) continue;
          const want = BigInt(P.totalStakeLamports) - c.spentSent;
          if (want < BigInt(P.minBuyLamports)) continue;
          const amount = want < state.maxBuyLamports(c.mint) ? want : state.maxBuyLamports(c.mint);
          if (amount < BigInt(P.minBuyLamports) || free < amount + tx) continue;
          orders.push({ side: 'buy', mint: c.mint, quote_lamports: amount, max_slippage_bps: P.buySlippageBps });
          free -= amount + tx;
          c.buysSent += 1;
          c.spentSent += amount;
          c.lastBuyVq = vq;
          c.lastBuyVt = vt;
          c.lastBuySlot = state.slot;
          continue;
        }

        // Rug filter for a first buy.
        const rq = curve.real_quote_reserves;
        if (rq < BigInt(P.minRealSol) || rq > BigInt(P.maxRealSol)) continue;
        if (c.devBuy < BigInt(P.minDevBuy) || c.devBuy > BigInt(P.maxDevBuy)) continue;
        if (c.trades < P.minTrades || c.buyers.size < P.minBuyers || c.buyers.size > P.maxBuyers) continue;
        if (c.boughtByOthers > 0n && c.soldByOthers * BPS > c.boughtByOthers * BigInt(P.maxSellRatioBps)) continue;
        if (c.bigSellBps > BigInt(P.maxBigSellBps)) continue;
        const runup = priceRatioBps(vq, vt, c.vq0, c.vt0);
        if (runup < BigInt(P.minRunupBps) || runup > BigInt(P.maxRunupBps)) continue;
        const fl = flow(c, state.slot, P.flowWindow);
        if (fl.net < BigInt(P.minFlowLamports)) continue;
        const want = BigInt(P.firstBuyLamports);
        const amount = want < state.maxBuyLamports(c.mint) ? want : state.maxBuyLamports(c.mint);
        if (amount < BigInt(P.minBuyLamports)) continue;
        if (free < amount + tx) continue;
        orders.push({ side: 'buy', mint: c.mint, quote_lamports: amount, max_slippage_bps: P.buySlippageBps });
        free -= amount + tx;
        c.buysSent += 1;
        c.spentSent += amount;
        c.lastBuyVq = vq;
        c.lastBuyVt = vt;
        c.lastBuySlot = state.slot;
        open += 1;
      }
      return orders;
    },
  };
}
