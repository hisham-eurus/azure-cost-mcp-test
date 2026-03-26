# azure-cost-mcp

A GitHub Copilot MCP server that estimates Azure infrastructure costs directly
from your Terraform `.tfvars` files — **no Infracost, no paid APIs, no subscriptions**.

Prices come from the [Azure Retail Pricing API](https://prices.azure.com/api/retail/prices)
which is completely free and requires no authentication.

---

## How It Works

```
Copilot Agent Mode
       │
       ▼
azure-cost-mcp (this server)
       │
       ├── parse .tfvars  →  extract SKUs, counts, regions
       ├── Layer 1: in-memory cache   → 0ms   (same SKU seen before)
       ├── Layer 2: local SQLite DB   → <10ms (if sync run)
       └── Layer 3: Azure Pricing API → ~200ms (free, no auth, OData filtered)
```

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. (Optional but recommended) Sync local price DB

Edit `scripts/sync-prices.ts` and add your SKUs and regions, then run:

```bash
npm run sync-prices
```

This builds a local SQLite DB so all lookups are offline and instant.
Run weekly (or let the GitHub Action do it automatically).

### 3. Register with VS Code Copilot

The `.vscode/mcp.json` file is already included. Open the repo in VS Code,
switch Copilot to **Agent mode**, and the tools will appear automatically.

For other editors, point your MCP config to:
```
command: npx tsx /path/to/azure-cost-mcp/src/index.ts
```

---

## Tools

### `estimate_cost`
Parse a `.tfvars` file and get an itemised monthly cost estimate.

```
"How much does examples/example.tfvars cost per month?"
→ estimate_cost { tfvars_path: "examples/example.tfvars" }
```

Output:
```
💰 Estimated Monthly Cost: $1,022.80 [price source: api]

Resources:
  • node_vm_size
    SKU: Standard_D4s_v3  ×5  @  $0.192/hr
    Monthly: $700.80

  • system_node_vm_size
    SKU: Standard_D2s_v3  ×2  @  $0.096/hr
    Monthly: $140.16
```

---

### `save_cost_baseline`
Snapshot the current priced state. Run this **before** making changes.

```
"Save a cost baseline for my current tfvars"
→ save_cost_baseline { tfvars_path: "terraform/prod.tfvars" }
```

Saves a `.cost-baseline.json` file next to your tfvars.
Commit it for team use, or add to `.gitignore` to keep it local.

---

### `compare_cost_diff`
Compare current tfvars against the saved baseline.

```
"What's the cost impact of upgrading node pools from D4s to D8s?"
→ compare_cost_diff { tfvars_path: "terraform/prod.tfvars" }
```

Output:
```
📈 COST INCREASE  +$700.80/month  (100.0%)

Before (baseline from 5m ago): $1,022.80/mo
After  (current):               $1,723.60/mo

  🔄 node_vm_size
     Standard_D4s_v3 → Standard_D8s_v3  ×5
     $700.80/mo → $1,401.60/mo  (+$700.80/mo)

  ── 1 resource(s) unchanged ──
```

---

### `explain_sku`
Quick price lookup for a single VM SKU.

```
"How much does a Standard_E8s_v5 cost in westeurope for 3 nodes?"
→ explain_sku { sku: "Standard_E8s_v5", region: "westeurope", count: 3 }
```

Output:
```
🖥️  Standard_E8s_v5 in westeurope
   Product:  Azure Compute
   Price:    $0.504/hr per instance
   × 3 instances × 730 hrs/month
   ─────────────────────────────
   Monthly:  $1,103.76/month
   Annual:   $13,245.12/year
   [source: api]
```

---

## Typical SRE Workflow

```bash
# 1. Before making any changes — save baseline
# (tell Copilot): "Save a cost baseline for terraform/prod/aks.tfvars"

# 2. Edit your tfvars (e.g. upgrade node SKU, increase count)
vim terraform/prod/aks.tfvars

# 3. Check the cost impact before applying
# (tell Copilot): "What's the cost diff for terraform/prod/aks.tfvars?"

# 4. If happy, apply and reset baseline
terraform apply
# (tell Copilot): "Save a new baseline after apply for terraform/prod/aks.tfvars"
```

---

## Supported tfvars Variable Names

The parser recognises common Terraform naming conventions:

| Variable pattern | Detected as |
|---|---|
| `node_vm_size`, `vm_size`, `node_size`, `aks_vm_size` | Node pool / VM |
| `vm_sku`, `virtual_machine_size`, `machine_size` | Virtual Machine |
| `node_count`, `vm_count`, `instance_count`, `replicas` | Instance count |
| `location`, `region`, `azure_region` | Region |
| `disk_size`, `os_disk_size` | Disk size (GB) |

Any `Standard_XXXXX` value is treated as an Azure VM SKU.

---

## Weekly Price Sync (GitHub Actions)

The included workflow (`.github/workflows/sync-prices.yml`) runs every Monday
and commits an updated `db/prices.sqlite` if prices changed. No manual steps needed.

To trigger manually:
```bash
npm run sync-prices
```

---

## Project Structure

```
azure-cost-mcp/
├── src/
│   ├── index.ts            ← MCP server + all 4 tools
│   ├── azure-pricing.ts    ← 3-layer price lookup (memory → SQLite → API)
│   ├── tfvars-parser.ts    ← HCL tfvars parser
│   └── baseline.ts         ← snapshot save/load/diff
├── scripts/
│   └── sync-prices.ts      ← weekly SQLite price sync
├── db/
│   └── prices.sqlite       ← local price cache (auto-generated)
├── examples/
│   └── example.tfvars      ← test tfvars to try immediately
├── .github/
│   └── workflows/
│       └── sync-prices.yml ← weekly sync automation
├── .vscode/
│   └── mcp.json            ← VS Code Copilot MCP registration
└── .gitignore
```
