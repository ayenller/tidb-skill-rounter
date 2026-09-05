# nutshell-skills capability digest

Generated 2026-09-05T09:06:59.830Z from tidbcloud/nutshell-skills@dddd54f.
Do not edit; run `make catalog`. Load a full SKILL.md only when the plan selects it.

## daily_work

- `daily_work/tcoc-incident-review` [write-nonprod] — Daily review of TCOC Jira Incident tickets.
- `daily_work/tcocp-rca-writer` [explicit-only] — Use ONLY when a TCOCP-styled RCA (root cause analysis) report is explicitly requested.

## diagnosis

- `diagnosis/autoscaler-dashboard` — Use when evaluating HPA autoscaling quality or generating scaling report dashboards.
- `diagnosis/dedicated-cloud-diag` [entry, dedicated] — Diagnose Dedicated Cloud infra-provider CR / resource lifecycle (Cluster, APPBox, VPC, VPCPeering, PrivateLinkService) with read-only evidence.
- `diagnosis/pd-oncall-handbook` [entry] — Entry skill for PD on-call diagnosis.
- `diagnosis/pd-operations` — Reference handbook for PD operational incidents.
- `diagnosis/pd-placement-rules` — Reference handbook for PD placement-rule and isolation-label incidents.
- `diagnosis/pd-resource-control` — Reference handbook for PD resource-control incidents.
- `diagnosis/pd-scheduling` — Reference handbook for PD scheduler and region-health incidents.
- `diagnosis/ru-limit-inspection` [dedicated] — Use for contract-driven, read-only inspection of TiDB resource-group RU limits on proven dedicated-classic-v1 deployments, including RU/s limit utilization, over-limit…
- `diagnosis/ticdc-health-inspection` [entry] — Use when auditing TiCDC health from metrics, especially for clinic.pingcap.com clusters.
- `diagnosis/tidb-perf-diagnosis` [entry, dedicated/starter/essential/premium/byoc] — TiDB Cloud performance diagnosis and troubleshooting.
- `diagnosis/tidbcloud-dedicated-daily-inspection` [dedicated] — Run daily inspection for TiDB Cloud Dedicated clusters, generate one English report section per cluster, and archive results into one date-based daily report document.
- `diagnosis/tidbcloud-serverless-daily-inspection` [starter/essential] — Run pool-wide TiKV daily inspections for TiDB Cloud Serverless shared pools and generate English, screenshot-free daily report sections.
- `diagnosis/tikv-cdc` — Reference handbook for TiKV and TiCDC interaction issues.
- `diagnosis/tikv-fast-tune` — TiKV performance diagnosis using the Fast Tune methodology.
- `diagnosis/tikv-memory` — Reference skill for TiKV memory analysis and OOM diagnosis.
- `diagnosis/tikv-oncall-handbook` [entry] — Entry skill for TiKV on-call diagnosis.
- `diagnosis/tikv-panic` — Reference handbook for TiKV panic, crash, and restart-loop incidents.
- `diagnosis/tikv-performance` — Reference handbook for TiKV gRPC, disk, flow-control, and large-region diagnosis.
- `diagnosis/tikv-raftstore` — Reference handbook for TiKV raftstore and region-lifecycle issues.
- `diagnosis/tikv-recovery` — Reference handbook for TiKV recovery and data-loss scenarios.
- `diagnosis/tikv-scale` — Diagnose TiKV scale-out and scale-in behavior in TiDB clusters.
- `diagnosis/tikv-slow-diagnosis` — Diagnose TiKV-side latency regressions for Jira incidents or direct cluster investigations.
- `diagnosis/tikv-status-server` — Reference handbook for TiKV status-server and profiling issues.
- `diagnosis/tikv-storage` — Reference handbook for TiKV storage-engine and disk-related incidents.
- `diagnosis/transaction-oncall-handbook` — Reference handbook for TiDB Cloud transaction on-call diagnosis.

## finops

- `finops/alicloud-ecs-cpu-inventory` — List Alibaba Cloud International ECS instances (AliCloud equivalent of EC2) for a specified aliyun CLI profile and region.
- `finops/create-skill` [write-nonprod] — Create Cursor Agent Skills.

## growth

- `growth/analyzing-tidb-x-growth` [starter/essential/premium] — Analyzes TiDB X cluster growth (Starter, Essential, Premium service plans) from the GCP BigQuery BI table.

## health_check

- `health_check/tiflash-health-inspection` — Inspect TiFlash health for TiDB Cloud clusters from Clinic/O11Y metrics and generate a Markdown report.

## ops

- `ops/dedicated-cloud-ops` [entry, write-prod, explicit-only, dedicated] — Entry skill for Dedicated Cloud operations workflows.
- `ops/deploy-tidbx` [write-nonprod, self-hosted] — Deploy a single-machine TiDBX cluster to a fresh remote machine over SSH using local tikv/pd/tidb tar.gz binaries, including dependency bootstrap (tiup/latest go/mysql…
- `ops/deploy-tidbx-aws-multinode` [write-nonprod, self-hosted] — Deploy or review the canonical AWS EC2 multi-node TiDB X test shape: upstream nextgen PD/TiDB, cloud-engine TiKV and tikv-worker, real AWS S3 through a TiKV instance…
- `ops/manage-ticdc-changefeeds` [write-prod] — Manage and identify TiCDC changefeeds through `cdc cli`, OpenAPI v2, or TiDB Cloud Ops metadata.
- `ops/tcms-devbuild-rebuild` [write-nonprod] — Clone an existing PingCAP TCMS devbuild while preserving hidden build fields, override repository, git ref, version, product, or build options, and poll to a terminal…
- `ops/ticdc-next-gen-deploy` [write-nonprod, self-hosted] — Use when deploying or destroying a TiCDC next-gen test stack with TiUP, especially when you need SSH-based execution, configurable keyspace TiDB count, and optional…
- `ops/tidb-onebox` [write-nonprod, self-hosted] — How to deploy, validate, pause/resume, and destroy a TiDB-X on EKS dev environment using the one-box repo.

## platform

- `platform/alertstore-api` [write-nonprod] — Query and manage alerts in alertstore — the single source of truth for TiDB Cloud operational alerts.
- `platform/clinic-api` [entry, dedicated/byoc/starter/essential/premium] — Query PingCAP Clinic cluster metadata and observability data through canonical Data Proxy APIs plus capability-preserving compatibility helpers where migration is…
- `platform/devops-api` [entry, write-prod] — Also named Ops Portal, handle software delivery, operations, cluster tasks, and incidents.
- `platform/jira-api` [write-nonprod] — Team-shareable Jira REST API skill for accessing PingCAP Jira, searching issues, understanding key support/oncall/DM projects and custom fields, escalating support…
- `platform/o11y-auth` — Authenticate to the TiDB Cloud O11Y (Observability) platform via GitHub PAT.
- `platform/o11y-data` [dedicated/starter/essential/premium/byoc] — Access TiDB Cloud O11Y (Observability) data: authenticate via GitHub PAT, query cluster info and Prometheus metrics via API, access S3/GCS logs/slowlogs/statements,…
- `platform/o11y-data-export` [write-prod] — Create, manage O11Y monitoring pipelines (integration tasks) for TiDB Cloud Clusters.
- `platform/o11y-metrics-api` — Query TiDB Cloud O11Y (Observability) metrics via Prometheus-compatible API.
- `platform/op-clinic-grafana-access` [self-hosted] — Access On-Premises PingCAP Clinic and online Grafana data by reusing a local Chrome login session, discovering dashboard and panel PromQL from Grafana dashboard JSON,…
- `platform/tidbcloud-api` [write-prod, starter/essential/premium] — Interact with TiDB Cloud TiDBX APIs for Starter, Essential, and Premium tiers.
- `platform/tidbcloud-cli` [write-prod, starter/essential/premium/dedicated] — Use this skill when users want to operate TiDB Cloud resources through the ticloud CLI.
- `platform/tidbcloud-http` [write-prod, starter/essential] — Call TiDB Serverless HTTP endpoint directly, without SDK/driver.
- `platform/tidbcloud-serverless-pool-routing` [starter/essential] — Resolve a TiDB Cloud Serverless (Starter/Essential) shared-pool name such as us-west-2-f01 into the routing identities (pool, vendor, vendor-region, control_plane_info)…

## security

- `security` — Security guardrails for AI agents operating in restricted multi-cloud DBaaS environments.

## utilities

- `utilities/db9` [write-nonprod] — Instant serverless Postgres databases via the db9 CLI.
- `utilities/dbgen-playground-import` [write-nonprod, self-hosted] — Generate dbgen templates from user-provided table schemas, representative SQL, and EXPLAIN or statistics evidence, then validate them by generating CSVs, starting a…
- `utilities/dedicated-cloud-toolkit` [entry, write-nonprod, explicit-only, dedicated] — Entry skill for Dedicated Cloud toolkit.
- `utilities/manager` [explicit-only] — 显式将当前主 Agent 切换为管理角色，由其他 agents 执行具体工作。仅在用户调用 $manager 时使用。
- `utilities/oncall-api` [write-nonprod] — Drive the oncall service's REST API directly (instead of clicking through the web UI) to read and manage on-call duty.
- `utilities/oncall-toolkit` [write-nonprod] — Oncall workflow assistant for Jira and Pingkai tickets: report, RCA generation, filtered Jira or Pingkai issue listing, Jira close flows with preview or direct…
- `utilities/security` — AI agent security guardrails for operating in a restricted multi-cloud DBaaS environment.
