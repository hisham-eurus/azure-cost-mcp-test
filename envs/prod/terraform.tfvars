# ── examples/full-stack.tfvars ────────────────────────────────────────────────
# Full-stack AKS + data tier example.
# All variables below are recognised by the azure-cost-mcp parser.
# Run: estimate_cost { tfvars_path: "examples/full-stack.tfvars" }
# ─────────────────────────────────────────────────────────────────────────────

# ── Shared ────────────────────────────────────────────────────────────────────
location    = "eastus"
environment = "production"

# ── AKS Node Pools ────────────────────────────────────────────────────────────
# System node pool (always-on, runs kube-system pods)
system_node_vm_size = "Standard_D2s_v3"
system_node_count   = 5

# User node pool (application workloads)
node_vm_size  = "Standard_D4s_v3"
node_count    = 5

# AKS management tier: "Free" = $0, "Standard" = ~$0.10/hr/cluster
aks_sku_tier  = "Standard"

# ── Managed Disks ────────────────────────────────────────────────────────────
os_disk_type        = "Premium_LRS"
os_disk_size_gb     = 128
managed_disk_type   = "StandardSSD_LRS"
data_disk_size_gb   = 256
data_disk_count     = 3

# ── Load Balancer ─────────────────────────────────────────────────────────────
lb_sku             = "Standard"
lb_rule_count      = 5

# ── Public IPs ───────────────────────────────────────────────────────────────
public_ip_count    = 2
public_ip_sku      = "Standard"

# ── Blob Storage ─────────────────────────────────────────────────────────────
storage_replication_type = "GRS"
storage_access_tier      = "Hot"
storage_size_gb          = 500

# ── PostgreSQL Flexible Server ────────────────────────────────────────────────
postgres_sku   = "Standard_D2s_v3"
postgres_count = 3

# ── MySQL Flexible Server ─────────────────────────────────────────────────────
mysql_sku   = "Standard_D2s_v3"
mysql_count = 3

# ── Azure SQL Database ────────────────────────────────────────────────────────
# sql_tier   = "General Purpose"
# sql_vcores = 4
# sql_count  = 1

# ── NAT Gateway ───────────────────────────────────────────────────────────────
enable_nat_gateway = true

# ── VNet Peering ──────────────────────────────────────────────────────────────
# Peering itself is free; you're billed per GB transferred.
vnet_peering_count = 2
peering_data_gb    = 100
