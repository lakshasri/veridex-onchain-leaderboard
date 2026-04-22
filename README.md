# Veridex — on-chain contest leaderboard

Transparent judging for hackathons, olympiads, and merit committees: assignments and scores are enforced on-chain, every judge sheet is immutable, and the organizer can lock the leaderboard only after **all** judges finish **all** of their assigned evaluations.

## What this repo contains

| Piece | Purpose |
|--------|---------|
| `contracts/ContestJudging.sol` | Solidity contract (Remix- and Hardhat-friendly) |
| `test/ContestJudging.test.js` | Thirteen Hardhat tests, including rejection paths |
| `frontend/` | Vite + React + TypeScript + ethers + MetaMask dashboard |
| `scripts/deploy.cjs` | Hardhat deploy helper (constructor: max score + three weights in bps) |
| `scripts/copy-abi.js` | Copies compiled ABI to `frontend/src/abi/` after `npm run compile` |

## Smart contract rules (summary)

- **Organizer** (deployer): registers participants and judges, sets judge→participant assignments, finalizes.
- **Judges** submit exactly three criteria per assigned participant: **problem solving**, **code quality**, **efficiency** (each `0 … maxPerCriterion`, default max `10`).
- **Weights** are fixed at deploy time as basis points that must sum to `10000` (default **40% / 35% / 25%**).
- **Aggregation**: per-judge weighted scores use a `1e18` scale; the leaderboard aggregate is the **average** of those sheets across judges who submitted for that participant.
- **Immutability**: a judge cannot overwrite a sheet; after **finalize**, no state changes are allowed (including the organizer).
- **Finalization** succeeds only when every registered judge has a submission for **every** participant they are assigned to (judges with zero assignments do not block).

Custom errors (reverts) cover non-organizer actions, unassigned scoring, duplicates, out-of-range scores, early finalization, and post-finalization mutations.

## Frontend dashboard

The UI is a single-page **glass-style** dashboard (sections in the top nav):

- **Overview** — KPI cards (global evaluation progress, your judge queue if applicable, weight configuration), **Judge fleet** (per-judge completion bars and slot dots), organizer finalization readiness when you connect as organizer.
- **Leaderboard** — Ranked **cards** with aggregate score (0–100), evaluation count, and **three capsule bars** for average raw scores per criterion; **Deep breakdown** table loads `participantBreakdown` for any participant address.
- **Operate** — Organizer console (register, assignments, finalize) when the connected wallet is the organizer; **Judge scoring** with **range sliders** (0–max per criterion), participant picker that **prioritizes pending** assigned slots.
- **On-chain audit** — Recent `ScoreSubmitted` and `Finalized` events from the last ~8k blocks (`queryFilter`); copy transaction hash or open a block explorer when the chain is mapped in code (extend `explorerTxUrl` in `frontend/src/App.tsx` for more networks).

Other details: **role chip** (Organizer / Judge / Participant / Observer), **Copy address** for the contract, periodic refresh, and `VITE_CHAIN_IDS` for local networks.

### Run the frontend

```bash
# Repo root: compile and copy ABI into the frontend
npm install
npm run compile   # postcompile copies ABI → frontend/src/abi/ContestJudging.json

cd frontend
npm install
npm run dev
```

Open the URL Vite prints (e.g. `http://127.0.0.1:5173/`). Paste the deployed contract address, click **Load**, connect MetaMask on the **same chain**.

### Environment variables (`frontend/.env`)

```env
# Comma-separated chain IDs MetaMask may use for Ganache / Hardhat
VITE_CHAIN_IDS=1337,31337,5777
```

## Remix + Ganache + MetaMask (recommended class demo)

1. Start **Ganache** and note the RPC URL and chain ID (often `5777` or `1337`; add the network in MetaMask).
2. Open [Remix](https://remix.ethereum.org), create `ContestJudging.sol`, paste from `contracts/ContestJudging.sol`.
3. **Compiler**: Solidity `0.8.20`, enable the optimizer, and enable **via IR** (avoids “stack too deep” without IR).
4. **Deploy** → **Injected Provider — MetaMask** (organizer account).
5. **Constructor** (example): `10, 4000, 3500, 2500` — max `10` per criterion; weights 40% / 35% / 25% in basis points.
6. Import **six** Ganache accounts in MetaMask: **1 organizer**, **2 judges**, **3 participants**.
7. From the organizer account, call `registerParticipant`, `registerJudge`, `setAssignment`; switch to each judge and call `submitScore`; finish with `finalize` from the organizer.
8. **Rejection demos**: score an unassigned participant, submit twice for the same pair, use a score above max, call `finalize` early, or call mutating functions after finalize — each should **revert**.

## Hardhat (compile, test, local deploy)

| Script | Command |
|--------|---------|
| Compile + copy ABI | `npm run compile` |
| Tests | `npm test` |
| Local JSON-RPC node | `npx hardhat node` |
| Deploy to localhost | `npm run deploy:local` |

Hardhat’s default signers map to **1 organizer + 2 judges + 3 participants + 1 outsider** in the tests.

**Compiler**: `hardhat.config.cjs` uses `viaIR: true` for the same stack-depth reason as Remix.

### Deploy to a local node

Terminal A:

```bash
npx hardhat node
```

Terminal B:

```bash
npm run deploy:local
```

Import a funded key from the node output into MetaMask, use chain ID **31337**, and paste the printed contract address into the frontend.

## Where transparency matters

University hackathons, national coding olympiads, and scholarship committees benefit when rules, assignments, and scores are **publicly auditable** and **frozen** after sign-off—reducing silent edits and disputed totals.

## License

MIT
