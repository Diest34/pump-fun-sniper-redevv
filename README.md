[![make.fun](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/Diest34/pump-fun-sniper-redevv/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/Diest34/pump-fun-sniper-redevv/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

# FreshTape Sniper

A pump.fun launch-sniper bot for the [Pump.fun Bot Sprint: Make Bot And Win](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) bounty on [make.fun](https://make.fun). The bot trades paper SOL on a replay of pump.fun bonding-curve data (`agent-fun/replay/v2`) and is ranked by net PnL.

Referral code: `y12bs3e6`

## Strategy

Most pump.fun launches fade within minutes, but a minority run 2x–10x in their
first few hundred slots. FreshTape buys small and early, only on launches
whose opening tape shows a real creator stake plus real outside buyers, banks
gains on a take-profit ladder, cuts losers at a hard stop, and lets a runner
ride behind a trailing stop. A coin is never re-entered.

**Entry** (first buy, while age is 1–6 slots after creation):

- Creator bought 0.1–6 SOL in the create slot (skin in the game).
- 2–4 distinct non-creator buyers and at least 3 trades seen.
- Creator has not sold; sells by others ≤ 40% of buys by others; no single
  non-creator sell larger than 25% of the real SOL reserve before it.
- Real SOL reserve 0.2–40 SOL; price run-up vs create price between −5% and
  +50% (never chase an already-pumped launch); net flow over the last
  10 slots ≥ 0.

**Sizing:** one first buy of 0.02 SOL per coin, capped at 1% of the coin's
real SOL reserve (the median early buy is ~0.01 SOL — the guardrail's
round-trip minimum). No adds: backtesting showed adds buy into launches that
already ran and lose money.

**Exits** (value = what selling now would pay after curve fees, minus one tx
fee; basis = cost including fees paid):

- Take-profit ladder: +15% → sell 50% of tokens; +75% → sell 50% of the
  remainder; +200% → sell everything.
- Hard stop: −10% vs basis → sell everything.
- Trailing stop: once the best value is +40% over basis, sell everything if
  value falls 20% below best.
- Max hold 240 slots; exit at once if the creator sells while held; exit if
  no trade for 90 slots; exit if net flow over the last 20 slots < −0.02 SOL.

**Determinism:** every decision is a pure function of the batches the harness
sends (slot numbers, reserves, trade tape). No clock, no randomness, no I/O,
no network calls. The bot is executed twice and both action logs must match
byte for byte — they do.

## Layout

- `main.ts` — wires the strategy into the replay shim.
- `strategy.ts` — all strategy logic (original code, written for this bounty).
- `vendor/makefun-bot.ts` — the kit's `agent-fun/replay/v2` SDK shim, copied
  byte-identical.
- `tests/strategy.test.mjs` — local unit tests (`node --test
  tests/strategy.test.mjs`): determinism, entry filters, take-profit ladder,
  hard stop, guardrail math.
- `.makefun/owner.json` — payout wallet for the entry.

## Local results (dev window)

- Unit tests: 9/9 pass.
- `grade-local --driver process`: net PnL **−0.051 SOL** with the tighter
  pre-final defaults (89 coins, win rate 16.9%, max drawdown 0.67%, 79
  qualifying round trips ≥ 0.01 SOL); the kit's pilot sniper baseline scores
  −0.468 SOL on the same window. Final defaults (looser entry for guardrail
  headroom in the 6-hour final window) re-graded before submission — see the
  submission report.

## License

MIT — see [LICENSE](LICENSE).
