#!/usr/bin/env tsx
/**
 * sync-prices.ts — Weekly SQLite price cache builder
 * ─────────────────────────────────────────────────────────────────────────────
 * Fetches prices for all resource families from the Azure Pricing API
 * and stores them in db/prices.sqlite for offline <10ms lookups.
 *
 * Run manually or via GitHub Actions (see .github/workflows/sync-prices.yml):
 *   npx tsx scripts/sync-prices.ts
 * ─────────────────────────────────────────────────────────────────────────────
 */

import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "../db/prices.sqlite");
const AZURE_PRICE_API = "https://prices.azure.com/api/retail/prices";
const DELAY_MS = 120; // polite rate-limit delay

// ── ✏️  CONFIGURE YOUR INFRA SCOPE ───────────────────────────────────────────

const REGIONS = [
  "eastus", "eastus2", "westeurope", "northeurope",
  "uksouth", "westus2", "centralus", "southeastasia",
];

const VM_SKUS = [
  // AKS system / user nodes
  "Standard_D2s_v3", "Standard_D4s_v3", "Standard_D8s_v3", "Standard_D16s_v3",
  "Standard_D2s_v5", "Standard_D4s_v5", "Standard_D8s_v5", "Standard_D16s_v5",
  // Memory optimised (Prometheus, Elasticsearch, DB replicas)
  "Standard_E4s_v5", "Standard_E8s_v5", "Standard_E16s_v5", "Standard_E32s_v5",
  // Burstable (dev/test)
  "Standard_B2s", "Standard_B4ms", "Standard_B8ms",
  // GPU nodes
  "Standard_NC6s_v3", "Standard_NC12s_v3",
];

const DB_SKUS = [
  // PostgreSQL / MySQL Flexible Server (same SKU names as VMs)
  "Standard_D2s_v3", "Standard_D4s_v3", "Standard_D8s_v3",
  "Standard_E4s_v5", "Standard_E8s_v5",
  "Standard_B2s",
];

const DISK_TIERS = [
  "P4", "P6", "P10", "P15", "P20", "P30", "P40", "P50", // Premium SSD
  "E4", "E10", "E20", "E30", "E40",                       // Standard SSD
  "S4", "S10", "S20", "S30",                              // Standard HDD
];

const DISK_REDUNDANCIES = ["LRS", "ZRS"];

// ─────────────────────────────────────────────────────────────────────────────

interface SyncEntry {
  cacheKey: string;
  region: string;
  retailPrice: number;
  unitOfMeasure: string;
  productName: string;
  skuName: string;
}

async function fetchFirst(filter: string, prefer?: (i: any) => boolean): Promise<any | null> {
  const url = `${AZURE_PRICE_API}?$filter=${encodeURIComponent(filter)}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const json: any = await res.json();
    const items: any[] = json.Items ?? [];
    if (prefer) return items.find(prefer) ?? items[0] ?? null;
    return items.find((i: any) =>
      !`${i.skuName} ${i.meterName}`.toLowerCase().match(/windows|spot|low priority/)
    ) ?? items[0] ?? null;
  } catch {
    return null;
  }
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);

  db.exec(`
    CREATE TABLE IF NOT EXISTS prices (
      cache_key       TEXT NOT NULL,
      region          TEXT NOT NULL,
      retail_price    REAL NOT NULL,
      unit_of_measure TEXT,
      product_name    TEXT,
      sku_name        TEXT,
      synced_at       TEXT NOT NULL,
      PRIMARY KEY (cache_key, region)
    );
    CREATE INDEX IF NOT EXISTS idx ON prices(cache_key, region);
  `);

  const upsert = db.prepare(`
    INSERT INTO prices (cache_key, region, retail_price, unit_of_measure, product_name, sku_name, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(cache_key, region) DO UPDATE SET
      retail_price=excluded.retail_price, unit_of_measure=excluded.unit_of_measure,
      product_name=excluded.product_name, sku_name=excluded.sku_name, synced_at=excluded.synced_at
  `);

  const now = new Date().toISOString();
  let ok = 0, miss = 0;

  function store(entry: SyncEntry) {
    upsert.run(entry.cacheKey, entry.region, entry.retailPrice,
      entry.unitOfMeasure, entry.productName, entry.skuName, now);
    ok++;
    process.stdout.write("✓");
  }

  function skip() { miss++; process.stdout.write("·"); }

  // ── VMs ──────────────────────────────────────────────────────────────────
  console.log("\n🖥️  VMs / AKS Node Pools");
  for (const sku of VM_SKUS) {
    process.stdout.write(`  ${sku.padEnd(26)}`);
    for (const region of REGIONS) {
      const item = await fetchFirst(
        `armSkuName eq '${sku}' and armRegionName eq '${region}' and priceType eq 'Consumption'`
      );
      item ? store({ cacheKey: `vm::${sku.toLowerCase()}::${region}`, region, retailPrice: item.retailPrice,
        unitOfMeasure: item.unitOfMeasure, productName: item.productName, skuName: item.skuName }) : skip();
      await sleep(DELAY_MS);
    }
    console.log();
  }

  // ── PostgreSQL ────────────────────────────────────────────────────────────
  console.log("\n🐘 PostgreSQL Flexible Server");
  for (const sku of DB_SKUS) {
    process.stdout.write(`  ${sku.padEnd(26)}`);
    for (const region of REGIONS) {
      const item = await fetchFirst(
        `armSkuName eq '${sku}' and armRegionName eq '${region}' and priceType eq 'Consumption'`,
        (i: any) => i.productName?.toLowerCase().includes("postgresql")
      );
      item ? store({ cacheKey: `postgres::${sku.toLowerCase()}::${region}`, region,
        retailPrice: item.retailPrice, unitOfMeasure: item.unitOfMeasure,
        productName: item.productName, skuName: item.skuName }) : skip();
      await sleep(DELAY_MS);
    }
    console.log();
  }

  // ── MySQL ─────────────────────────────────────────────────────────────────
  console.log("\n🐬 MySQL Flexible Server");
  for (const sku of DB_SKUS) {
    process.stdout.write(`  ${sku.padEnd(26)}`);
    for (const region of REGIONS) {
      const item = await fetchFirst(
        `armSkuName eq '${sku}' and armRegionName eq '${region}' and priceType eq 'Consumption'`,
        (i: any) => i.productName?.toLowerCase().includes("mysql")
      );
      item ? store({ cacheKey: `mysql::${sku.toLowerCase()}::${region}`, region,
        retailPrice: item.retailPrice, unitOfMeasure: item.unitOfMeasure,
        productName: item.productName, skuName: item.skuName }) : skip();
      await sleep(DELAY_MS);
    }
    console.log();
  }

  // ── Managed Disks ─────────────────────────────────────────────────────────
  console.log("\n💾 Managed Disks");
  for (const tier of DISK_TIERS) {
    for (const red of DISK_REDUNDANCIES) {
      process.stdout.write(`  ${tier} ${red.padEnd(4)}`);
      for (const region of REGIONS) {
        const item = await fetchFirst(
          `serviceName eq 'Storage' and skuName eq '${tier} ${red}' and armRegionName eq '${region}' and priceType eq 'Consumption'`,
          (i: any) => i.productName?.toLowerCase().includes("disk")
        );
        item ? store({ cacheKey: `disk::${tier.toLowerCase()}-${red.toLowerCase()}::${region}`, region,
          retailPrice: item.retailPrice, unitOfMeasure: item.unitOfMeasure,
          productName: item.productName, skuName: item.skuName }) : skip();
        await sleep(DELAY_MS);
      }
      console.log();
    }
  }

  // ── Load Balancer ─────────────────────────────────────────────────────────
  console.log("\n⚖️  Load Balancer");
  for (const tier of ["Basic", "Standard"] as const) {
    process.stdout.write(`  LB ${tier.padEnd(10)}`);
    for (const region of REGIONS) {
      const items = await fetchFirst(
        `serviceName eq 'Load Balancer' and armRegionName eq '${region}' and priceType eq 'Consumption'`,
        tier === "Standard"
          ? (i: any) => i.meterName?.toLowerCase().includes("rules") && i.skuName?.toLowerCase().includes("standard")
          : (i: any) => i.meterName?.toLowerCase().includes("data processed")
      );
      items ? store({ cacheKey: `loadbalancer::lb-${tier.toLowerCase()}::${region}`, region,
        retailPrice: items.retailPrice, unitOfMeasure: items.unitOfMeasure,
        productName: items.productName, skuName: items.skuName }) : skip();
      await sleep(DELAY_MS);
    }
    console.log();
  }

  // ── Public IP ─────────────────────────────────────────────────────────────
  console.log("\n🌐 Public IPs");
  for (const tier of ["Basic", "Standard"] as const) {
    process.stdout.write(`  PIP ${tier.padEnd(9)}`);
    for (const region of REGIONS) {
      const item = await fetchFirst(
        `serviceName eq 'Virtual Network' and armRegionName eq '${region}' and priceType eq 'Consumption'`,
        (i: any) => i.meterName?.toLowerCase().includes("ip address") && i.skuName?.toLowerCase().includes(tier.toLowerCase())
      );
      item ? store({ cacheKey: `publicip::pip-${tier.toLowerCase()}::${region}`, region,
        retailPrice: item.retailPrice, unitOfMeasure: item.unitOfMeasure,
        productName: item.productName, skuName: item.skuName }) : skip();
      await sleep(DELAY_MS);
    }
    console.log();
  }

  // ── Blob Storage ──────────────────────────────────────────────────────────
  console.log("\n🗄️  Blob Storage");
  const storageCombos = [
    { tier: "Hot", red: "LRS" }, { tier: "Hot", red: "GRS" }, { tier: "Hot", red: "ZRS" },
    { tier: "Cool", red: "LRS" }, { tier: "Cool", red: "GRS" },
    { tier: "Cold", red: "LRS" }, { tier: "Archive", red: "LRS" },
  ];
  for (const { tier, red } of storageCombos) {
    process.stdout.write(`  ${tier} ${red.padEnd(6)}`);
    for (const region of REGIONS) {
      const item = await fetchFirst(
        `serviceName eq 'Storage' and skuName eq '${tier} ${red}' and armRegionName eq '${region}' and priceType eq 'Consumption'`,
        (i: any) => i.productName?.toLowerCase().includes("blob") && i.meterName?.toLowerCase().includes("data stored")
      );
      item ? store({ cacheKey: `storage::${tier.toLowerCase()}-${red.toLowerCase()}::${region}`, region,
        retailPrice: item.retailPrice, unitOfMeasure: item.unitOfMeasure,
        productName: item.productName, skuName: item.skuName }) : skip();
      await sleep(DELAY_MS);
    }
    console.log();
  }

  // ── AKS Management Fee ────────────────────────────────────────────────────
  console.log("\n☸️  AKS Management Fee");
  process.stdout.write(`  Standard cluster  `);
  for (const region of REGIONS) {
    const item = await fetchFirst(
      `serviceName eq 'Azure Kubernetes Service' and armRegionName eq '${region}' and priceType eq 'Consumption'`,
      (i: any) => i.meterName?.toLowerCase().includes("standard cluster")
    );
    item ? store({ cacheKey: `aks::aks-standard-cluster::${region}`, region,
      retailPrice: item.retailPrice, unitOfMeasure: item.unitOfMeasure,
      productName: item.productName, skuName: item.skuName }) : skip();
    await sleep(DELAY_MS);
  }
  console.log();

  // ── NAT Gateway ───────────────────────────────────────────────────────────
  console.log("\n🔀 NAT Gateway");
  process.stdout.write(`  NAT Gateway hours `);
  for (const region of REGIONS) {
    const item = await fetchFirst(
      `serviceName eq 'Virtual Network' and armRegionName eq '${region}' and priceType eq 'Consumption'`,
      (i: any) => i.meterName?.toLowerCase().includes("nat gateway")
    );
    item ? store({ cacheKey: `natgateway::nat-gateway::${region}`, region,
      retailPrice: item.retailPrice, unitOfMeasure: item.unitOfMeasure,
      productName: item.productName, skuName: item.skuName }) : skip();
    await sleep(DELAY_MS);
  }
  console.log();

  // ── VNet Peering ──────────────────────────────────────────────────────────
  console.log("\n🔗 VNet Peering");
  process.stdout.write(`  Peering data      `);
  for (const region of REGIONS) {
    const item = await fetchFirst(
      `serviceName eq 'Virtual Network' and armRegionName eq '${region}' and priceType eq 'Consumption'`,
      (i: any) => i.meterName?.toLowerCase().includes("peering")
    );
    item ? store({ cacheKey: `vnet::vnet-peering::${region}`, region,
      retailPrice: item.retailPrice, unitOfMeasure: item.unitOfMeasure,
      productName: item.productName, skuName: item.skuName }) : skip();
    await sleep(DELAY_MS);
  }
  console.log();

  db.close();

  const kb = (fs.statSync(DB_PATH).size / 1024).toFixed(1);
  console.log(`\n✅ Sync complete — ${ok} prices cached, ${miss} not available in region`);
  console.log(`   DB: ${DB_PATH} (${kb} KB)`);
}

main().catch((e) => { console.error("❌", e.message); process.exit(1); });
