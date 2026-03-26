/**
 * baseline.ts — Cost snapshot persistence and diffing
 */

import * as fs from "fs";
import * as path from "path";

export interface PricedResource {
  label: string;
  family: string;
  count: number;
  sizeGb?: number;
  billingModel: string;
  unitPrice: number;      // price per unit from API
  monthlyPrice: number;   // final calculated monthly cost
}

export interface CostSnapshot {
  savedAt: string;
  tfvarsPath: string;
  totalMonthly: number;
  resources: PricedResource[];
}

function defaultBaselinePath(tfvarsPath: string): string {
  return path.join(path.dirname(tfvarsPath), ".cost-baseline.json");
}

export function saveBaseline(snapshot: CostSnapshot, outputPath?: string): string {
  const target = outputPath ?? defaultBaselinePath(snapshot.tfvarsPath);
  fs.writeFileSync(target, JSON.stringify(snapshot, null, 2), "utf8");
  return target;
}

export function loadBaseline(baselinePath?: string, tfvarsPath?: string): CostSnapshot | null {
  const target = baselinePath ?? (tfvarsPath ? defaultBaselinePath(tfvarsPath) : null);
  if (!target || !fs.existsSync(target)) return null;
  try {
    return JSON.parse(fs.readFileSync(target, "utf8")) as CostSnapshot;
  } catch {
    return null;
  }
}

export interface ResourceDiff {
  label: string;
  changeType: "added" | "removed" | "changed" | "unchanged";
  before: { monthlyPrice: number; count: number } | null;
  after:  { monthlyPrice: number; count: number } | null;
  delta: number;
}

export function diffSnapshots(
  baseline: CostSnapshot,
  current: CostSnapshot
): { diffs: ResourceDiff[]; totalBefore: number; totalAfter: number; totalDelta: number } {
  const diffs: ResourceDiff[] = [];
  const baseMap = new Map(baseline.resources.map((r) => [r.label, r]));
  const currMap = new Map(current.resources.map((r) => [r.label, r]));

  for (const [label, curr] of currMap) {
    const base = baseMap.get(label);
    if (!base) {
      diffs.push({ label, changeType: "added", before: null,
        after: { monthlyPrice: curr.monthlyPrice, count: curr.count }, delta: curr.monthlyPrice });
    } else {
      const changed = base.monthlyPrice !== curr.monthlyPrice || base.count !== curr.count;
      diffs.push({ label, changeType: changed ? "changed" : "unchanged",
        before: { monthlyPrice: base.monthlyPrice, count: base.count },
        after:  { monthlyPrice: curr.monthlyPrice, count: curr.count },
        delta: curr.monthlyPrice - base.monthlyPrice });
    }
  }

  for (const [label, base] of baseMap) {
    if (!currMap.has(label)) {
      diffs.push({ label, changeType: "removed",
        before: { monthlyPrice: base.monthlyPrice, count: base.count },
        after: null, delta: -base.monthlyPrice });
    }
  }

  const totalDelta = diffs.reduce((s, d) => s + d.delta, 0);
  return { diffs, totalBefore: baseline.totalMonthly, totalAfter: current.totalMonthly, totalDelta };
}
