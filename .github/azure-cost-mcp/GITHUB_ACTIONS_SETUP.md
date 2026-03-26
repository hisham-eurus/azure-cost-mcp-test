# GitHub Actions Setup Guide — azure-cost-mcp

Complete setup for cost-gated PRs in a repo with `envs/prod/` and `envs/staging/` structure.

---

## 1. Repo Structure Required

```
your-infra-repo/
├── envs/
│   ├── prod/
│   │   ├── terraform.tfvars        ← your tfvars
│   │   └── .cost-baseline.json     ← auto-generated after first merge
│   └── staging/
│       ├── terraform.tfvars
│       └── .cost-baseline.json
│
└── .github/
    ├── azure-cost-mcp/             ← copy the MCP project here
    │   ├── src/
    │   ├── scripts/
    │   └── package.json
    └── workflows/
        ├── cost-review.yml         ← runs on PR
        ├── save-baselines.yml      ← runs on merge to main
        └── cost-override.yml       ← runs when cost-approved label added
```

Copy the entire `azure-cost-mcp` folder into `.github/azure-cost-mcp/` in your infra repo:

```bash
cp -r azure-cost-mcp /path/to/your-infra-repo/.github/azure-cost-mcp
```

Copy the three workflow files into `.github/workflows/`.

---

## 2. Configure Your Thresholds

Edit `.github/workflows/cost-review.yml` and set your thresholds:

```yaml
env:
  # Block merge if monthly cost increases by more than 20%
  COST_INCREASE_THRESHOLD_PCT: "20"

  # Block merge if monthly cost increases by more than $500/month
  # Set to "0" to disable
  COST_INCREASE_THRESHOLD_ABS: "500"
```

Both thresholds are checked independently — either one can block the merge.

---

## 3. Enable Branch Protection (CRITICAL)

This is what actually prevents merging when the cost check fails.

Go to: **GitHub → Your Repo → Settings → Branches → Add branch protection rule**

Set:
- **Branch name pattern**: `main`
- ✅ **Require status checks to pass before merging**
  - Search for and add: `Azure Cost Review`
- ✅ **Require branches to be up to date before merging**
- ✅ (Optional) **Restrict who can push to matching branches**

> ⚠️ The `Azure Cost Review` status check only appears in the search box AFTER
> the workflow has run at least once. Create a test PR first, then come back
> and add the status check to the branch protection rule.

---

## 4. Create the `cost-approved` Label

This label lets reviewers override a blocked PR.

Go to: **GitHub → Your Repo → Issues → Labels → New Label**

- **Name**: `cost-approved`
- **Color**: `#e4e669` (yellow)
- **Description**: `Approves a PR that exceeds the cost increase threshold`

---

## 5. First Run — Bootstrap Baselines

On first run there are no baselines yet. The workflow handles this gracefully:
- Shows a cost estimate instead of a diff
- Does NOT block the merge
- After the PR merges, `save-baselines.yml` automatically creates the baseline

So your first PR touching tfvars will always pass — the baseline is created from it.

---

## 6. Full PR Lifecycle

```
Developer changes envs/prod/terraform.tfvars
          │
          ▼
    Opens PR
          │
          ▼
    [cost-review.yml fires]
    ┌─────────────────────────────────────────────┐
    │  Detects changed tfvars files               │
    │  Fetches baseline from main branch          │
    │  Calls ci.ts diff → Azure Pricing API       │
    │  Posts markdown comment to PR               │
    │  Sets commit status: ✅ pass or ❌ fail     │
    └─────────────────────────────────────────────┘
          │
          ├── Cost OK → PR can be merged normally
          │
          └── Cost exceeds threshold
                    │
                    ▼
              PR is BLOCKED
              Comment shows: ⛔ Merge Blocked
                    │
                    ├── Reviewer adds label: cost-approved
                    │         │
                    │         ▼
                    │   [cost-override.yml fires]
                    │   Sets status to ✅ success
                    │   Posts override comment with reviewer name
                    │         │
                    │         ▼
                    │   PR can now be merged
                    │
                    └── Developer adjusts tfvars to reduce cost
                              │
                              ▼
                        New push → workflow re-runs
          │
          ▼
    PR merged to main
          │
          ▼
    [save-baselines.yml fires]
    Saves new .cost-baseline.json for each changed env
    Commits back to main
    Future PRs will diff against this new baseline
```

---

## 7. What the PR Comment Looks Like

### When cost increases within threshold (✅)

```
## ✅ Azure Cost Review — Passed

### 📈 Cost Increase — `prod`

> ⚠️ Cost will increase — within acceptable threshold

|          | Before    | After     | Change          |
|----------|-----------|-----------|-----------------|
| Monthly  | $1,022.80 | $1,723.60 | **+$700.80/mo (68.5%)** |

#### Changed Resources

| Change | Resource                              | Before   | After    | Delta          |
|--------|---------------------------------------|----------|----------|----------------|
| 🔄 changed | VM / Node Pool: node_vm_size ×5   | $700.80  | $1,401.60 | **+$700.80/mo** |

<details><summary>2 resource(s) unchanged</summary>
- AKS Management Fee: $73.00/mo
- OS Disk (Premium_LRS) ×5: $34.20/mo
</details>
```

### When cost exceeds threshold (⛔)

```
## ⛔ Azure Cost Review — Merge Blocked

- **prod**: Cost increases by 68.5% (+$700.80/mo), exceeds 20% threshold

A reviewer with cost-override permission must approve before merging.

### 📈 Cost Increase — `prod`
...
```

---

## 8. Customisation

### Watch additional paths
Edit the `paths:` filter in `cost-review.yml`:
```yaml
paths:
  - "envs/**/**.tfvars"
  - "infra/**/**.tfvars"       # add more patterns
  - "terraform/**/**.tfvars"
```

### Support multiple tfvars files per environment
The workflow picks the first `*.tfvars` file in the folder.
If you have multiple (e.g. `aks.tfvars` and `db.tfvars`), extend the loop in
`cost-review.yml` step 6 to iterate over `ls ${ENV_DIR}/*.tfvars`.

### Run cost check on all envs (not just changed ones)
Replace the `git diff` detection with a static list:
```bash
ENVS="envs/prod envs/staging envs/dev"
```

### Skip cost check for a PR
Add the label `skip-cost-check` to the PR and add a condition to the job:
```yaml
if: "!contains(github.event.pull_request.labels.*.name, 'skip-cost-check')"
```
