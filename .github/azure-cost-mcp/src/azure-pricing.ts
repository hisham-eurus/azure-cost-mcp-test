/**
 * azure-pricing.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Fetches Azure retail prices via the free, no-auth Azure Pricing API.
 *
 * Each resource type uses a different OData filter strategy because the
 * Azure Pricing API organises records differently per service:
 *
 *   VMs / AKS nodes  → filter by armSkuName  (e.g. "Standard_D4s_v3")
 *   Managed Disks    → filter by skuName     (e.g. "P10 LRS")
 *   Load Balancer    → filter by serviceName + meterName
 *   Public IPs       → filter by serviceName + meterName + skuName
 *   Storage / Blob   → filter by skuName     (e.g. "Hot LRS")
 *   PostgreSQL/MySQL → filter by armSkuName  (same as VMs, different productName)
 *   Azure SQL DB     → filter by serviceName + meterName
 *   NAT Gateway      → filter by serviceName + meterName
 *   VNet Peering     → filter by serviceName + meterName
 *   AKS mgmt fee     → filter by serviceName + meterName
 *
 * Speed layers (per lookup):
 *   1. In-memory runtime cache  → 0ms
 *   2. Local SQLite DB          → <10ms  (populated by sync-prices.ts)
 *   3. Live OData API call      → ~200ms (always available, no auth)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "../db/prices.sqlite");
const AZURE_PRICE_API = "https://prices.azure.com/api/retail/prices";

// ── Types ─────────────────────────────────────────────────────────────────────

export type ResourceFamily =
  | "vm"
  | "disk"
  | "loadbalancer"
  | "publicip"
  | "storage"
  | "postgres"
  | "mysql"
  | "mssql"
  | "natgateway"
  | "vnet"
  | "aks";

export interface PriceRecord {
  key: string;
  region: string;
  retailPrice: number;
  unitOfMeasure: string;
  productName: string;
  skuName: string;
  source: "memory" | "sqlite" | "api";
}

interface AzureApiItem {
  armSkuName?: string;
  armRegionName: string;
  retailPrice: number;
  unitOfMeasure: string;
  productName: string;
  skuName: string;
  meterName: string;
  serviceName: string;
  priceType: string;
}

// ── In-memory runtime cache ───────────────────────────────────────────────────
const runtimeCache = new Map<string, PriceRecord>();

function buildCacheKey(family: ResourceFamily, qualifier: string, region: string): string {
  return `${family}::${qualifier.toLowerCase()}::${region.toLowerCase()}`;
}

// ── SQLite (lazy, readonly) ───────────────────────────────────────────────────
let _db: Database.Database | null = null;

function getDb(): Database.Database | null {
  if (_db) return _db;
  if (!fs.existsSync(DB_PATH)) return null;
  try {
    _db = new Database(DB_PATH, { readonly: true });
    return _db;
  } catch { return null; }
}

function fromSqlite(key: string, region: string): PriceRecord | null {
  const db = getDb();
  if (!db) return null;
  try {
    const row = db.prepare(
      `SELECT cache_key, region, retail_price, unit_of_measure, product_name, sku_name
       FROM prices WHERE cache_key = ? AND region = ? LIMIT 1`
    ).get(key, region.toLowerCase()) as any;
    if (!row) return null;
    return { key: row.cache_key, region: row.region, retailPrice: row.retail_price,
      unitOfMeasure: row.unit_of_measure, productName: row.product_name,
      skuName: row.sku_name, source: "sqlite" };
  } catch { return null; }
}

// ── Live API helpers ──────────────────────────────────────────────────────────

async function callApi(filter: string): Promise<AzureApiItem[]> {
  const url = `${AZURE_PRICE_API}?$filter=${encodeURIComponent(filter)}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Azure Pricing API ${res.status}: ${res.statusText}`);
  const json = (await res.json()) as { Items: AzureApiItem[] };
  return json.Items ?? [];
}

/** Pick best item — exclude Windows, Spot, Low Priority unless explicitly wanted */
function pickBest(items: AzureApiItem[], extraExclude: string[] = []): AzureApiItem | null {
  const exclude = ["windows", "spot", "low priority", ...extraExclude];
  return items.find((i) => {
    const h = `${i.skuName} ${i.meterName} ${i.productName}`.toLowerCase();
    return !exclude.some((t) => h.includes(t));
  }) ?? items[0] ?? null;
}

function toRecord(key: string, region: string, item: AzureApiItem): PriceRecord {
  return { key, region, retailPrice: item.retailPrice, unitOfMeasure: item.unitOfMeasure,
    productName: item.productName, skuName: item.skuName, source: "api" };
}

// ── Per-family live fetchers ──────────────────────────────────────────────────

// VMs and AKS node pools — armSkuName filter
async function fetchVm(sku: string, region: string) {
  const items = await callApi(
    `armSkuName eq '${sku}' and armRegionName eq '${region}' and priceType eq 'Consumption'`
  );
  return pickBest(items);
}

// Managed Disk — serviceName=Storage, skuName = "P10 LRS", productName includes "Disk"
async function fetchDisk(tier: string, redundancy: string, region: string) {
  const skuName = `${tier} ${redundancy}`;
  const items = await callApi(
    `serviceName eq 'Storage' and skuName eq '${skuName}' and armRegionName eq '${region}' and priceType eq 'Consumption'`
  );
  // Prefer records with "Disk" in productName to avoid Blob storage collision
  return items.find((i) => i.productName.toLowerCase().includes("disk")) ?? items[0] ?? null;
}

// Load Balancer
// Standard: charged per rule/hr + data processed/GB
// Basic: charged per data processed/GB only (rules are free)
async function fetchLb(tier: "Basic" | "Standard", region: string) {
  const items = await callApi(
    `serviceName eq 'Load Balancer' and armRegionName eq '${region}' and priceType eq 'Consumption'`
  );
  if (tier === "Standard") {
    return (
      items.find((i) =>
        i.meterName.toLowerCase().includes("rules") &&
        i.skuName.toLowerCase().includes("standard")
      ) ?? items.find((i) => i.meterName.toLowerCase().includes("rules")) ?? null
    );
  }
  return items.find((i) => i.meterName.toLowerCase().includes("data processed")) ?? items[0] ?? null;
}

// Public IP — serviceName=Virtual Network, meterName includes "IP Address"
async function fetchPublicIp(tier: "Basic" | "Standard", region: string) {
  const items = await callApi(
    `serviceName eq 'Virtual Network' and armRegionName eq '${region}' and priceType eq 'Consumption'`
  );
  return (
    items.find((i) =>
      i.meterName.toLowerCase().includes("ip address") &&
      i.skuName.toLowerCase().includes(tier.toLowerCase())
    ) ?? items.find((i) => i.meterName.toLowerCase().includes("ip address")) ?? null
  );
}

// Blob Storage — skuName = "Hot LRS", meterName = "Data Stored", productName includes "Blob"
async function fetchStorage(redundancy: string, accessTier: string, region: string) {
  const skuName = `${accessTier} ${redundancy}`;
  const items = await callApi(
    `serviceName eq 'Storage' and skuName eq '${skuName}' and armRegionName eq '${region}' and priceType eq 'Consumption'`
  );
  return (
    items.find((i) =>
      i.productName.toLowerCase().includes("blob") &&
      i.meterName.toLowerCase().includes("data stored")
    ) ?? items[0] ?? null
  );
}

// PostgreSQL Flexible Server — armSkuName filter, productName includes "PostgreSQL"
async function fetchPostgres(sku: string, region: string) {
  const items = await callApi(
    `armSkuName eq '${sku}' and armRegionName eq '${region}' and priceType eq 'Consumption'`
  );
  return items.find((i) => i.productName.toLowerCase().includes("postgresql")) ?? null;
}

// MySQL Flexible Server — armSkuName filter, productName includes "MySQL"
async function fetchMysql(sku: string, region: string) {
  const items = await callApi(
    `armSkuName eq '${sku}' and armRegionName eq '${region}' and priceType eq 'Consumption'`
  );
  return items.find((i) => i.productName.toLowerCase().includes("mysql")) ?? null;
}

// Azure SQL Database — serviceName=SQL Database, productName includes tier
// tier examples: "General Purpose", "Business Critical", "Hyperscale"
async function fetchMssql(tier: string, region: string) {
  const items = await callApi(
    `serviceName eq 'SQL Database' and armRegionName eq '${region}' and priceType eq 'Consumption'`
  );
  return (
    items.find((i) =>
      i.productName.toLowerCase().includes(tier.toLowerCase()) &&
      i.meterName.toLowerCase().includes("vcore")
    ) ?? items[0] ?? null
  );
}

// NAT Gateway — serviceName=Virtual Network, meterName includes "NAT Gateway"
// Two meters: "NAT Gateway Hours" and "Data Processed"
async function fetchNatGateway(region: string) {
  const items = await callApi(
    `serviceName eq 'Virtual Network' and armRegionName eq '${region}' and priceType eq 'Consumption'`
  );
  return items.find((i) => i.meterName.toLowerCase().includes("nat gateway")) ?? null;
}

// VNet Peering — serviceName=Virtual Network, meterName includes "Peering"
async function fetchVnetPeering(region: string) {
  const items = await callApi(
    `serviceName eq 'Virtual Network' and armRegionName eq '${region}' and priceType eq 'Consumption'`
  );
  return items.find((i) => i.meterName.toLowerCase().includes("peering")) ?? null;
}

// AKS Management Fee
// Free tier  → $0/hr  (meterName: "Free Cluster Management")
// Standard   → ~$0.10/hr (meterName: "Standard Cluster Management")
async function fetchAks(region: string) {
  const items = await callApi(
    `serviceName eq 'Azure Kubernetes Service' and armRegionName eq '${region}' and priceType eq 'Consumption'`
  );
  return (
    items.find((i) => i.meterName.toLowerCase().includes("standard cluster")) ??
    items.find((i) => i.meterName.toLowerCase().includes("cluster")) ??
    null
  );
}

// ── Public request interface ──────────────────────────────────────────────────

export interface PriceRequest {
  family: ResourceFamily;
  region: string;
  sku?: string;               // VMs, Postgres, MySQL
  diskTier?: string;          // "P10" | "E20" | "S30" etc.
  diskRedundancy?: string;    // "LRS" | "ZRS"
  tier?: "Basic" | "Standard";
  storageRedundancy?: string; // "LRS" | "ZRS" | "GRS" | "RA-GRS"
  accessTier?: string;        // "Hot" | "Cool" | "Cold" | "Archive"
  sqlTier?: string;           // "General Purpose" | "Business Critical"
  vcores?: number;
}

function buildQualifier(req: PriceRequest): string {
  switch (req.family) {
    case "vm":
    case "postgres":
    case "mysql":        return req.sku ?? "unknown";
    case "aks":          return "aks-standard-cluster";
    case "disk":         return `${req.diskTier ?? "P10"}-${req.diskRedundancy ?? "LRS"}`;
    case "loadbalancer": return `lb-${req.tier ?? "Standard"}`;
    case "publicip":     return `pip-${req.tier ?? "Standard"}`;
    case "storage":      return `${req.accessTier ?? "Hot"}-${req.storageRedundancy ?? "LRS"}`;
    case "mssql":        return `sql-${req.sqlTier ?? "General Purpose"}-${req.vcores ?? 4}vc`;
    case "natgateway":   return "nat-gateway";
    case "vnet":         return "vnet-peering";
    default:             return "unknown";
  }
}

// ── Main unified getter ───────────────────────────────────────────────────────

export async function getPrice(req: PriceRequest): Promise<PriceRecord> {
  const qualifier = buildQualifier(req);
  const key = buildCacheKey(req.family, qualifier, req.region);

  // Layer 1: memory
  const mem = runtimeCache.get(key);
  if (mem) return { ...mem, source: "memory" };

  // Layer 2: SQLite
  const sq = fromSqlite(key, req.region);
  if (sq) { runtimeCache.set(key, sq); return sq; }

  // Layer 3: live API
  let item: AzureApiItem | null = null;

  switch (req.family) {
    case "vm":           item = await fetchVm(req.sku!, req.region); break;
    case "aks":          item = await fetchAks(req.region); break;
    case "disk":         item = await fetchDisk(req.diskTier ?? "P10", req.diskRedundancy ?? "LRS", req.region); break;
    case "loadbalancer": item = await fetchLb(req.tier ?? "Standard", req.region); break;
    case "publicip":     item = await fetchPublicIp(req.tier ?? "Standard", req.region); break;
    case "storage":      item = await fetchStorage(req.storageRedundancy ?? "LRS", req.accessTier ?? "Hot", req.region); break;
    case "postgres":     item = await fetchPostgres(req.sku!, req.region); break;
    case "mysql":        item = await fetchMysql(req.sku!, req.region); break;
    case "mssql":        item = await fetchMssql(req.sqlTier ?? "General Purpose", req.region); break;
    case "natgateway":   item = await fetchNatGateway(req.region); break;
    case "vnet":         item = await fetchVnetPeering(req.region); break;
  }

  if (!item) throw new Error(`No Azure price found for ${req.family} / ${qualifier} in ${req.region}`);

  const record = toRecord(key, req.region, item);
  runtimeCache.set(key, record);
  return record;
}

/** hourly → monthly (730 hrs avg) */
export function toMonthly(hourlyPrice: number, count = 1): number {
  return hourlyPrice * count * 730;
}

/** per-GB price → monthly cost given storage size */
export function perGbMonthly(pricePerGb: number, gb: number, count = 1): number {
  return pricePerGb * gb * count;
}
