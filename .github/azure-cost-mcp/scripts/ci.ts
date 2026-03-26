#!/usr/bin/env tsx
/**
 * scripts/ci.ts — GitHub Actions CLI entrypoint
 * ─────────────────────────────────────────────────────────────────────────────
 * Commands:
 *   estimate   <tfvars>                     → print cost + write JSON output
 *   diff       <tfvars> <baseline>          → print diff + write JSON output + exit 1 if threshold exceeded
 *   baseline   <tfvars> <output>            → save baseline JSON to output path
 *
 * All commands write a structured JSON result to $CI_OUTPUT_FILE (or stdout)
 * so the GitHub Actions workflow can read it via fromJSON().
 *
 * Exit codes:
 *   0  → success, cost within threshold
 *   1  → cost increase exceeds threshold (blocks merge)
 *   2  → error (missing files, API failure, etc.)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

// Import from the MCP server's shared modules
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(__dirname, "../src");

const { getPrice, toMonthly, perGbMonthly } = await import(`${srcDir}/azure-pricing.js`);
const { parseTfvars } = await import(`${srcDir}/tfvars-parser.js`);
const { saveBaseline, loadBaseline, diffSnapshots } = await import(`${srcDir}/baseline.js`);

// ── Config from env vars ──────────────────────────────────────────────────────
// COST_INCREASE_THRESHOLD_PCT: block merge if monthly cost increases by more than X%
// COST_INCREASE_THRESHOLD_ABS: block merge if monthly cost increases by more than $X
// Both default to disabled (0 = no block)
const THRESHOLD_PCT = parseFloat(process.env.COST_INCREASE_THRESHOLD_PCT ?? "0");
const THRESHOLD_ABS = parseFloat(process.env.COST_INCREASE_THRESHOLD_ABS ?? "0");
const OUTPUT_FILE   = process.env.CI_OUTPUT_FILE ?? "";

// ── Helpers ───────────────────────────────────────────────────────────────────
const USD = (n: number) => `$${Math.abs(n).toFixed(2)}`;
const sign = (n: number) => (n >= 0 ? `+$${n.toFixed(2)}` : `-$${Math.abs(n).toFixed(2)}`);

const FAMILY_ICONS: Record<string, string> = {
  vm: "🖥️", aks: "☸️", disk: "💾", loadbalancer: "⚖️", publicip: "🌐",
  storage: "🗄️", postgres: "🐘", mysql: "🐬", mssql: "🗃️", natgateway: "🔀", vnet: "🔗",
};

function writeOutput(data: Record<string, unknown>) {
  const json = JSON.stringify(data);
  if (OUTPUT_FILE) {
    fs.writeFileSync(OUTPUT_FILE, json, "utf8");
  } else {
    console.log("::OUTPUT::", json);
  }
}

function fail(msg: string): never {
  console.error(`::error::${msg}`);
  writeOutput({ success: false, error: msg });
  process.exit(2);
}

// ── Cost calculator (shared logic from index.ts) ──────────────────────────────
async function buildSnapshot(tfvarsPath: string) {
  const parsed = parseTfvars(tfvarsPath);
  if (parsed.length === 0) fail(`No priceable resources found in: ${tfvarsPath}`);

  const resources = [];
  for (const resource of parsed) {
    try {
      const record = await getPrice(resource.priceReq);
      let monthly: number;
      if (resource.billingModel === "per-gb-month") {
        monthly = perGbMonthly(record.retailPrice, resource.sizeGb ?? 0, resource.count);
      } else {
        monthly = toMonthly(record.retailPrice, resource.count);
      }
      resources.push({
        label: resource.label,
        family: resource.priceReq.family,
        count: resource.count,
        sizeGb: resource.sizeGb,
        billingModel: resource.billingModel,
        unitPrice: record.retailPrice,
        monthlyPrice: monthly,
      });
    } catch (err: any) {
      // Don't fail the whole run for one unavailable price — log warning
      console.warn(`⚠️  Could not price: ${resource.label} — ${err.message}`);
      resources.push({
        label: resource.label,
        family: resource.priceReq.family,
        count: resource.count,
        billingModel: resource.billingModel,
        unitPrice: 0,
        monthlyPrice: 0,
      });
    }
  }

  const totalMonthly = resources.reduce((s, r) => s + r.monthlyPrice, 0);
  return {
    savedAt: new Date().toISOString(),
    tfvarsPath,
    totalMonthly,
    resources,
  };
}

// ── Markdown formatters ───────────────────────────────────────────────────────

function markdownEstimate(snapshot: any, env: string): string {
  const rows = snapshot.resources
    .filter((r: any) => r.monthlyPrice > 0)
    .sort((a: any, b: any) => b.monthlyPrice - a.monthlyPrice)
    .map((r: any) => {
      const icon = FAMILY_ICONS[r.family] ?? "📦";
      return `| ${icon} ${r.family} | ${r.label} | $${r.unitPrice.toFixed(4)} | ${r.count} | **$${r.monthlyPrice.toFixed(2)}** |`;
    })
    .join("\n");

  return [
    `### 💰 Cost Estimate — \`${env}\``,
    ``,
    `| Type | Resource | Unit Price | Count | Monthly |`,
    `|------|----------|-----------|-------|---------|`,
    rows,
    `| | | | **Total** | **$${snapshot.totalMonthly.toFixed(2)}/month** |`,
    ``,
    `> Prices from [Azure Retail Pricing API](https://prices.azure.com) · ${new Date().toUTCString()}`,
  ].join("\n");
}

function markdownDiff(
  result: ReturnType<typeof diffSnapshots>,
  env: string,
  blocked: boolean,
  blockReason: string
): string {
  const { diffs, totalBefore, totalAfter, totalDelta } = result;

  const direction =
    totalDelta > 0 ? "📈 Cost Increase" :
    totalDelta < 0 ? "📉 Cost Decrease" : "✅ No Cost Change";

  const pct = totalBefore > 0
    ? ` (${((totalDelta / totalBefore) * 100).toFixed(1)}%)`
    : "";

  const statusBadge = blocked
    ? `> ⛔ **MERGE BLOCKED** — ${blockReason}`
    : totalDelta > 0
    ? `> ⚠️ Cost will increase — within acceptable threshold`
    : `> ✅ Cost change is within threshold`;

  const changed = diffs.filter((d: any) => d.changeType !== "unchanged");
  const unchanged = diffs.filter((d: any) => d.changeType === "unchanged");

  const changeRows = changed.map((d: any) => {
    const icon =
      d.changeType === "added" ? "➕" :
      d.changeType === "removed" ? "➖" : "🔄";
    const before = d.before ? `$${d.before.monthlyPrice.toFixed(2)}` : "—";
    const after  = d.after  ? `$${d.after.monthlyPrice.toFixed(2)}`  : "—";
    const delta  = `**${sign(d.delta)}/mo**`;
    return `| ${icon} ${d.changeType} | ${d.label} | ${before} | ${after} | ${delta} |`;
  }).join("\n");

  const sections = [
    `### ${direction} — \`${env}\``,
    ``,
    statusBadge,
    ``,
    `| | Before | After | Change |`,
    `|---|--------|-------|--------|`,
    `| **Monthly Total** | $${totalBefore.toFixed(2)} | $${totalAfter.toFixed(2)} | **${sign(totalDelta)}/mo${pct}** |`,
    ``,
  ];

  if (changed.length > 0) {
    sections.push(
      `#### Changed Resources`,
      ``,
      `| Change | Resource | Before | After | Delta |`,
      `|--------|----------|--------|-------|-------|`,
      changeRows,
      ``
    );
  }

  if (unchanged.length > 0) {
    sections.push(`<details><summary>${unchanged.length} resource(s) unchanged</summary>\n`);
    unchanged.forEach((d: any) => {
      sections.push(`- ${d.label}: $${d.before?.monthlyPrice.toFixed(2)}/mo`);
    });
    sections.push(`\n</details>`);
  }

  sections.push(
    ``,
    `> Prices from [Azure Retail Pricing API](https://prices.azure.com) · ${new Date().toUTCString()}`
  );

  return sections.join("\n");
}

// ── Commands ──────────────────────────────────────────────────────────────────

const [,, command, ...args] = process.argv;

// ── estimate <tfvars_path> ────────────────────────────────────────────────────
if (command === "estimate") {
  const tfvarsPath = args[0];
  const env = args[1] ?? path.dirname(tfvarsPath).split("/").pop() ?? "unknown";

  if (!tfvarsPath) fail("Usage: ci.ts estimate <tfvars_path> [env_name]");
  if (!fs.existsSync(tfvarsPath)) fail(`tfvars not found: ${tfvarsPath}`);

  console.log(`📊 Estimating cost for ${env}...`);
  const snapshot = await buildSnapshot(tfvarsPath);
  const markdown = markdownEstimate(snapshot, env);

  console.log(markdown);
  writeOutput({
    success: true,
    env,
    totalMonthly: snapshot.totalMonthly,
    markdown,
    resourceCount: snapshot.resources.length,
  });

  process.exit(0);
}

// ── diff <tfvars_path> <baseline_path> ────────────────────────────────────────
if (command === "diff") {
  const tfvarsPath  = args[0];
  const baselinePath = args[1];
  const env = args[2] ?? path.dirname(tfvarsPath).split("/").pop() ?? "unknown";

  if (!tfvarsPath || !baselinePath) fail("Usage: ci.ts diff <tfvars_path> <baseline_path> [env_name]");
  if (!fs.existsSync(tfvarsPath))   fail(`tfvars not found: ${tfvarsPath}`);

  if (!fs.existsSync(baselinePath)) {
    // No baseline yet — first time running on this branch. Just estimate.
    console.log(`ℹ️  No baseline found at ${baselinePath} — running estimate instead.`);
    const snapshot = await buildSnapshot(tfvarsPath);
    const markdown = [
      markdownEstimate(snapshot, env),
      ``,
      `> ℹ️ No baseline exists yet for \`${env}\`. This estimate will become the baseline after merge.`,
    ].join("\n");

    console.log(markdown);
    writeOutput({ success: true, env, totalMonthly: snapshot.totalMonthly,
      markdown, blocked: false, noBaseline: true });
    process.exit(0);
  }

  console.log(`🔍 Diffing cost for ${env}...`);
  const baseline = loadBaseline(baselinePath);
  if (!baseline) fail(`Could not parse baseline: ${baselinePath}`);

  const current  = await buildSnapshot(tfvarsPath);
  const result   = diffSnapshots(baseline, current);
  const { totalBefore, totalAfter, totalDelta } = result;

  // ── Check thresholds ───────────────────────────────────────────────────────
  let blocked = false;
  let blockReason = "";

  if (THRESHOLD_PCT > 0 && totalBefore > 0) {
    const pctIncrease = (totalDelta / totalBefore) * 100;
    if (pctIncrease > THRESHOLD_PCT) {
      blocked = true;
      blockReason = `Cost increases by ${pctIncrease.toFixed(1)}% (+$${totalDelta.toFixed(2)}/mo), exceeds ${THRESHOLD_PCT}% threshold`;
    }
  }

  if (THRESHOLD_ABS > 0 && totalDelta > THRESHOLD_ABS) {
    blocked = true;
    blockReason = `Cost increases by $${totalDelta.toFixed(2)}/mo, exceeds $${THRESHOLD_ABS} threshold`;
  }

  const markdown = markdownDiff(result, env, blocked, blockReason);
  console.log(markdown);

  if (blocked) {
    console.log(`\n::error::${blockReason}`);
  }

  writeOutput({
    success: true,
    env,
    totalBefore,
    totalAfter,
    totalDelta,
    blocked,
    blockReason,
    markdown,
  });

  // Exit 1 blocks merge via required status check
  process.exit(blocked ? 1 : 0);
}

// ── baseline <tfvars_path> <output_path> ──────────────────────────────────────
if (command === "baseline") {
  const tfvarsPath = args[0];
  const outputPath = args[1];

  if (!tfvarsPath || !outputPath) fail("Usage: ci.ts baseline <tfvars_path> <output_path>");
  if (!fs.existsSync(tfvarsPath)) fail(`tfvars not found: ${tfvarsPath}`);

  console.log(`💾 Saving baseline for ${tfvarsPath}...`);
  const snapshot = await buildSnapshot(tfvarsPath);

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(snapshot, null, 2), "utf8");

  console.log(`✅ Baseline saved: ${outputPath} ($${snapshot.totalMonthly.toFixed(2)}/month)`);
  writeOutput({ success: true, totalMonthly: snapshot.totalMonthly, outputPath });
  process.exit(0);
}

fail(`Unknown command: ${command}. Use: estimate | diff | baseline`);
