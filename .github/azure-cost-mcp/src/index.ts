/**
 * index.ts — Azure Cost MCP Server
 * ─────────────────────────────────────────────────────────────────────────────
 * 4 tools exposed to Copilot Agent Mode:
 *
 *   estimate_cost       → itemised monthly cost from a .tfvars file
 *   compare_cost_diff   → delta vs saved baseline
 *   save_cost_baseline  → snapshot current state for future diffs
 *   explain_sku         → single SKU price lookup
 *
 * Supports all resource families:
 *   VM/NodePool · AKS mgmt · Managed Disk · Load Balancer · Public IP
 *   Blob Storage · PostgreSQL · MySQL · Azure SQL · NAT Gateway · VNet Peering
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { getPrice, toMonthly, perGbMonthly, type PriceRecord } from "./azure-pricing.js";
import { parseTfvars, type ParsedResource } from "./tfvars-parser.js";
import { saveBaseline, loadBaseline, diffSnapshots, type CostSnapshot, type PricedResource } from "./baseline.js";

// ── Cost calculation ──────────────────────────────────────────────────────────

/**
 * Calculate the monthly cost of a parsed resource using its billing model.
 *
 * Billing models:
 *   hourly         → unitPrice/hr × count × 730 hrs/month
 *   per-gb-month   → unitPrice/GB × sizeGb × count
 *   per-rule-hour  → unitPrice/rule/hr × count (count = lbCount × ruleCount) × 730
 *   flat-per-hour  → unitPrice/hr × count × 730  (same as hourly, named for clarity)
 */
function calcMonthly(resource: ParsedResource, record: PriceRecord): number {
  const { billingModel, count, sizeGb } = resource;
  const p = record.retailPrice;

  switch (billingModel) {
    case "per-gb-month":
      // unitOfMeasure is "1 GB/Month" — price is already per GB per month
      return perGbMonthly(p, sizeGb ?? 0, count);
    case "per-rule-hour":
    case "hourly":
    case "flat-per-hour":
    default:
      return toMonthly(p, count);
  }
}

/** Price all resources from a tfvars file and return a snapshot */
async function buildSnapshot(tfvarsPath: string): Promise<CostSnapshot> {
  const parsed = parseTfvars(tfvarsPath);

  if (parsed.length === 0) {
    throw new Error(
      `No priceable Azure resources detected in: ${tfvarsPath}\n\n` +
      `Ensure your tfvars contains variables like:\n` +
      `  node_vm_size, lb_sku, postgres_sku, storage_replication_type, etc.\n` +
      `See README for the full list of supported variable names.`
    );
  }

  const priced: PricedResource[] = [];

  for (const resource of parsed) {
    try {
      const record = await getPrice(resource.priceReq);
      const monthly = calcMonthly(resource, record);
      priced.push({
        label: resource.label,
        family: resource.priceReq.family,
        count: resource.count,
        sizeGb: resource.sizeGb,
        billingModel: resource.billingModel,
        unitPrice: record.retailPrice,
        monthlyPrice: monthly,
      });
    } catch (err: any) {
      // Don't fail the whole snapshot for one missing price — warn inline
      priced.push({
        label: `${resource.label} ⚠️ price unavailable: ${err.message}`,
        family: resource.priceReq.family,
        count: resource.count,
        billingModel: resource.billingModel,
        unitPrice: 0,
        monthlyPrice: 0,
      });
    }
  }

  const totalMonthly = priced.reduce((sum, r) => sum + r.monthlyPrice, 0);
  return { savedAt: new Date().toISOString(), tfvarsPath, totalMonthly, resources: priced };
}

// ── Formatters ────────────────────────────────────────────────────────────────

const USD = (n: number) => `$${n.toFixed(2)}`;
const sign = (n: number) => (n >= 0 ? `+${USD(n)}` : `-${USD(Math.abs(n))}`);

const FAMILY_ICONS: Record<string, string> = {
  vm: "🖥️",
  aks: "☸️",
  disk: "💾",
  loadbalancer: "⚖️",
  publicip: "🌐",
  storage: "🗄️",
  postgres: "🐘",
  mysql: "🐬",
  mssql: "🗃️",
  natgateway: "🔀",
  vnet: "🔗",
};

function unitLabel(r: PricedResource): string {
  switch (r.billingModel) {
    case "per-gb-month":   return `${USD(r.unitPrice)}/GB/mo`;
    case "per-rule-hour":  return `${USD(r.unitPrice)}/rule/hr`;
    default:               return `${USD(r.unitPrice)}/hr`;
  }
}

function formatSnapshot(snapshot: CostSnapshot, priceSrc?: string): string {
  const srcNote = priceSrc ? ` [source: ${priceSrc}]` : "";

  // Group by family
  const byFamily = new Map<string, PricedResource[]>();
  for (const r of snapshot.resources) {
    const list = byFamily.get(r.family) ?? [];
    list.push(r);
    byFamily.set(r.family, list);
  }

  const sections: string[] = [];
  for (const [family, resources] of byFamily) {
    const icon = FAMILY_ICONS[family] ?? "📦";
    const rows = resources.map(
      (r) => `    ${r.label}\n    @ ${unitLabel(r)}  →  ${USD(r.monthlyPrice)}/mo`
    ).join("\n");
    sections.push(`  ${icon} ${family.toUpperCase()}\n${rows}`);
  }

  return [
    `💰 Estimated Monthly Total: ${USD(snapshot.totalMonthly)}${srcNote}`,
    ``,
    sections.join("\n\n"),
  ].join("\n");
}

// ── MCP Server ────────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "azure-cost-mcp",
  version: "2.0.0",
  description: "Estimates Azure infrastructure costs from Terraform tfvars — no paid APIs required.",
});

// ── Tool 1: estimate_cost ─────────────────────────────────────────────────────
server.registerTool(
  "estimate_cost",
  {
    title: "Estimate Azure Infrastructure Cost",
    description:
      "Parses a Terraform .tfvars file and returns an itemised monthly cost breakdown for all detected Azure resources: " +
      "VMs, AKS node pools, AKS management fee, Managed Disks, Load Balancers, Public IPs, " +
      "Blob Storage, PostgreSQL, MySQL, Azure SQL Database, NAT Gateway, VNet Peering. " +
      "Use when the user asks: 'how much does this infra cost?', 'estimate my Azure bill', " +
      "'what's the monthly cost of this terraform config?'",
    inputSchema: {
      tfvars_path: z.string().describe("Path to the .tfvars file to analyse"),
    },
  },
  async ({ tfvars_path }) => {
    try {
      const snapshot = await buildSnapshot(tfvars_path);
      return { content: [{ type: "text", text: formatSnapshot(snapshot) }] };
    } catch (err: any) {
      return { content: [{ type: "text", text: `❌ ${err.message}` }], isError: true };
    }
  }
);

// ── Tool 2: compare_cost_diff ─────────────────────────────────────────────────
server.registerTool(
  "compare_cost_diff",
  {
    title: "Compare Azure Cost Before vs After",
    description:
      "Compares the current .tfvars cost against a previously saved baseline. " +
      "Shows exactly which resources changed, by how much, and the total monthly delta. " +
      "Use when the user says: 'what's the cost impact of changing X?', " +
      "'how much more will this cost?', 'compare before and after this node pool change'.",
    inputSchema: {
      tfvars_path: z.string().describe("Path to the CURRENT .tfvars (with your proposed changes)"),
      baseline_path: z.string().optional().describe(
        "Path to baseline JSON from save_cost_baseline. " +
        "Defaults to .cost-baseline.json next to the tfvars file."
      ),
    },
  },
  async ({ tfvars_path, baseline_path }) => {
    try {
      const baseline = loadBaseline(baseline_path, tfvars_path);
      if (!baseline) {
        return {
          content: [{
            type: "text",
            text:
              `⚠️  No baseline found.\n\n` +
              `Run save_cost_baseline first with your current (pre-change) tfvars.\n` +
              `A .cost-baseline.json will be saved next to your .tfvars file.`,
          }],
        };
      }

      const current = await buildSnapshot(tfvars_path);
      const { diffs, totalBefore, totalAfter, totalDelta } = diffSnapshots(baseline, current);

      const direction =
        totalDelta > 0 ? "📈 COST INCREASE" :
        totalDelta < 0 ? "📉 COST DECREASE" : "✅ NO CHANGE";

      const pct = totalBefore > 0 ? ` (${((totalDelta / totalBefore) * 100).toFixed(1)}%)` : "";
      const ageMin = Math.round((Date.now() - new Date(baseline.savedAt).getTime()) / 60000);
      const age = ageMin < 60 ? `${ageMin}m ago` : `${Math.round(ageMin / 60)}h ago`;

      const changedRows = diffs
        .filter((d) => d.changeType !== "unchanged")
        .map((d) => {
          if (d.changeType === "added")
            return `  ➕ [NEW]     ${d.label}\n               → ${USD(d.after!.monthlyPrice)}/mo`;
          if (d.changeType === "removed")
            return `  ➖ [REMOVED] ${d.label}\n               was ${USD(d.before!.monthlyPrice)}/mo`;
          return (
            `  🔄 [CHANGED] ${d.label}\n` +
            `               ${USD(d.before!.monthlyPrice)}/mo → ${USD(d.after!.monthlyPrice)}/mo  (${sign(d.delta)}/mo)`
          );
        })
        .join("\n\n");

      const unchangedCount = diffs.filter((d) => d.changeType === "unchanged").length;

      const output = [
        `${direction}  ${sign(totalDelta)}/month${pct}`,
        ``,
        `  Before (baseline from ${age}): ${USD(totalBefore)}/mo`,
        `  After  (current):              ${USD(totalAfter)}/mo`,
        ``,
        changedRows || "  No resource-level changes detected.",
        unchangedCount > 0 ? `\n  ── ${unchangedCount} resource(s) unchanged ──` : "",
      ].filter(Boolean).join("\n");

      return { content: [{ type: "text", text: output }] };
    } catch (err: any) {
      return { content: [{ type: "text", text: `❌ ${err.message}` }], isError: true };
    }
  }
);

// ── Tool 3: save_cost_baseline ────────────────────────────────────────────────
server.registerTool(
  "save_cost_baseline",
  {
    title: "Save Azure Cost Baseline",
    description:
      "Saves the current .tfvars pricing as a JSON snapshot for future cost comparisons. " +
      "Run this BEFORE making infrastructure changes, and again after a successful terraform apply. " +
      "The baseline is saved as .cost-baseline.json next to the tfvars file.",
    inputSchema: {
      tfvars_path: z.string().describe("Path to the .tfvars file to snapshot"),
      output_path: z.string().optional().describe(
        "Custom path to save the baseline JSON. Defaults to .cost-baseline.json next to the tfvars."
      ),
    },
  },
  async ({ tfvars_path, output_path }) => {
    try {
      const snapshot = await buildSnapshot(tfvars_path);
      const savedTo = saveBaseline(snapshot, output_path);

      const rows = snapshot.resources
        .map((r) => `  • ${r.label}: ${USD(r.monthlyPrice)}/mo`)
        .join("\n");

      return {
        content: [{
          type: "text",
          text:
            `✅ Baseline saved to: ${savedTo}\n\n` +
            `Total: ${USD(snapshot.totalMonthly)}/month\n\n` +
            `${rows}\n\n` +
            `Make your changes, then run compare_cost_diff to see the delta.`,
        }],
      };
    } catch (err: any) {
      return { content: [{ type: "text", text: `❌ ${err.message}` }], isError: true };
    }
  }
);

// ── Tool 4: explain_sku ───────────────────────────────────────────────────────
server.registerTool(
  "explain_sku",
  {
    title: "Look Up Azure Resource Price",
    description:
      "Returns the current retail price for a single Azure VM/DB SKU in a given region. " +
      "Use when the user asks: 'how much does Standard_D8s_v3 cost?', " +
      "'what's the price of this VM size?', 'compare D4s vs D8s price'.",
    inputSchema: {
      sku:    z.string().describe("Azure VM/DB SKU, e.g. 'Standard_D4s_v3', 'Standard_E8s_v5'"),
      region: z.string().default("eastus").describe("Azure region, e.g. 'eastus', 'westeurope'"),
      count:  z.number().int().min(1).default(1).describe("Number of instances"),
      family: z.enum(["vm", "postgres", "mysql"]).default("vm").describe("Resource type"),
    },
  },
  async ({ sku, region, count, family }) => {
    try {
      const record = await getPrice({ family, region, sku });
      const monthly = toMonthly(record.retailPrice, count);

      return {
        content: [{
          type: "text",
          text:
            `🖥️  ${sku} in ${region}\n` +
            `   Product:  ${record.productName}\n` +
            `   SKU Name: ${record.skuName}\n` +
            `   Price:    ${USD(record.retailPrice)}/hr per instance\n` +
            `   × ${count} instance${count > 1 ? "s" : ""} × 730 hrs/month\n` +
            `   ─────────────────────────────\n` +
            `   Monthly:  ${USD(monthly)}/month\n` +
            `   Annual:   ${USD(monthly * 12)}/year\n` +
            `   [source: ${record.source}]`,
        }],
      };
    } catch (err: any) {
      return { content: [{ type: "text", text: `❌ ${err.message}` }], isError: true };
    }
  }
);

// ── Start ─────────────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
