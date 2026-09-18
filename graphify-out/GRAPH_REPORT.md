# Graph Report - solarpanel-system  (2026-09-18)

## Corpus Check
- 68 files · ~40,500 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 559 nodes · 1078 edges · 24 communities (21 shown, 1 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 10 edges (avg confidence: 0.81)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `f7a03309`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- devDependencies
- compilerOptions
- dependencies
- compilerOptions
- snapshot.ts
- ReadingsStore
- http-client.ts
- useSunWindow.ts
- envelope.ts
- App.tsx
- index.ts
- CalendarHeatmap.tsx
- plumbing.test.ts
- EnergyAnalysis.tsx
- tsconfig.json
- BillHistory.tsx
- TokenStore
- SolaxEndpoints
- app.ts
- client.ts
- Skill Registry — solarpanel-system
- CLAUDE.md

## God Nodes (most connected - your core abstractions)
1. `registerApiRoutes()` - 24 edges
2. `SolaxEndpoints` - 19 edges
3. `compilerOptions` - 17 edges
4. `compilerOptions` - 17 edges
5. `SolaxError` - 14 edges
6. `ReadingsStore` - 13 edges
7. `SolaxHttpClient` - 13 edges
8. `TokenStore` - 13 edges
9. `RateLimiter` - 12 edges
10. `BillHistory()` - 12 edges

## Surprising Connections (you probably didn't know these)
- `freshStore()` --calls--> `ReadingsStore`  [EXTRACTED]
  tests/server/plumbing.test.ts → server/billing/readings-store.ts
- `registerApiRoutes()` --calls--> `runEnergyBank()`  [EXTRACTED]
  server/app.ts → core/billing/services/energy-bank.ts
- `registerApiRoutes()` --calls--> `projectBankDepletion()`  [EXTRACTED]
  server/app.ts → core/billing/services/energy-bank.ts
- `BillingSummaryResponse` --references--> `BalanceTrend`  [EXTRACTED]
  src/api/client.ts → core/billing/services/period-balance.ts
- `registerApiRoutes()` --calls--> `savingsFromOffset()`  [EXTRACTED]
  server/app.ts → core/billing/services/price-energy.ts

## Import Cycles
- None detected.

## Communities (24 total, 1 thin omitted)

### Community 0 - "devDependencies"
Cohesion: 0.08
Nodes (25): devDependencies, tailwindcss, @tailwindcss/vite, @types/d3-array, @types/d3-scale, @types/d3-shape, @types/node, @types/react (+17 more)

### Community 1 - "compilerOptions"
Cohesion: 0.08
Nodes (25): DOM, DOM.Iterable, ES2022, src, tests, compilerOptions, baseUrl, isolatedModules (+17 more)

### Community 2 - "dependencies"
Cohesion: 0.05
Nodes (36): d3-array, d3-scale, d3-shape, hono, @hono/node-server, motion, dependencies, d3-array (+28 more)

### Community 3 - "compilerOptions"
Cohesion: 0.08
Nodes (25): ES2023, node, server, vite.config.ts, vitest.config.ts, compilerOptions, baseUrl, isolatedModules (+17 more)

### Community 4 - "snapshot.ts"
Cohesion: 0.08
Nodes (56): deriveHouseLoad(), alarmSchema, BatteryInfoDto, batteryInfoSchema, BatteryRealtimeDto, batteryRealtimeSchema, DeviceType, EvChargerInfoDto (+48 more)

### Community 5 - "ReadingsStore"
Cohesion: 0.22
Nodes (7): emptyFile(), fileSchema, historySchema, isNotFound(), readingSchema, ReadingsFile, ReadingsStore

### Community 6 - "http-client.ts"
Cohesion: 0.21
Nodes (5): RequestOptions, SolaxHttpClientOptions, RateLimiter, RateLimiterOptions, RateLimitExceededError

### Community 7 - "useSunWindow.ts"
Cohesion: 0.35
Nodes (8): SystemTopology, dayOfYear(), formatMinute(), solarPosition, solarTerms(), sunTimes, useSunWindow(), PLANT

### Community 8 - "envelope.ts"
Cohesion: 0.13
Nodes (14): Envelope, envelopeSchema, HUMAN_MESSAGES, RETRYABLE, SOLAX_OK_AUTH, SOLAX_OK_BUSINESS, SolaxCode, SolaxCodeValue (+6 more)

### Community 9 - "App.tsx"
Cohesion: 0.06
Nodes (45): DaySample, DaySummary, summarizeDay(), SummarizeDayOptions, toKwh(), createQueryClient(), useDeleteReading(), useHealth() (+37 more)

### Community 10 - "index.ts"
Cohesion: 0.19
Nodes (11): apiErrorHandler(), describeEnv(), loadDotEnv(), loadEnv(), schema, app, dotEnvFound, env (+3 more)

### Community 11 - "CalendarHeatmap.tsx"
Cohesion: 0.38
Nodes (6): CalendarHeatmap(), Cell, DailyEnergy, DAYS, MONTHS, weekdayIndex()

### Community 12 - "plumbing.test.ts"
Cohesion: 0.14
Nodes (5): CachedResult, CacheEntry, TtlCache, TtlCacheOptions, freshStore()

### Community 13 - "EnergyAnalysis.tsx"
Cohesion: 0.09
Nodes (29): Watts, LoadSources, splitLoadSources(), PlantStatEntry, queryKeys, useDay(), useStatsMonth(), useStatsYear() (+21 more)

### Community 14 - "tsconfig.json"
Cohesion: 0.25
Nodes (7): compilerOptions, baseUrl, paths, files, core/*, @core/*, references

### Community 15 - "BillHistory.tsx"
Cohesion: 0.08
Nodes (37): assertScheduleWellFormed(), Tariff, TariffBlock, TariffSchedule, BlockBreakdown, breakdownByBlock(), marginalPricePerKwh(), priceEnergy() (+29 more)

### Community 17 - "TokenStore"
Cohesion: 0.29
Nodes (3): AppDeps, Env, TokenStore

### Community 18 - "SolaxEndpoints"
Cohesion: 0.16
Nodes (4): pagedSchema(), assertSnLimit(), SolaxEndpoints, SolaxHttpClient

### Community 20 - "app.ts"
Cohesion: 0.11
Nodes (25): assessDacRisk(), bimonthlyToMonthly(), DacBasis, MonthlyConsumption, balancePeriod(), BalanceTrend, PeriodBalance, PeriodBalanceInput (+17 more)

### Community 21 - "client.ts"
Cohesion: 0.06
Nodes (43): assertReadingsUsable(), MeterReading, monthsBetween(), parsePeriod(), DacRisk, addMonths(), BankPeriod, BankProjection (+35 more)

### Community 23 - "Skill Registry — solarpanel-system"
Cohesion: 0.33
Nodes (5): Contract, Loading protocol, Skill Registry — solarpanel-system, Skills, Sources scanned

## Knowledge Gaps
- **176 isolated node(s):** `TariffBlock`, `Tariff`, `MonthlyConsumption`, `CFE_CREDIT_LIFETIME_MONTHS`, `EnergyBankOptions` (+171 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 224 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **1 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `SystemTopology` connect `useSunWindow.ts` to `App.tsx`, `app.ts`, `snapshot.ts`, `client.ts`?**
  _High betweenness centrality (0.045) - this node is a cross-community bridge._
- **Why does `SolaxEndpoints` connect `SolaxEndpoints` to `TokenStore`, `index.ts`, `app.ts`, `snapshot.ts`?**
  _High betweenness centrality (0.035) - this node is a cross-community bridge._
- **Why does `ReadingsStore` connect `ReadingsStore` to `TokenStore`, `index.ts`, `app.ts`, `plumbing.test.ts`?**
  _High betweenness centrality (0.018) - this node is a cross-community bridge._
- **What connects `TariffBlock`, `Tariff`, `MonthlyConsumption` to the rest of the system?**
  _176 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `devDependencies` be split into smaller, more focused modules?**
  _Cohesion score 0.08 - nodes in this community are weakly interconnected._
- **Should `compilerOptions` be split into smaller, more focused modules?**
  _Cohesion score 0.08 - nodes in this community are weakly interconnected._
- **Should `dependencies` be split into smaller, more focused modules?**
  _Cohesion score 0.05405405405405406 - nodes in this community are weakly interconnected._