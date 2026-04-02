# Veridex — On-Chain Leaderboard: Implementation Plan

## Project Overview

Veridex is a blockchain-based coding contest judging system. An organizer deploys a smart contract, registers participants and judges, assigns judges to specific participants, and judges submit scores across 3 criteria. Once all scoring is done, the organizer finalizes results — permanently locking the leaderboard on-chain.

> **Legend:** Tasks marked `[CORE]` are required by the original spec. Tasks marked `[+]` are enhancements that improve the product while staying true to the spec's intent.

---

## Current State

| File | Status |
|---|---|
| `contracts/Veridex.sol` | Skeleton — structs, events, modifiers, and function stubs defined but all bodies empty |
| `frontend/index.html` | Skeleton — HTML structure with placeholder comments, no real content |
| `frontend/app.js` | Skeleton — function stubs defined, all bodies empty |
| `frontend/style.css` | Exists (unknown state) |
| `frontend/config.js` | Exists — expected to hold contract address and ABI reference |
| `frontend/contractABI.json` | Exists — ABI file to be populated after contract compilation |

---

## Improvements Over Base Spec

Before diving into tasks, here is a summary of what gets added beyond the original requirements and why:

| Improvement | Why It Matters |
|---|---|
| Contest metadata on-chain (name, description) | The chain becomes a self-contained record — useful for disputes |
| Configurable scoring weights at deploy time | Different contests have different priorities; hardcoding 40/30/30 limits reuse |
| Score timestamps on every submission | Creates a full audit trail of when each evaluation happened |
| Contest phase state machine (Registration → Scoring → Finalized) | More precise than a single `isFinalized` bool; prevents registration during active scoring |
| Per-judge per-participant score queryable by anyone | Full public verifiability — anyone can check any judge's raw scores |
| `getFullLeaderboard()` batch view function | Reduces frontend RPC calls from O(n) to 1; better UX |
| Real-time event listeners in the frontend | Leaderboard and judge progress auto-update without manual refresh |
| Live weighted score preview in scoring modal | Judge sees the impact of their inputs before submitting |
| Participant view panel | Participants can track whether they've been evaluated yet |
| Toast notification system | Better UX than browser alerts for transaction feedback |
| Tie-breaking by problem solving score | Deterministic, fair ranking when totals are equal |
| Reject duplicate address registration | Prevents accidental double-registration bugs |

---

## Task Breakdown

---

### TASK 1 — Implement the Smart Contract (`contracts/Veridex.sol`)

**Description:**  
Fill in all empty modifier and function bodies. Also add the enhancements listed below — they require adding new state variables, a struct field, and a few new view functions on top of the existing skeleton.

---

#### 1.0 — `[+]` Add Contest Metadata and Config to State Variables

Add before existing state variables:

```solidity
string public contestName;
string public contestDescription;
uint256 public immutable weightProblemSolving;  // e.g. 40
uint256 public immutable weightCodeQuality;     // e.g. 30
uint256 public immutable weightEfficiency;      // e.g. 30
uint256 public contestStartTime;
```

Add to `Score` struct:
```solidity
uint256 submittedAt;  // block.timestamp when score was submitted
```

Add a contest phase enum:
```solidity
enum Phase { Registration, Scoring, Finalized }
Phase public phase;
```

Replace `isFinalized bool` usage with `phase == Phase.Finalized` checks.

#### 1.1 — `[CORE]` Implement Modifiers

- `onlyOrganizer`: revert `"Not organizer"` if `msg.sender != organizer`
- `onlyJudge`: revert `"Not a judge"` if `judges[msg.sender].walletAddress == address(0)`
- `notFinalized`: revert `"Contest is finalized"` if `phase == Phase.Finalized`
- `assignedJudge(judgeAddr, participantAddr)`: revert `"Not assigned to this participant"` if `assigned[judgeAddr][participantAddr] == false`

#### 1.2 — `[CORE]` + `[+]` Implement Constructor

```solidity
constructor(
    string memory _name,
    string memory _description,
    uint256 _wPS,
    uint256 _wCQ,
    uint256 _wEff
) {
    require(_wPS + _wCQ + _wEff == 100, "Weights must sum to 100");
    organizer = msg.sender;
    contestName = _name;
    contestDescription = _description;
    weightProblemSolving = _wPS;
    weightCodeQuality = _wCQ;
    weightEfficiency = _wEff;
    contestStartTime = block.timestamp;
    phase = Phase.Registration;
}
```

#### 1.3 — `[CORE]` + `[+]` Implement `registerParticipant`

- Revert `"Already registered"` if `participants[_addr].walletAddress != address(0)`
- Revert `"Only during Registration phase"` if `phase != Phase.Registration`
- Store participant, push to list, emit event

#### 1.4 — `[CORE]` + `[+]` Implement `registerJudge`

- Same duplicate check and phase guard as above
- Store judge, push to list, emit event

#### 1.5 — `[CORE]` + `[+]` Implement `assignParticipantsToJudge`

- Revert if judge not registered
- `[+]` Revert if any participant in the array is not registered (`"Participant not registered"`)
- `[+]` Revert if participant already assigned to this judge (`"Already assigned"`)
- `[+]` On first assignment call: transition `phase` to `Phase.Scoring` (locks registration)
- Set `assigned` mapping and push to judge's `assignedParticipants`
- `[+]` Emit a new `ParticipantAssigned(judgeAddr, participantAddr)` event

#### 1.6 — `[CORE]` + `[+]` Implement `submitScore`

- Revert if `scores[msg.sender][_participantAddr].submitted` is true (`"Score already submitted"`)
- `[+]` Validate each criterion is between 0 and 100 (`"Score out of range"`)
- Call `calculateWeightedScore` and store weighted result
- `[+]` Store `submittedAt: block.timestamp` on the Score struct
- Mark `submitted = true`, increment `submissionCount`
- `[+]` Add to participant's running `totalScore` (sum — display as average on frontend)
- Increment participant's `evaluatedCount`
- Emit `ScoreSubmitted`

#### 1.7 — `[CORE]` + `[+]` Implement `calculateWeightedScore`

```solidity
function calculateWeightedScore(uint256 _p, uint256 _c, uint256 _e) 
    internal view returns (uint256) {
    return (_p * weightProblemSolving + _c * weightCodeQuality + _e * weightEfficiency) / 100;
}
```

Uses configurable weights instead of hardcoded values.

#### 1.8 — `[CORE]` Implement `finalizeResults`

- Revert if `!allJudgesCompleted()` (`"Not all judges have submitted"`)
- Set `phase = Phase.Finalized`
- Emit `ContestFinalized`

#### 1.9 — `[CORE]` + `[+]` Implement `getLeaderboard`

- Return `participantList` sorted descending by `totalScore`
- `[+]` Tie-break: if two participants have equal `totalScore`, rank the one with higher average `problemSolving` score first
- Implement as an in-memory bubble sort on a copy (do not mutate `participantList`)

#### 1.10 — `[CORE]` Implement `getParticipantScore`

- Return `(problemSolving, codeQuality, efficiency, totalScore)` for a given address
- These are the stored sums; frontend divides by `evaluatedCount` to show averages

#### 1.11 — `[CORE]` Implement `getJudgeProgress`

- Return `(submissionCount, assignedParticipants.length)`

#### 1.12 — `[CORE]` Implement `getAllJudgeProgress`

- Return three parallel arrays: judge addresses, submitted counts, assigned counts

#### 1.13 — `[CORE]` Implement `isFullyEvaluated`

- Return `allJudgesCompleted()`

#### 1.14 — `[CORE]` Implement `hasJudgeCompleted`

- Return `judges[_judge].submissionCount == judges[_judge].assignedParticipants.length`

#### 1.15 — `[CORE]` Implement `allJudgesCompleted`

- Return false if any judge in `judgeList` has not completed; true otherwise

#### 1.16 — `[+]` Add `getFullLeaderboard()` Batch View

```solidity
function getFullLeaderboard() public view returns (
    address[] memory addrs,
    string[] memory names,
    uint256[] memory totalScores,
    uint256[] memory evaluatedCounts
)
```

Returns everything the leaderboard table needs in a single RPC call. Internally calls `getLeaderboard()` for the sorted order, then loops once to collect all fields.

#### 1.17 — `[+]` Add `getScoreByJudge(address judge, address participant)` View

Returns the raw `Score` struct for any judge/participant pair. Allows anyone to publicly verify an individual judge's evaluation — important for the transparency goal.

#### 1.18 — `[+]` Add `getContestInfo()` View

```solidity
function getContestInfo() public view returns (
    string memory name,
    string memory description,
    Phase currentPhase,
    uint256 startTime,
    uint256 participantCount,
    uint256 judgeCount
)
```

Single call to hydrate the frontend header/status bar.

---

### TASK 2 — Deploy on Ganache via Remix IDE

**Description:**  
Compile and deploy the finalized contract to a local Ganache blockchain and wire up the frontend config.

#### 2.1 — `[CORE]` Set up Ganache

- Launch Ganache, confirm `http://127.0.0.1:7545`
- Wallet assignments:
  - Wallet 0: Organizer
  - Wallet 1: Judge 1
  - Wallet 2: Judge 2
  - Wallet 3: Participant 1
  - Wallet 4: Participant 2
  - Wallet 5: Participant 3

#### 2.2 — `[CORE]` Configure MetaMask

- Add Ganache network (Chain ID: 1337, RPC: `http://127.0.0.1:7545`)
- Import all 6 wallets via private keys

#### 2.3 — `[CORE]` Compile in Remix

- Open `contracts/Veridex.sol`, compiler `^0.8.19`, compile clean

#### 2.4 — `[CORE]` + `[+]` Deploy from Remix

- Environment: Injected Provider – MetaMask, Organizer wallet active
- `[+]` Deploy with constructor args: contest name = `"Veridex Demo Contest"`, description = `"University Hackathon S1 2025"`, weights = `40, 30, 30`
- Copy deployed contract address

#### 2.5 — `[CORE]` Extract ABI and Update Config

- Copy ABI from Remix → `frontend/contractABI.json`
- Update `frontend/config.js`:
  ```js
  const CONTRACT_ADDRESS = "0x...";
  const NETWORK_NAME = "Ganache Local";
  ```

---

### TASK 3 — Implement the Frontend (`frontend/`)

**Description:**  
Fill in all function bodies in `app.js`, complete `index.html` panels, and style with `style.css`.

#### 3.1 — `[CORE]` `connectWallet`

- `eth_requestAccounts` → create provider/signer → store address
- Call `initContract()`, `detectRole()`, `updateUIPanels()`
- `[+]` Listen for `window.ethereum` `accountsChanged` event — re-detect role on wallet switch

#### 3.2 — `[CORE]` `initContract`

- `new ethers.Contract(CONTRACT_ADDRESS, window.contractABI, signer)`
- `[+]` Attach event listeners immediately after:
  - `contract.on("ScoreSubmitted", () => { updateJudgeProgress(); fetchAndRenderLeaderboard(); })`
  - `contract.on("ContestFinalized", () => { updateUIPanels(); fetchAndRenderLeaderboard(); })`

#### 3.3 — `[CORE]` + `[+]` `detectRole`

- Check organizer, judge list, participant list
- `[+]` If address matches a participant: set role to `"Participant"`
- Update `#roleBadge` with color coding per role

#### 3.4 — `[CORE]` + `[+]` Organizer Panel HTML

Inside `#organizerPanel`:
- Contest info bar: contest name, phase badge, start time
- Form: Register Participant
- Form: Register Judge
- Form: Assign Participants to Judge
- `[+]` Judge Progress Table (live, shows submitted/assigned/status per judge)
- `[+]` Pre-finalization checklist: shows all judges complete before enabling finalize
- Finalize Contest button (`#finalizeBtn`)

#### 3.5–3.8 — `[CORE]` Organizer Handlers

`handleRegisterParticipant`, `handleRegisterJudge`, `handleAssignParticipants`, `handleFinalizeContest` — call respective contract functions, await tx, show toast on success/error.

#### 3.9 — `[CORE]` + `[+]` Judge Panel HTML

Inside `#judgePanel`:
- Progress bar: `X of Y participants scored`
- Assigned participants table: Name | Address | Status (Scored / Pending) | Action button
- `[+]` Already-scored rows show a "Submitted" badge and the "Score" button is replaced with "View" (read-only)

#### 3.10 — `[CORE]` `fetchAssignedParticipants`

- Get judge struct, iterate assigned participants
- For each: fetch name, check if `scores[judgeAddr][participantAddr].submitted`
- Render table rows

#### 3.11 — `[CORE]` + `[+]` Score Modal HTML

Inside `#scoreModal`:
- Participant name and address
- Three sliders (0–100) for Problem Solving, Code Quality, Efficiency with numeric input synced to each
- `[+]` Live weighted score preview: `"Weighted Score: XX / 100"` updates as inputs change
- Submit and Cancel buttons

#### 3.12 — `[CORE]` `openScoreModal`

- Populate participant details, show modal
- `[+]` Attach `input` event listeners to all three sliders to call a `previewWeightedScore()` helper that calculates `(ps*w1 + cq*w2 + eff*w3)/100` using weights read from `contract.weightProblemSolving()` etc.

#### 3.13 — `[CORE]` `handleSubmitScore`

- Validate 0–100 range client-side before sending tx
- Call contract, await, close modal
- Re-render judge panel, fire toast notification

#### 3.14 — `[CORE]` Leaderboard Panel HTML

`#leaderboardTable` thead: Rank | Name | Prob. Solving | Code Quality | Efficiency | Weighted Total

#### 3.15 — `[CORE]` + `[+]` `fetchAndRenderLeaderboard`

- `[+]` Use `contract.getFullLeaderboard()` (single RPC call) instead of N individual calls
- If not finalized: show rankings with scores hidden (`"—"`) — display participant names and rank only
- After finalization: show full score breakdown
- `[+]` Top 3 rows get gold/silver/bronze medal icons
- `[+]` Clicking any row opens a score breakdown modal showing per-judge scores via `getScoreByJudge`

#### 3.16 — `[CORE]` `updateJudgeProgress`

- Call `contract.getAllJudgeProgress()`
- Render in organizer panel: Judge Name | Submitted | Total | Progress Bar | Status

#### 3.17 — `[CORE]` + `[+]` `displayError`

- Parse revert reason from MetaMask error object (`error.reason` or regex on `error.message`)
- `[+]` Map known revert strings to user-friendly messages:
  - `"Not organizer"` → `"Only the organizer can perform this action."`
  - `"Not assigned to this participant"` → `"You are not assigned to judge this participant."`
  - `"Score already submitted"` → `"You have already submitted a score for this participant."`
  - etc.
- Display as dismissible toast, not browser `alert()`

#### 3.18 — `[CORE]` + `[+]` `updateUIPanels`

- Show/hide panels based on role
- `[+]` Show a Participant panel when role is `"Participant"`: display their assigned judges and whether each has scored them yet (without revealing score pre-finalization)
- Enable `#finalizeBtn` only if `contract.allJudgesCompleted()` is true

#### 3.19 — `[CORE]` + `[+]` `style.css`

- Dark professional theme (deep navy / charcoal background, white text)
- Card layout for each panel
- `[+]` Progress bars for judge submission tracking
- `[+]` Medal icons for top 3 leaderboard positions (🥇🥈🥉 or SVG)
- `[+]` Animated status badge: pulsing yellow for "Scoring In Progress", solid green for "Finalized"
- `[+]` Toast notification stack (bottom-right corner, auto-dismiss after 4s)
- Role-colored badge: Organizer (purple), Judge (blue), Participant (teal), Public (grey)
- Modal overlay with backdrop blur
- Responsive: usable on tablets (min 768px)

#### 3.20 — `[+]` Add Toast Notification System

Add a small standalone `showToast(message, type)` function (`type`: `"success"` | `"error"` | `"info"`):
- Creates a div, appends to `#toastContainer`
- Auto-removes after 4 seconds
- Used everywhere instead of `alert()`

#### 3.21 — `[+]` Add Score Breakdown Modal (Leaderboard View)

When a leaderboard row is clicked post-finalization:
- Show a modal: `"Score Breakdown for [Name]"`
- Table: Judge Address | Problem Solving | Code Quality | Efficiency | Weighted | Submitted At
- Data fetched via `getScoreByJudge` for each judge in `judgeList`
- Makes the "fully verifiable scoring" claim actually demonstrable

---

### TASK 4 — Testing on Ganache (6 Wallets)

**Description:**  
Execute full end-to-end test demonstrating all required and additional rejection scenarios.

#### 4.1 — `[CORE]` Happy Path Test

1. Organizer registers 3 participants and 2 judges
2. Assign: Judge 1 → P1, P2; Judge 2 → P3
3. Both judges submit all scores
4. Organizer finalizes
5. Leaderboard shows final ranked results with full score breakdown

#### 4.2 — `[CORE]` Rejection: Non-organizer registers

- Non-organizer wallet calls `registerParticipant` → revert `"Not organizer"`

#### 4.3 — `[CORE]` Rejection: Judge scores unassigned participant

- Judge 1 calls `submitScore` for Participant 3 → revert `"Not assigned to this participant"`

#### 4.4 — `[CORE]` Rejection: Double scoring

- Judge 1 submits for Participant 1, then tries again → revert `"Score already submitted"`

#### 4.5 — `[CORE]` Rejection: Finalize before all judges done

- Organizer calls `finalizeResults` while Judge 2 has not submitted → revert `"Not all judges have submitted"`

#### 4.6 — `[CORE]` Rejection: Score after finalization

- Any wallet calls `submitScore` after finalization → revert `"Contest is finalized"`

#### 4.7 — `[CORE]` Rejection: Non-judge submits score

- A participant wallet calls `submitScore` → revert `"Not a judge"`

#### 4.8 — `[+]` Rejection: Duplicate registration

- Organizer tries to register the same participant address twice → revert `"Already registered"`

#### 4.9 — `[+]` Rejection: Out-of-range score

- Judge submits a score with a criterion value of 101 → revert `"Score out of range"`

#### 4.10 — `[+]` Rejection: Assign unregistered participant

- Organizer calls `assignParticipantsToJudge` with an address not in `participantList` → revert `"Participant not registered"`

#### 4.11 — `[+]` Rejection: Register after scoring phase begins

- First assignment call locks phase to Scoring
- Organizer tries to register a new participant → revert `"Only during Registration phase"`

---

### TASK 5 — UI Polish and Demo Preparation

#### 5.1 — `[CORE]` Error Display

All revert reasons surface as readable toasts (handled in 3.17 and 3.20).

#### 5.2 — `[CORE]` Judge Progress Panel

Real-time table in organizer view: Judge | Submitted | Assigned | Status. Refreshes on `ScoreSubmitted` events.

#### 5.3 — `[CORE]` Score Breakdown Modal

Leaderboard row click opens per-judge score breakdown. Uses `getScoreByJudge` (added in 1.17).

#### 5.4 — `[CORE]` Finalization Lock Visual

`ContestFinalized` event triggers: status badge → green "FINALIZED", all input forms disabled, leaderboard scores revealed.

#### 5.5 — `[CORE]` + `[+]` Demo Script

Walkthrough order for live demonstration:
1. Show blank state — connect as Organizer, read `getContestInfo()`
2. Register 3 participants and 2 judges
3. Assign judges (observe phase transition to Scoring; verify registration is now locked — scenario 4.11)
4. Demo rejection scenarios: 4.2, 4.3, 4.7, 4.8, 4.9 — each one surfacing a readable toast
5. Judge 1 submits partial scores — show progress bar advance
6. Demo double-score rejection (4.4) and early finalization rejection (4.5)
7. Judge 1 and Judge 2 complete all scores
8. Organizer finalizes — leaderboard reveals with full breakdown
9. Demo post-finalization score rejection (4.6)
10. Click leaderboard rows to show per-judge audit trail

---

## File Responsibility Map

| File | Tasks |
|---|---|
| `contracts/Veridex.sol` | Task 1 (1.0–1.18) |
| `frontend/contractABI.json` | Task 2.5 |
| `frontend/config.js` | Task 2.5 |
| `frontend/index.html` | Task 3.4, 3.9, 3.11, 3.14, 3.21 |
| `frontend/app.js` | Task 3.1–3.21 |
| `frontend/style.css` | Task 3.19 |

---

## Scoring Formula

```
weightedScore = (problemSolving × wPS + codeQuality × wCQ + efficiency × wEff) / 100
```

Where `wPS + wCQ + wEff = 100` (enforced in constructor).  
Default deployment: `wPS = 40`, `wCQ = 30`, `wEff = 30`.

Scores are stored as **sums** on the participant struct. The frontend divides by `evaluatedCount` to display averages. This preserves raw data on-chain.

**Tie-breaking:** Equal `totalScore` → higher average problem solving score wins.

---

## Wallet Assignment for Testing

| Wallet Index | Role | Used For |
|---|---|---|
| 0 | Organizer | Deploy, register, assign, finalize |
| 1 | Judge 1 | Score Participants 1 and 2 |
| 2 | Judge 2 | Score Participant 3 |
| 3 | Participant 1 | Receives scores, views own status |
| 4 | Participant 2 | Receives scores |
| 5 | Participant 3 | Receives scores |

---

## Contract State Machine

```
Deploy
  │
  ▼
Registration ──(first assignment call)──► Scoring ──(organizer finalizes)──► Finalized
  │                                          │                                    │
  │  registerParticipant ✓                   │  submitScore ✓                     │  All reads ✓
  │  registerJudge ✓                         │  getLeaderboard ✓                  │  No writes ✗
  │  assignParticipants ✓                    │  getAllJudgeProgress ✓             │
  │  submitScore ✗                           │  registerParticipant ✗             │
```
