/**
 * tfvars-parser.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Parses Terraform .tfvars files and extracts all priceable Azure resources:
 *
 *   ✅ VM / AKS node pools
 *   ✅ Managed Disks
 *   ✅ Load Balancers
 *   ✅ Public IPs
 *   ✅ Storage Accounts / Blob
 *   ✅ Azure Database for PostgreSQL
 *   ✅ Azure Database for MySQL
 *   ✅ Azure SQL Database
 *   ✅ NAT Gateway
 *   ✅ VNet / Peering
 *   ✅ AKS Management Fee
 *
 * Strategy: pattern-match variable names → infer resource type and parameters.
 * Parsing is intentionally lenient — unknown variables are ignored.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import * as fs from "fs";
import type { ResourceFamily, PriceRequest } from "./azure-pricing.js";

// ── Parsed resource representation ───────────────────────────────────────────

export interface ParsedResource {
  /** Human-readable label shown in cost output */
  label: string;
  /** Number of units (instances, rules, IPs…) */
  count: number;
  /** Quantity for per-GB resources (storage GB, disk size) */
  sizeGb?: number;
  /** Fully typed price request — passed directly to getPrice() */
  priceReq: PriceRequest;
  /** Billing model hint for the cost calculation */
  billingModel: "hourly" | "per-gb-month" | "per-rule-hour" | "flat-per-hour";
}

// ── HCL tokeniser ─────────────────────────────────────────────────────────────
// Handles: key = "value", key = value, key = 123, key = true
// Does NOT handle complex HCL blocks (objects, lists) — those need a full parser.
// For tfvars files the flat key=value format is the standard.

function tokenise(content: string): Record<string, string> {
  const kv: Record<string, string> = {};
  const cleaned = content
    .replace(/#[^\n]*/g, "")   // strip # comments
    .replace(/\/\/[^\n]*/g, "") // strip // comments
    .replace(/\/\*[\s\S]*?\*\//g, ""); // strip /* */ blocks

  const re = /^[ \t]*(\w+)\s*=\s*"?([^"\n\r,{}[\]]+)"?/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned)) !== null) {
    kv[m[1].trim()] = m[2].trim();
  }
  return kv;
}

// ── Region normaliser ─────────────────────────────────────────────────────────

const REGION_ALIASES: Record<string, string> = {
  "east us":        "eastus",
  "east us 2":      "eastus2",
  "west europe":    "westeurope",
  "north europe":   "northeurope",
  "west us":        "westus",
  "west us 2":      "westus2",
  "central us":     "centralus",
  "uk south":       "uksouth",
  "uk west":        "ukwest",
  "southeast asia": "southeastasia",
  "australia east": "australiaeast",
};

function normaliseRegion(r: string): string {
  const l = r.toLowerCase().trim();
  return REGION_ALIASES[l] ?? l.replace(/\s+/g, "");
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isVmSku(v: string): boolean {
  return /^standard_[a-z0-9]/i.test(v.trim());
}

function isDbSku(v: string): boolean {
  // PostgreSQL / MySQL flexible server SKUs also look like VM SKUs
  return /^standard_[a-z0-9]/i.test(v.trim());
}

function isDiskTier(v: string): boolean {
  // P4..P80 (Premium SSD), E4..E80 (Standard SSD), S4..S80 (Standard HDD)
  return /^[PES]\d+$/i.test(v.trim());
}

function isDiskType(v: string): boolean {
  return /Premium_LRS|StandardSSD_LRS|Standard_LRS|UltraSSD_LRS|Premium_ZRS|StandardSSD_ZRS/i.test(v);
}

function diskTypeToTierAndRedundancy(diskType: string): { tier: string; redundancy: string } {
  // Map storage account type → approximate disk tier for pricing
  // This is used when only disk_type is specified without an explicit tier
  const upper = diskType.toUpperCase();
  if (upper.includes("PREMIUM")) return { tier: "P10", redundancy: upper.includes("ZRS") ? "ZRS" : "LRS" };
  if (upper.includes("STANDARDSSD")) return { tier: "E10", redundancy: upper.includes("ZRS") ? "ZRS" : "LRS" };
  return { tier: "S10", redundancy: "LRS" }; // Standard HDD
}

function getNum(kv: Record<string, string>, ...keys: string[]): number | undefined {
  for (const k of keys) {
    const v = kv[k];
    if (v !== undefined) {
      const n = parseInt(v, 10);
      if (!isNaN(n)) return n;
    }
  }
  return undefined;
}

function getStr(kv: Record<string, string>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    if (kv[k] !== undefined) return kv[k];
  }
  return undefined;
}

// ── Main parser ───────────────────────────────────────────────────────────────

export function parseTfvars(filePath: string): ParsedResource[] {
  if (!fs.existsSync(filePath)) {
    throw new Error(`tfvars file not found: ${filePath}`);
  }

  const content = fs.readFileSync(filePath, "utf8");
  const kv = tokenise(content);
  const resources: ParsedResource[] = [];

  // ── Resolve defaults shared across resources ──────────────────────────────
  const region = normaliseRegion(
    getStr(kv, "location", "region", "azure_region", "resource_location") ?? "eastus"
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. VM / AKS Node Pools
  //    Variables: node_vm_size, vm_size, node_size, system_node_vm_size, etc.
  // ═══════════════════════════════════════════════════════════════════════════
  const vmSkuKeys = Object.keys(kv).filter(
    (k) => /node_vm_size|vm_size|node_size|aks_vm_size|instance_type|machine_type|vm_sku|virtual_machine_size|machine_size/i.test(k) && isVmSku(kv[k])
  );

  for (const skuKey of vmSkuKeys) {
    // Try to find a paired count: system_node_count pairs with system_node_vm_size
    const prefix = skuKey.replace(/node_vm_size|vm_size|node_size|aks_vm_size|instance_type|machine_type|vm_sku|virtual_machine_size|machine_size/i, "").replace(/^_+|_+$/g, "");
    const countKey = Object.keys(kv).find(
      (k) => /node_count|vm_count|instance_count|replicas|count/i.test(k) &&
             (prefix ? k.includes(prefix) : true)
    );
    const count = countKey ? parseInt(kv[countKey], 10) : 1;

    resources.push({
      label: `VM / Node Pool: ${skuKey} (${kv[skuKey]}) ×${isNaN(count) ? 1 : count}`,
      count: isNaN(count) ? 1 : count,
      priceReq: { family: "vm", region, sku: kv[skuKey] },
      billingModel: "hourly",
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. AKS Management Fee
  //    Variables: aks_sku_tier, aks_tier, kubernetes_cluster_sku_tier
  //    "Free" → $0, "Standard" → ~$0.10/hr/cluster
  // ═══════════════════════════════════════════════════════════════════════════
  const aksTierVal = getStr(kv, "aks_sku_tier", "aks_tier", "kubernetes_cluster_sku_tier", "cluster_sku_tier");
  const aksEnabled = getStr(kv, "aks_enabled", "create_aks", "deploy_aks");

  // Include AKS fee if any AKS-related variable is found OR node pools were detected
  if (aksTierVal || vmSkuKeys.some((k) => /aks|node/i.test(k))) {
    const tier = aksTierVal?.toLowerCase() === "free" ? "Free" : "Standard";
    if (tier === "Standard") {
      const clusterCount = getNum(kv, "cluster_count", "aks_cluster_count") ?? 1;
      resources.push({
        label: `AKS Management Fee (Standard tier) ×${clusterCount} cluster`,
        count: clusterCount,
        priceReq: { family: "aks", region },
        billingModel: "flat-per-hour",
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. Managed Disks
  //    Variables: disk_size_gb, os_disk_size_gb, data_disk_size_gb,
  //               disk_type, os_disk_type, managed_disk_type, storage_account_type
  // ═══════════════════════════════════════════════════════════════════════════
  const osDiskType = getStr(kv, "os_disk_type", "os_disk_storage_account_type");
  const osDiskSize = getNum(kv, "os_disk_size_gb", "os_disk_size");
  const dataDiskType = getStr(kv, "managed_disk_type", "data_disk_type", "storage_account_type", "disk_type");
  const dataDiskSize = getNum(kv, "data_disk_size_gb", "disk_size_gb", "disk_size");
  const dataDiskCount = getNum(kv, "data_disk_count", "disk_count") ?? 1;
  const nodeCountForDisks = getNum(kv, "node_count", "vm_count", "instance_count") ?? 1;

  if (osDiskType && isDiskType(osDiskType)) {
    const { tier, redundancy } = diskTypeToTierAndRedundancy(osDiskType);
    resources.push({
      label: `OS Disk (${osDiskType}) ×${nodeCountForDisks}`,
      count: nodeCountForDisks,
      sizeGb: osDiskSize ?? 128,
      priceReq: { family: "disk", region, diskTier: tier, diskRedundancy: redundancy },
      billingModel: "per-gb-month",
    });
  }

  if (dataDiskType && isDiskType(dataDiskType)) {
    const { tier, redundancy } = diskTypeToTierAndRedundancy(dataDiskType);
    resources.push({
      label: `Data Disk (${dataDiskType}) ×${dataDiskCount}`,
      count: dataDiskCount,
      sizeGb: dataDiskSize ?? 128,
      priceReq: { family: "disk", region, diskTier: tier, diskRedundancy: redundancy },
      billingModel: "per-gb-month",
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. Load Balancer
  //    Variables: lb_sku, load_balancer_sku, lb_tier
  //    lb_rule_count, load_balancer_rule_count
  // ═══════════════════════════════════════════════════════════════════════════
  const lbSkuVal = getStr(kv, "lb_sku", "load_balancer_sku", "lb_tier", "load_balancer_tier");
  const lbCount = getNum(kv, "lb_count", "load_balancer_count") ?? (lbSkuVal ? 1 : 0);
  const lbRules = getNum(kv, "lb_rule_count", "load_balancer_rule_count", "lb_rules") ?? 1;

  if (lbSkuVal || lbCount > 0) {
    const lbTier = lbSkuVal?.toLowerCase().includes("basic") ? "Basic" : "Standard";
    resources.push({
      label: `Load Balancer (${lbTier}) ×${lbCount || 1}, ${lbRules} rules`,
      count: (lbCount || 1) * lbRules,
      priceReq: { family: "loadbalancer", region, tier: lbTier as "Basic" | "Standard" },
      billingModel: "per-rule-hour",
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 5. Public IPs
  //    Variables: public_ip_count, pip_count, public_ip_sku
  // ═══════════════════════════════════════════════════════════════════════════
  const pipCount = getNum(kv, "public_ip_count", "pip_count", "public_ip_address_count") ?? 0;
  const pipSku = getStr(kv, "public_ip_sku", "pip_sku") ?? "Standard";

  if (pipCount > 0) {
    resources.push({
      label: `Public IP (${pipSku}) ×${pipCount}`,
      count: pipCount,
      priceReq: {
        family: "publicip",
        region,
        tier: pipSku.toLowerCase().includes("basic") ? "Basic" : "Standard",
      },
      billingModel: "flat-per-hour",
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 6. Storage Accounts / Blob
  //    Variables: storage_account_kind, storage_replication_type,
  //               storage_access_tier, storage_size_gb, blob_storage_gb
  // ═══════════════════════════════════════════════════════════════════════════
  const storageReplication = getStr(kv, "storage_replication_type", "account_replication_type", "storage_redundancy") ?? "";
  const storageAccessTier  = getStr(kv, "storage_access_tier", "blob_access_tier", "access_tier") ?? "Hot";
  const storageSizeGb      = getNum(kv, "storage_size_gb", "blob_storage_gb", "storage_gb");
  const storageCount       = getNum(kv, "storage_account_count") ?? (storageReplication ? 1 : 0);

  if (storageReplication && storageSizeGb) {
    // Normalise replication type: "LRS" | "ZRS" | "GRS" | "RA-GRS"
    const replication = storageReplication.toUpperCase().replace(/[^A-Z-]/g, "");
    const tier = storageAccessTier.charAt(0).toUpperCase() + storageAccessTier.slice(1).toLowerCase();
    resources.push({
      label: `Blob Storage (${tier} ${replication}) ${storageSizeGb} GB ×${storageCount || 1}`,
      count: storageCount || 1,
      sizeGb: storageSizeGb,
      priceReq: { family: "storage", region, storageRedundancy: replication, accessTier: tier },
      billingModel: "per-gb-month",
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 7. Azure Database for PostgreSQL
  //    Variables: postgres_sku, postgresql_sku, db_postgres_sku
  //               postgres_count, postgresql_instance_count
  // ═══════════════════════════════════════════════════════════════════════════
  const pgSku = getStr(kv, "postgres_sku", "postgresql_sku", "db_postgres_sku", "postgres_vm_size", "postgresql_vm_size");
  const pgCount = getNum(kv, "postgres_count", "postgresql_count", "postgres_instance_count") ?? (pgSku ? 1 : 0);

  if (pgSku && isDbSku(pgSku) && pgCount > 0) {
    resources.push({
      label: `PostgreSQL Flexible Server (${pgSku}) ×${pgCount}`,
      count: pgCount,
      priceReq: { family: "postgres", region, sku: pgSku },
      billingModel: "hourly",
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 8. Azure Database for MySQL
  //    Variables: mysql_sku, mysql_vm_size, mysql_count
  // ═══════════════════════════════════════════════════════════════════════════
  const mysqlSku = getStr(kv, "mysql_sku", "mysql_vm_size", "db_mysql_sku");
  const mysqlCount = getNum(kv, "mysql_count", "mysql_instance_count") ?? (mysqlSku ? 1 : 0);

  if (mysqlSku && isDbSku(mysqlSku) && mysqlCount > 0) {
    resources.push({
      label: `MySQL Flexible Server (${mysqlSku}) ×${mysqlCount}`,
      count: mysqlCount,
      priceReq: { family: "mysql", region, sku: mysqlSku },
      billingModel: "hourly",
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 9. Azure SQL Database
  //    Variables: sql_tier, sql_service_tier, mssql_tier, sql_vcores
  //    Tiers: "General Purpose" | "Business Critical" | "Hyperscale"
  // ═══════════════════════════════════════════════════════════════════════════
  const sqlTierRaw = getStr(kv, "sql_tier", "sql_service_tier", "mssql_tier", "sql_edition");
  const sqlVcores  = getNum(kv, "sql_vcores", "sql_cores", "mssql_vcores") ?? 4;
  const sqlCount   = getNum(kv, "sql_count", "mssql_count", "sql_instance_count") ?? (sqlTierRaw ? 1 : 0);

  if (sqlTierRaw && sqlCount > 0) {
    // Normalise to the Azure pricing product name format
    const sqlTier = sqlTierRaw.toLowerCase().includes("business")
      ? "Business Critical"
      : sqlTierRaw.toLowerCase().includes("hyper")
      ? "Hyperscale"
      : "General Purpose";
    resources.push({
      label: `Azure SQL Database (${sqlTier}, ${sqlVcores} vCores) ×${sqlCount}`,
      count: sqlCount,
      priceReq: { family: "mssql", region, sqlTier, vcores: sqlVcores },
      billingModel: "hourly",
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 10. NAT Gateway
  //     Variables: nat_gateway_count, enable_nat_gateway, nat_gateway_enabled
  // ═══════════════════════════════════════════════════════════════════════════
  const natCount = getNum(kv, "nat_gateway_count");
  const natEnabled = getStr(kv, "enable_nat_gateway", "nat_gateway_enabled", "create_nat_gateway");

  const natTotal = natCount ?? (natEnabled && natEnabled !== "false" && natEnabled !== "0" ? 1 : 0);
  if (natTotal > 0) {
    resources.push({
      label: `NAT Gateway ×${natTotal}`,
      count: natTotal,
      priceReq: { family: "natgateway", region },
      billingModel: "flat-per-hour",
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 11. VNet Peering
  //     Variables: vnet_peering_count, peering_count
  //     Note: VNet itself is free; only peering data transfer is charged.
  // ═══════════════════════════════════════════════════════════════════════════
  const peeringCount = getNum(kv, "vnet_peering_count", "peering_count", "vnet_peer_count") ?? 0;
  const peeringGbMonth = getNum(kv, "peering_data_gb", "vnet_peering_gb") ?? 0;

  if (peeringCount > 0 && peeringGbMonth > 0) {
    resources.push({
      label: `VNet Peering ×${peeringCount} (est. ${peeringGbMonth} GB/month)`,
      count: peeringCount,
      sizeGb: peeringGbMonth,
      priceReq: { family: "vnet", region },
      billingModel: "per-gb-month",
    });
  }

  return resources;
}
