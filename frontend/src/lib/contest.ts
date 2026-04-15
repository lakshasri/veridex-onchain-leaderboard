import { Contract, JsonRpcSigner, type InterfaceAbi, type Provider } from "ethers";
import artifact from "../abi/ContestJudging.json";

export const CONTEST_ABI = artifact.abi as InterfaceAbi;

export function contestAt(address: string, runner: Provider | JsonRpcSigner) {
  return new Contract(address, CONTEST_ABI, runner);
}

/** Weighted sheet and aggregates use 1e18 scale; perfect sheet (all max criteria) ≈ 1e18. */
export function scaledToPercent100(scaled: bigint): string {
  if (scaled === 0n) return "0.0";
  // (scaled / 1e18) * 100
  const pct = (scaled * 10000n) / 10n ** 18n;
  const whole = pct / 100n;
  const frac = pct % 100n;
  return `${whole}.${frac.toString().padStart(2, "0")}`;
}

export function shortAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}
