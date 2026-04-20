import { useCallback, useEffect, useMemo, useState } from "react";
import { BrowserProvider, ContractTransactionResponse, EventLog, JsonRpcProvider, isAddress } from "ethers";
import { contestAt, scaledToPercent100, shortAddr } from "./lib/contest";

const LS_KEY = "veridex_contract_address";
const DEFAULT_CHAIN_IDS = [1337, 31337, 5777];

type Section = "overview" | "leaderboard" | "operate" | "audit";

type BoardRow = {
  addr: string;
  agg: bigint;
  evals: bigint;
  rank: number;
  avgPs: number;
  avgCq: number;
  avgEf: number;
};

type JudgeStat = {
  addr: string;
  done: bigint;
  total: bigint;
};

type AuditEntry =
  | {
      kind: "score";
      blockNumber: number;
      txHash: string;
      judge: string;
      participant: string;
      ps: number;
      cq: number;
      ef: number;
    }
  | {
      kind: "finalize";
      blockNumber: number;
      txHash: string;
      organizer: string;
      timestamp: bigint;
    };

function parseChainIds(): number[] {
  const raw = import.meta.env.VITE_CHAIN_IDS;
  if (!raw) return DEFAULT_CHAIN_IDS;
  return raw.split(",").map((s: string) => Number(s.trim())).filter(Boolean);
}

function sanitizeError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const low = msg.toLowerCase();
  if (low.includes("user rejected") || low.includes("action_rejected")) return "Transaction rejected.";
  if (low.includes("insufficient funds")) return "Insufficient funds for gas.";
  if (low.includes("-32002") || low.includes("too many errors")) {
    return "RPC endpoint is temporarily rate-limited. Ensure MetaMask RPC is http://127.0.0.1:8545, switch network away and back, wait 30s, then retry Load.";
  }
  if (low.includes("missing revert data") || low.includes("call_exception")) {
    return "Could not read this contract. Check that the address is deployed on the selected chain and matches ContestJudging.";
  }
  const revertMatch = msg.match(/reason="([^"]+)"/) ?? msg.match(/reverted with reason string '([^']+)'/);
  if (revertMatch) return `Reverted: ${revertMatch[1]}`;
  if (low.includes("execution reverted")) return "Transaction reverted by contract.";
  return msg.split("\n")[0].slice(0, 200);
}

function explorerTxUrl(chainId: number, txHash: string): string | null {
  const map: Record<number, string> = {
    1: "https://etherscan.io/tx/",
    5: "https://goerli.etherscan.io/tx/",
    10: "https://optimistic.etherscan.io/tx/",
    56: "https://bscscan.com/tx/",
    100: "https://gnosisscan.io/tx/",
    137: "https://polygonscan.com/tx/",
    250: "https://ftmscan.com/tx/",
    420: "https://goerli-optimism.etherscan.io/tx/",
    8453: "https://basescan.org/tx/",
    42161: "https://arbiscan.io/tx/",
    43114: "https://snowtrace.io/tx/",
    59144: "https://lineascan.build/tx/",
    80001: "https://mumbai.polygonscan.com/tx/",
    80002: "https://amoy.polygonscan.com/tx/",
    84532: "https://sepolia.basescan.org/tx/",
    421614: "https://sepolia.arbiscan.io/tx/",
    11155111: "https://sepolia.etherscan.io/tx/",
    11155420: "https://sepolia-optimism.etherscan.io/tx/",
  };
  const base = map[chainId];
  return base ? base + txHash : null;
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    /* ignore */
  }
}

declare global {
  interface Window {
    ethereum?: {
      request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
      on: (ev: string, handler: (...args: unknown[]) => void) => void;
      removeListener?: (ev: string, handler: (...args: unknown[]) => void) => void;
    };
  }
}

export default function App() {
  const chainIds = useMemo(parseChainIds, []);
  const rpcUrl = import.meta.env.VITE_RPC_URL || "http://127.0.0.1:8545";
  const [section, setSection] = useState<Section>("overview");
  const [contractAddrInput, setContractAddrInput] = useState(() => localStorage.getItem(LS_KEY) || "");
  const [activeContract, setActiveContract] = useState(() => localStorage.getItem(LS_KEY) || "");
  const [account, setAccount] = useState<string | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [organizer, setOrganizer] = useState<string | null>(null);
  const [finalized, setFinalized] = useState(false);
  const [maxCrit, setMaxCrit] = useState<number>(0);
  const [weights, setWeights] = useState<{ ps: bigint; cq: bigint; ef: bigint } | null>(null);
  const [participants, setParticipants] = useState<string[]>([]);
  const [judges, setJudges] = useState<string[]>([]);
  const [globalProg, setGlobalProg] = useState<{ done: bigint; total: bigint }>({ done: 0n, total: 0n });
  const [judgeProg, setJudgeProg] = useState<{ done: bigint; total: bigint }>({ done: 0n, total: 0n });
  const [judgeStats, setJudgeStats] = useState<JudgeStat[]>([]);
  const [board, setBoard] = useState<BoardRow[]>([]);
  const [canFin, setCanFin] = useState(false);
  const [auditLog, setAuditLog] = useState<AuditEntry[]>([]);
  const [pendingForJudge, setPendingForJudge] = useState<string[]>([]);

  const [regP, setRegP] = useState("");
  const [regJ, setRegJ] = useState("");
  const [asgJudge, setAsgJudge] = useState("");
  const [asgPart, setAsgPart] = useState("");
  const [asgOn, setAsgOn] = useState(true);

  const [scorePart, setScorePart] = useState("");
  const [sPs, setSPs] = useState(8);
  const [sCq, setSCq] = useState(7);
  const [sEf, setSEf] = useState(9);

  const [breakdownPart, setBreakdownPart] = useState("");
  const [breakdownRows, setBreakdownRows] = useState<
    { judge: string; sub: boolean; ps: number; cq: number; ef: number; w: bigint }[]
  >([]);

  const chainOk = chainId != null && chainIds.includes(chainId);
  const provider = useMemo(() => {
    if (!window.ethereum) return null;
    return new BrowserProvider(window.ethereum);
  }, [account]);
  const readProvider = useMemo(() => new JsonRpcProvider(rpcUrl), [rpcUrl]);

  const connectWallet = async () => {
    setErr(null);
    if (!window.ethereum) {
      setErr("Install MetaMask to connect.");
      return;
    }
    const prov = new BrowserProvider(window.ethereum);
    const accs = (await prov.send("eth_requestAccounts", [])) as string[];
    setAccount(accs[0] ?? null);
    const net = await prov.getNetwork();
    setChainId(Number(net.chainId));
  };

  const disconnectWallet = () => {
    setAccount(null);
    setChainId(null);
  };

  useEffect(() => {
    if (!window.ethereum) return;
    const eth = window.ethereum;
    const onAccounts = (accs: unknown) => {
      if (!Array.isArray(accs)) return;
      const first = accs[0];
      setAccount(typeof first === "string" ? first : null);
    };
    const onChain = (cid: unknown) => {
      if (typeof cid !== "string" && typeof cid !== "number") return;
      const parsed = Number(cid);
      if (Number.isFinite(parsed)) setChainId(parsed);
    };
    eth.on("accountsChanged", onAccounts);
    eth.on("chainChanged", onChain);

    (async () => {
      try {
        const prov = new BrowserProvider(eth);
        const accs = (await prov.send("eth_accounts", [])) as string[];
        if (accs.length > 0) {
          setAccount(accs[0]);
          const net = await prov.getNetwork();
          setChainId(Number(net.chainId));
        }
      } catch {
        /* user not connected yet */
      }
    })();

    return () => {
      eth.removeListener?.("accountsChanged", onAccounts);
      eth.removeListener?.("chainChanged", onChain);
    };
  }, []);

  const loadContract = () => {
    const v = contractAddrInput.trim();
    if (!isAddress(v)) {
      setErr("Enter a valid contract address.");
      return;
    }
    localStorage.setItem(LS_KEY, v);
    setActiveContract(v);
    setErr(null);
  };

  const refresh = useCallback(async () => {
    if (!activeContract || !isAddress(activeContract) || !chainOk) return;
    setErr(null);
    try {
      const code = await readProvider.getCode(activeContract);
      if (!code || code === "0x") {
        setOrganizer(null);
        setFinalized(false);
        setMaxCrit(0);
        setWeights(null);
        setParticipants([]);
        setJudges([]);
        setGlobalProg({ done: 0n, total: 0n });
        setJudgeProg({ done: 0n, total: 0n });
        setJudgeStats([]);
        setBoard([]);
        setCanFin(false);
        setAuditLog([]);
        setPendingForJudge([]);
        setBreakdownRows([]);
        const cid = chainId ?? "unknown";
        setErr(
          `No contract is deployed at ${activeContract} on chain ID ${cid}. Deploy with npm run deploy:local and load the printed address.`
        );
        return;
      }

      const ro = contestAt(activeContract, readProvider);
      const [org, fin, mx, wps, wcq, wef, pc, jc] = await Promise.all([
        ro.organizer(),
        ro.finalized(),
        ro.maxPerCriterion(),
        ro.weightProblemSolvingBps(),
        ro.weightCodeQualityBps(),
        ro.weightEfficiencyBps(),
        ro.participantCount(),
        ro.judgeCount(),
      ]);
      const orgLc = String(org).toLowerCase();
      setOrganizer(orgLc);
      setFinalized(Boolean(fin));
      const maxC = Number(mx);
      setMaxCrit(maxC);
      setWeights({ ps: BigInt(wps.toString()), cq: BigInt(wcq.toString()), ef: BigInt(wef.toString()) });

      const pn = Number(pc);
      const jn = Number(jc);
      const ps: string[] = [];
      const js: string[] = [];
      for (let i = 0; i < pn; i++) ps.push(String(await ro.getParticipant(i)).toLowerCase());
      for (let i = 0; i < jn; i++) js.push(String(await ro.getJudge(i)).toLowerCase());
      setParticipants(ps);
      setJudges(js);

      const gp = await ro.globalEvaluationProgress();
      setGlobalProg({ done: BigInt(gp[0].toString()), total: BigInt(gp[1].toString()) });

      const ld = await ro.leaderboardData();
      if (!Array.isArray(ld) || ld.length < 3 || !Array.isArray(ld[0]) || !Array.isArray(ld[1]) || !Array.isArray(ld[2])) {
        throw new Error("Unexpected leaderboard data shape from contract.");
      }
      const addrs = ld[0] as string[];
      const aggs = ld[1] as bigint[];
      const ecs = ld[2] as bigint[];

      const enriched: BoardRow[] = await Promise.all(
        addrs.map(async (a, i) => {
          const addr = String(a).toLowerCase();
          const pa = await ro.participantAggregate(addr);
          const evalCount = Number(pa[1]);
          const sumPs = Number(pa[2]);
          const sumCq = Number(pa[3]);
          const sumEf = Number(pa[4]);
          const avgPs = evalCount ? sumPs / evalCount / maxC : 0;
          const avgCq = evalCount ? sumCq / evalCount / maxC : 0;
          const avgEf = evalCount ? sumEf / evalCount / maxC : 0;
          return {
            addr,
            agg: BigInt(aggs[i].toString()),
            evals: BigInt(ecs[i].toString()),
            rank: 0,
            avgPs,
            avgCq,
            avgEf,
          };
        })
      );
      enriched.sort((a, b) => (a.agg === b.agg ? 0 : a.agg < b.agg ? 1 : -1));
      enriched.forEach((r, i) => {
        r.rank = i + 1;
      });
      setBoard(enriched);

      const jRows: JudgeStat[] = await Promise.all(
        js.map(async (j) => {
          const pr = await ro.judgeEvaluationProgress(j);
          return {
            addr: j,
            done: BigInt(pr[0].toString()),
            total: BigInt(pr[1].toString()),
          };
        })
      );
      setJudgeStats(jRows);

      const cf = await ro.canFinalize();
      setCanFin(Boolean(cf));

      const accLc = account?.toLowerCase() ?? null;
      if (accLc) {
        const jp = await ro.judgeEvaluationProgress(accLc);
        setJudgeProg({ done: BigInt(jp[0].toString()), total: BigInt(jp[1].toString()) });

        const pend: string[] = [];
        for (const p of ps) {
          const assigned = await ro.isAssigned(accLc, p);
          if (!assigned) continue;
          const sheet = await ro.scores(accLc, p);
          const submitted = Boolean(sheet[0]);
          if (!submitted) pend.push(p);
        }
        setPendingForJudge(pend);
        setScorePart((prev) => {
          if (pend.length === 0) return prev;
          if (prev && pend.includes(prev)) return prev;
          return pend[0];
        });
      } else {
        setJudgeProg({ done: 0n, total: 0n });
        setPendingForJudge([]);
      }

      try {
        const latest = await readProvider.getBlockNumber();
        const span = 8000;
        const from = latest > span ? latest - span : 0;
        const [scoreEvs, finEvs] = await Promise.all([
          ro.queryFilter(ro.filters.ScoreSubmitted(), from, latest),
          ro.queryFilter(ro.filters.Finalized(), from, latest),
        ]);
        const items: AuditEntry[] = [];
        for (const log of scoreEvs) {
          if (!(log instanceof EventLog)) continue;
          const a = log.args;
          items.push({
            kind: "score",
            blockNumber: log.blockNumber,
            txHash: log.transactionHash,
            judge: String(a.judge).toLowerCase(),
            participant: String(a.participant).toLowerCase(),
            ps: Number(a.problemSolving),
            cq: Number(a.codeQuality),
            ef: Number(a.efficiency),
          });
        }
        for (const log of finEvs) {
          if (!(log instanceof EventLog)) continue;
          const a = log.args;
          items.push({
            kind: "finalize",
            blockNumber: log.blockNumber,
            txHash: log.transactionHash,
            organizer: String(a.organizer).toLowerCase(),
            timestamp: BigInt(a.timestamp.toString()),
          });
        }
        items.sort((x, y) => y.blockNumber - x.blockNumber || y.txHash.localeCompare(x.txHash));
        setAuditLog(items.slice(0, 48));
      } catch {
        setAuditLog([]);
      }
    } catch (e) {
      setErr(sanitizeError(e));
    }
  }, [readProvider, activeContract, chainOk, account, chainId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 14000);
    return () => clearInterval(t);
  }, [refresh]);

  const signerAccount = account?.toLowerCase() ?? null;
  const isOrganizer = Boolean(signerAccount && organizer && signerAccount === organizer);
  const isJudge = Boolean(signerAccount && judges.includes(signerAccount));
  const isParticipantWallet = Boolean(signerAccount && participants.includes(signerAccount));

  const roleLabel = !signerAccount
    ? "Guest"
    : isOrganizer
      ? "Organizer"
      : isJudge
        ? "Judge"
        : isParticipantWallet
          ? "Participant"
          : "Observer";

  const runTx = async (p: Promise<ContractTransactionResponse>) => {
    setBusy(true);
    setErr(null);
    try {
      const tx = await p;
      await tx.wait();
      await refresh();
    } catch (e) {
      setErr(sanitizeError(e));
    } finally {
      setBusy(false);
    }
  };

  const loadBreakdown = async () => {
    if (!activeContract || !isAddress(breakdownPart)) {
      setErr("Enter a valid participant address for breakdown.");
      return;
    }
    setErr(null);
    try {
      const ro = contestAt(activeContract, readProvider);
      const bd = await ro.participantBreakdown(breakdownPart.trim());
      const judgesOut = bd[0] as string[];
      const flags = bd[1] as boolean[];
      const ps = bd[2] as bigint[];
      const cq = bd[3] as bigint[];
      const ef = bd[4] as bigint[];
      const ws = bd[5] as bigint[];
      const rows = judgesOut.map((j, i) => ({
        judge: String(j).toLowerCase(),
        sub: Boolean(flags[i]),
        ps: Number(ps[i]),
        cq: Number(cq[i]),
        ef: Number(ef[i]),
        w: BigInt(ws[i].toString()),
      }));
      setBreakdownRows(rows);
    } catch (e) {
      setErr(sanitizeError(e));
    }
  };

  const pctGlobal =
    globalProg.total === 0n ? 0 : Number((globalProg.done * 10000n) / globalProg.total) / 100;
  const pctJudge =
    judgeProg.total === 0n ? 0 : Number((judgeProg.done * 10000n) / judgeProg.total) / 100;

  const nav = (s: Section) => (
    <button type="button" className={section === s ? "is-active" : ""} onClick={() => setSection(s)}>
      {s === "overview" && "Overview"}
      {s === "leaderboard" && "Leaderboard"}
      {s === "operate" && "Operate"}
      {s === "audit" && "On-chain audit"}
    </button>
  );

  return (
    <div className={`app-shell${finalized ? " app-shell--finalized" : ""}`}>
      <div className="mesh-bg" aria-hidden />

      <header className="top-bar">
        <div className="brand">
          <div className="brand-mark">
            <img src="/logo.png" alt="Veridex" />
          </div>
          <div className="brand-text">
            <h1>Veridex</h1>
            <span>On-chain contest judging</span>
          </div>
        </div>

        <nav className="nav-pills" aria-label="Sections">
          {nav("overview")}
          {nav("leaderboard")}
          {nav("operate")}
          {nav("audit")}
        </nav>

        <div className="header-actions">
          {finalized ? (
            <span className="status-pill status-pill--locked">Finalized · immutable</span>
          ) : (
            <span className="status-pill status-pill--live">Live contest</span>
          )}
          {account && (
            <span className="role-chip" title="Role is display-only; all actions are enforced on-chain">
              {roleLabel}
            </span>
          )}
          {account ? (
            <>
              <span className="wallet-address">{shortAddr(account)}</span>
              <button type="button" className="btn btn--ghost" onClick={disconnectWallet} disabled={busy}>
                Sign out
              </button>
            </>
          ) : (
            <button type="button" className="btn btn--primary" onClick={() => void connectWallet()} disabled={busy}>
              Connect wallet
            </button>
          )}
        </div>
      </header>

      <section className="hero">
        <h2>Transparent scores, enforced assignments, permanent results.</h2>
        <p>
          Every judge sheet is written immutably on-chain. The leaderboard aggregates weighted problem solving, code quality,
          and efficiency—then locks forever once the organizer finalizes after all assigned evaluations complete.
        </p>
      </section>

      {chainId != null && !chainOk && (
        <div className="network-banner">
          Chain ID <span className="mono">{chainId}</span> is not allowed ({chainIds.join(", ")}). Add your local network in
          MetaMask or set <span className="mono">VITE_CHAIN_IDS</span> in <span className="mono">frontend/.env</span>.
        </div>
      )}

      <div className="glass">
        <h3 className="section-title">
          Contract <span className="tag">Connect</span>
        </h3>
        <div className="input-row">
          <input
            className="contract-input"
            type="text"
            placeholder="0x… deployed ContestJudging"
            value={contractAddrInput}
            onChange={(e) => setContractAddrInput(e.target.value)}
          />
          <button type="button" className="btn btn--primary" onClick={loadContract} disabled={busy}>
            Load
          </button>
          <button type="button" className="btn" onClick={() => void refresh()} disabled={busy || !activeContract}>
            Sync
          </button>
          {activeContract && (
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => void copyText(activeContract)}>
              Copy address
            </button>
          )}
        </div>
        {activeContract && (
          <p className="mono" style={{ margin: "0.65rem 0 0", opacity: 0.85, wordBreak: "break-all" }}>
            {activeContract}
          </p>
        )}
        {err && <p className="err">{err}</p>}
      </div>

      <div id="overview" className={section === "overview" ? "" : "section-hidden"}>
        {activeContract && chainOk && weights && (
          <>
            <div className="stats-grid">
              <div className="stat-card">
                <div className="stat-label">Evaluation progress</div>
                <div className="stat-value">{pctGlobal.toFixed(1)}%</div>
                <div className="stat-sub">
                  {globalProg.done.toString()} / {globalProg.total.toString()} assigned slots on-chain
                </div>
                <div className="capsule-track" style={{ marginTop: "0.65rem" }}>
                  <div className="capsule-fill capsule-fill--ps" style={{ width: `${Math.min(100, pctGlobal)}%` }} />
                </div>
              </div>
              <div className="stat-card stat-card--mint">
                <div className="stat-label">Your queue</div>
                <div className="stat-value">
                  {judgeProg.total === 0n ? "—" : `${judgeProg.done}/${judgeProg.total}`}
                </div>
                <div className="stat-sub">
                  {judgeProg.total === 0n
                    ? "Connect as a judge with assignments"
                    : `${pctJudge.toFixed(0)}% of your sheets submitted`}
                </div>
                {judgeProg.total > 0n && (
                  <div className="capsule-track" style={{ marginTop: "0.65rem" }}>
                    <div className="capsule-fill capsule-fill--ef" style={{ width: `${Math.min(100, pctJudge)}%` }} />
                  </div>
                )}
              </div>
              <div className="stat-card stat-card--coral">
                <div className="stat-label">Weights (bps)</div>
                <div className="stat-value" style={{ fontSize: "1.25rem" }}>
                  {weights.ps.toString()} / {weights.cq.toString()} / {weights.ef.toString()}
                </div>
                <div className="stat-sub">Problem solving · Code quality · Efficiency · max {maxCrit} pts each</div>
              </div>
            </div>

            <div className="glass">
              <h3 className="section-title">
                Judge fleet <span className="tag">Live</span>
              </h3>
              <p style={{ margin: "0 0 1rem", color: "var(--text-soft)", fontSize: "0.88rem" }}>
                Per-judge completion across all assigned participants—mirrors how enterprise dashboards surface owner accountability.
              </p>
              {judgeStats.length === 0 ? (
                <p style={{ color: "var(--text-soft)", margin: 0 }}>No judges registered yet.</p>
              ) : (
                <div className="judge-fleet">
                  {judgeStats.map((j) => {
                    const pct =
                      j.total === 0n ? 0 : Number((j.done * 10000n) / j.total) / 100;
                    const nDots = Math.min(Number(j.total), 14);
                    const filled =
                      j.total === 0n ? 0 : Math.round((Number(j.done) / Number(j.total)) * nDots);
                    return (
                      <div key={j.addr} className="judge-card">
                        <div className="judge-card-head">
                          <div>
                            <div className="field-label" style={{ marginBottom: "0.15rem" }}>
                              Judge
                            </div>
                            <div className="judge-addr">{j.addr}</div>
                          </div>
                          <div className="judge-pct">{pct.toFixed(0)}%</div>
                        </div>
                        <div className="capsule-track">
                          <div className="capsule-fill capsule-fill--cq" style={{ width: `${Math.min(100, pct)}%` }} />
                        </div>
                        <div className="mini-dots" title={`${j.done}/${j.total} evaluations`}>
                          {Array.from({ length: nDots }, (_, i) => (
                            <span key={i} className={`mini-dot${i < filled ? " mini-dot--on" : ""}`} />
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {isOrganizer && (
              <div className="glass">
                <h3 className="section-title">Organizer signal</h3>
                <p style={{ margin: 0, color: "var(--text-soft)", fontSize: "0.9rem" }}>
                  Finalize unlocks only when <strong style={{ color: "var(--text)" }}>every assigned slot</strong> has a
                  submission. Currently:{" "}
                  <strong style={{ color: canFin ? "var(--mint)" : "var(--coral)" }}>
                    {canFin ? "Ready to finalize" : "Waiting on judges"}
                  </strong>
                  .
                </p>
              </div>
            )}
          </>
        )}
      </div>

      <div id="leaderboard" className={section === "leaderboard" ? "" : "section-hidden"}>
        {activeContract && chainOk && (
          <div className="glass">
            <h3 className="section-title">
              Leaderboard
              {finalized ? (
                <span className="tag" style={{ background: "var(--mint-dim)", color: "var(--mint)" }}>
                  Verified lock
                </span>
              ) : (
                <span className="tag">Provisional</span>
              )}
            </h3>
            <p style={{ margin: "0 0 1rem", color: "var(--text-soft)", fontSize: "0.88rem" }}>
              Rankings by weighted aggregate (0–100). Bars show average raw scores across judges for each criterion.
            </p>
            <div className="leader-grid">
              {board.map((r) => (
                <div key={r.addr} className={`leader-card${r.rank <= 3 ? " leader-card--top" : ""}`}>
                  <div className="rank-badge">{r.rank}</div>
                  <div>
                    <div className="mono" style={{ fontWeight: 600, marginBottom: "0.35rem" }}>
                      {r.addr}
                    </div>
                    <div className="capsule-row">
                      <div className="capsule-label">
                        <span>Problem solving</span>
                        <span>{(r.avgPs * 100).toFixed(0)}%</span>
                      </div>
                      <div className="capsule-track">
                        <div className="capsule-fill capsule-fill--ps" style={{ width: `${r.avgPs * 100}%` }} />
                      </div>
                      <div className="capsule-label">
                        <span>Code quality</span>
                        <span>{(r.avgCq * 100).toFixed(0)}%</span>
                      </div>
                      <div className="capsule-track">
                        <div className="capsule-fill capsule-fill--cq" style={{ width: `${r.avgCq * 100}%` }} />
                      </div>
                      <div className="capsule-label">
                        <span>Efficiency</span>
                        <span>{(r.avgEf * 100).toFixed(0)}%</span>
                      </div>
                      <div className="capsule-track">
                        <div className="capsule-fill capsule-fill--ef" style={{ width: `${r.avgEf * 100}%` }} />
                      </div>
                    </div>
                    {finalized && r.evals > 0n && <div className="verify-badge">✓ Committed on-chain</div>}
                  </div>
                  <div className="leader-score">
                    <div className="leader-score-num">{scaledToPercent100(r.agg)}</div>
                    <div className="leader-score-label">Aggregate / 100</div>
                    <div className="stat-sub" style={{ marginTop: "0.35rem" }}>
                      {r.evals.toString()} evaluation{r.evals === 1n ? "" : "s"}
                    </div>
                  </div>
                </div>
              ))}
              {board.length === 0 && <p style={{ color: "var(--text-soft)" }}>No participants yet.</p>}
            </div>
          </div>
        )}

        {activeContract && chainOk && (
          <div className="glass">
            <h3 className="section-title">Deep breakdown</h3>
            <div className="input-row">
              <input
                type="text"
                placeholder="Participant 0x…"
                value={breakdownPart}
                onChange={(e) => setBreakdownPart(e.target.value)}
                style={{ flex: 1, minWidth: "200px" }}
              />
              <button type="button" className="btn btn--primary" onClick={() => void loadBreakdown()} disabled={busy}>
                Load judges
              </button>
            </div>
            {breakdownRows.length > 0 && (
              <div className="data-table-wrap" style={{ marginTop: "1rem" }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Judge</th>
                      <th>Status</th>
                      <th>PS</th>
                      <th>CQ</th>
                      <th>Eff</th>
                      <th>Weighted</th>
                    </tr>
                  </thead>
                  <tbody>
                    {breakdownRows.map((r) => (
                      <tr key={r.judge}>
                        <td className="mono">{r.judge}</td>
                        <td>{r.sub ? "Submitted" : "—"}</td>
                        <td>{r.sub ? r.ps : "—"}</td>
                        <td>{r.sub ? r.cq : "—"}</td>
                        <td>{r.sub ? r.ef : "—"}</td>
                        <td>{r.sub ? scaledToPercent100(r.w) : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>

      <div id="operate" className={section === "operate" ? "" : "section-hidden"}>
        {activeContract && chainOk && isOrganizer && (
          <div className="glass">
            <h3 className="section-title">
              Organizer console <span className="tag">Setup</span>
            </h3>
            <div className="form-grid">
              <div>
                <span className="field-label">Register participant</span>
                <div className="input-row">
                  <input type="text" value={regP} onChange={(e) => setRegP(e.target.value)} placeholder="0x…" />
                  <button
                    type="button"
                    className="btn btn--primary"
                    disabled={busy || finalized}
                    onClick={async () => {
                      const signer = await provider!.getSigner();
                      void runTx(contestAt(activeContract, signer).registerParticipant(regP.trim()));
                    }}
                  >
                    Add
                  </button>
                </div>
              </div>
              <div>
                <span className="field-label">Register judge</span>
                <div className="input-row">
                  <input type="text" value={regJ} onChange={(e) => setRegJ(e.target.value)} placeholder="0x…" />
                  <button
                    type="button"
                    className="btn btn--primary"
                    disabled={busy || finalized}
                    onClick={async () => {
                      const signer = await provider!.getSigner();
                      void runTx(contestAt(activeContract, signer).registerJudge(regJ.trim()));
                    }}
                  >
                    Add
                  </button>
                </div>
              </div>
            </div>
            <div style={{ marginTop: "1rem" }}>
              <span className="field-label">Assignment graph</span>
              <div className="input-row">
                <select value={asgJudge} onChange={(e) => setAsgJudge(e.target.value)} style={{ minWidth: "140px" }}>
                  <option value="">Judge</option>
                  {judges.map((j) => (
                    <option key={j} value={j}>
                      {shortAddr(j)}
                    </option>
                  ))}
                </select>
                <select value={asgPart} onChange={(e) => setAsgPart(e.target.value)} style={{ minWidth: "140px" }}>
                  <option value="">Participant</option>
                  {participants.map((p) => (
                    <option key={p} value={p}>
                      {shortAddr(p)}
                    </option>
                  ))}
                </select>
                <label className="input-row" style={{ alignItems: "center", gap: "0.35rem" }}>
                  <input type="checkbox" checked={asgOn} onChange={(e) => setAsgOn(e.target.checked)} />
                  <span style={{ fontSize: "0.85rem", color: "var(--text-soft)" }}>Assigned</span>
                </label>
                <button
                  type="button"
                  className="btn btn--primary"
                  disabled={busy || finalized || !asgJudge || !asgPart}
                  onClick={async () => {
                    const signer = await provider!.getSigner();
                    void runTx(contestAt(activeContract, signer).setAssignment(asgJudge, asgPart, asgOn));
                  }}
                >
                  Update edge
                </button>
              </div>
            </div>
            <div style={{ marginTop: "1.25rem" }}>
              <button
                type="button"
                className="btn btn--primary"
                disabled={busy || finalized || !canFin}
                onClick={async () => {
                  const signer = await provider!.getSigner();
                  void runTx(contestAt(activeContract, signer).finalize());
                }}
              >
                Finalize & lock leaderboard
              </button>
              {!canFin && !finalized && (
                <span style={{ marginLeft: "0.65rem", color: "var(--text-soft)", fontSize: "0.85rem" }}>
                  Blocked until all judges finish assigned work.
                </span>
              )}
            </div>
          </div>
        )}

        {activeContract && chainOk && account && (
          <div className="glass">
            <h3 className="section-title">
              Judge scoring <span className="tag">Immutable</span>
            </h3>
            <p style={{ margin: "0 0 1rem", color: "var(--text-soft)", fontSize: "0.88rem" }}>
              One submission per assigned participant. Sliders snap to whole points (0–{maxCrit}). The contract rejects
              unassigned targets, duplicates, overflow, and any post-finalize call.
            </p>
            <div style={{ marginBottom: "1rem" }}>
              <span className="field-label">Participant</span>
              <select
                value={scorePart}
                onChange={(e) => setScorePart(e.target.value)}
                style={{ width: "100%", maxWidth: "420px" }}
              >
                <option value="">Select participant…</option>
                {(pendingForJudge.length ? pendingForJudge : participants).map((p) => (
                  <option key={p} value={p}>
                    {shortAddr(p)}
                    {pendingForJudge.includes(p) ? " · pending" : ""}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-grid">
              <div className="slider-field">
                <div className="slider-head">
                  <span className="field-label" style={{ margin: 0 }}>
                    Problem solving
                  </span>
                  <span className="slider-val">{sPs}</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={maxCrit || 10}
                  value={sPs}
                  onChange={(e) => setSPs(Number(e.target.value))}
                />
              </div>
              <div className="slider-field">
                <div className="slider-head">
                  <span className="field-label" style={{ margin: 0 }}>
                    Code quality
                  </span>
                  <span className="slider-val">{sCq}</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={maxCrit || 10}
                  value={sCq}
                  onChange={(e) => setSCq(Number(e.target.value))}
                />
              </div>
              <div className="slider-field">
                <div className="slider-head">
                  <span className="field-label" style={{ margin: 0 }}>
                    Efficiency
                  </span>
                  <span className="slider-val">{sEf}</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={maxCrit || 10}
                  value={sEf}
                  onChange={(e) => setSEf(Number(e.target.value))}
                />
              </div>
            </div>
            <button
              type="button"
              className="btn btn--primary"
              style={{ marginTop: "1.15rem" }}
              disabled={busy || finalized || !scorePart}
              onClick={async () => {
                if (!provider || !account) return;
                const signer = await provider.getSigner();
                void runTx(contestAt(activeContract, signer).submitScore(scorePart.trim(), sPs, sCq, sEf));
              }}
            >
              Sign & submit score
            </button>
          </div>
        )}

        {activeContract && chainOk && !isOrganizer && !account && (
          <div className="glass">
            <p style={{ margin: 0, color: "var(--text-soft)" }}>Connect a wallet to judge or use the organizer account for setup.</p>
          </div>
        )}
      </div>

      <div id="audit" className={section === "audit" ? "" : "section-hidden"}>
        {activeContract && chainOk && (
          <div className="glass">
            <h3 className="section-title">
              On-chain audit trail <span className="tag">Events</span>
            </h3>
            <p style={{ margin: "0 0 1rem", color: "var(--text-soft)", fontSize: "0.88rem" }}>
              Recent <span className="mono">ScoreSubmitted</span> and <span className="mono">Finalized</span> logs from the
              last ~8k blocks—each row is a permanent record you can verify against your RPC or block explorer.
            </p>
            <div className="audit-feed">
              {auditLog.length === 0 && <p style={{ color: "var(--text-soft)", margin: 0 }}>No events in range yet.</p>}
              {auditLog.map((e) => {
                const ex = chainId != null ? explorerTxUrl(chainId, e.txHash) : null;
                return (
                  <div
                    key={`${e.txHash}-${e.kind}`}
                    className={`audit-item${e.kind === "finalize" ? " audit-item--finalize" : ""}`}
                  >
                    <div>
                      {e.kind === "score" ? (
                        <>
                          <div className="audit-type">Score committed</div>
                          <div className="audit-meta">
                            Judge {shortAddr(e.judge)} → {shortAddr(e.participant)} · PS {e.ps} · CQ {e.cq} · Eff {e.ef}
                          </div>
                          <div className="audit-meta">Block {e.blockNumber}</div>
                        </>
                      ) : (
                        <>
                          <div className="audit-type">Finalized</div>
                          <div className="audit-meta">Organizer {shortAddr(e.organizer)}</div>
                          <div className="audit-meta">Block {e.blockNumber}</div>
                        </>
                      )}
                    </div>
                    <div>
                      {ex ? (
                        <a className="tx-link" href={ex} target="_blank" rel="noreferrer">
                          Explorer ↗
                        </a>
                      ) : (
                        <button type="button" className="tx-link" onClick={() => void copyText(e.txHash)}>
                          Copy tx
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      <div className="guide">
        <details>
          <summary>Demo playbook · six wallets</summary>
          <ul>
            <li>
              <strong>Organizer</strong>: deploy, register three participants and two judges, assign edges (e.g. J₁→P₁,P₂;
              J₂→P₂,P₃), finalize after all sheets.
            </li>
            <li>
              <strong>Rejections</strong>: wrong assignment, double submit, score &gt; max, early finalize, post-lock
              mutation—each reverts with a named custom error.
            </li>
            <li>Ganache often uses chain IDs 1337 or 5777; Hardhat node uses 31337.</li>
          </ul>
        </details>
      </div>
    </div>
  );
}
