# Graph Report - solarpanel-system  (2026-09-18)

## Corpus Check
- 79 files · ~45,538 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 643 nodes · 1246 edges · 37 communities (30 shown, 4 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 11 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `3d32a755`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- devDependencies
- compilerOptions
- dependencies
- compilerOptions
- snapshot.ts
- readings-store.ts
- ProductionCurve.tsx
- KeyValueStore
- app.ts
- App.tsx
- SolaxEndpoints
- CalendarHeatmap.tsx
- AuthGate.tsx
- queries.ts
- tsconfig.json
- BillHistory.tsx
- ☀️ Solar
- envelope.ts
- create-server.ts
- auth.test.ts
- client.ts
- ReadingsForm.tsx
- Skill Registry — solarpanel-system
- WeatherCard.tsx
- Skeleton.tsx
- CLAUDE.md
- ImpactCard.tsx
- ReadingsRepository
- RateLimiter
- TtlCache
- RadialGauge.tsx
- vercel.json
- PowerGauge.tsx
- seed-upstash.mjs

## God Nodes (most connected - your core abstractions)
1. `registerApiRoutes()` - 25 edges
2. `SolaxEndpoints` - 20 edges
3. `compilerOptions` - 17 edges
4. `compilerOptions` - 17 edges
5. `TokenStore` - 16 edges
6. `SolaxError` - 14 edges
7. `createServer()` - 14 edges
8. `SolaxHttpClient` - 14 edges
9. `TtlCache` - 13 edges
10. `RateLimiter` - 13 edges

## Surprising Connections (you probably didn't know these)
- `registerApiRoutes()` --calls--> `runEnergyBank()`  [EXTRACTED]
  server/app.ts → core/billing/services/energy-bank.ts
- `registerApiRoutes()` --calls--> `projectBankDepletion()`  [EXTRACTED]
  server/app.ts → core/billing/services/energy-bank.ts
- `registerApiRoutes()` --calls--> `savingsFromOffset()`  [EXTRACTED]
  server/app.ts → core/billing/services/price-energy.ts
- `TodayResponse` --references--> `PowerSnapshot`  [EXTRACTED]
  src/api/client.ts → core/energy/model/power.ts
- `EnergyFlowProps` --references--> `PowerSnapshot`  [EXTRACTED]
  src/ui/charts/EnergyFlow.tsx → core/energy/model/power.ts

## Import Cycles
- None detected.

## Communities (37 total, 4 thin omitted)

### Community 0 - "devDependencies"
Cohesion: 0.07
Nodes (27): esbuild, devDependencies, esbuild, tailwindcss, @tailwindcss/vite, @types/d3-array, @types/d3-scale, @types/d3-shape (+19 more)

### Community 1 - "compilerOptions"
Cohesion: 0.08
Nodes (25): DOM, DOM.Iterable, ES2022, src, tests, compilerOptions, baseUrl, isolatedModules (+17 more)

### Community 2 - "dependencies"
Cohesion: 0.05
Nodes (41): d3-array, d3-scale, d3-shape, hono, @hono/node-server, motion, dependencies, d3-array (+33 more)

### Community 3 - "compilerOptions"
Cohesion: 0.08
Nodes (25): ES2023, node, server, vite.config.ts, vitest.config.ts, compilerOptions, baseUrl, isolatedModules (+17 more)

### Community 4 - "snapshot.ts"
Cohesion: 0.08
Nodes (56): deriveHouseLoad(), alarmSchema, BatteryInfoDto, batteryInfoSchema, BatteryRealtimeDto, batteryRealtimeSchema, DeviceType, EvChargerInfoDto (+48 more)

### Community 5 - "readings-store.ts"
Cohesion: 0.15
Nodes (8): emptyFile(), fileSchema, historySchema, isNotFound(), readingSchema, ReadingsFile, ReadingsStore, freshStore()

### Community 6 - "ProductionCurve.tsx"
Cohesion: 0.12
Nodes (18): Watts, LoadSources, splitLoadSources(), PlantStatEntry, M, MonthlyEnergy(), MONTHS, SERIES (+10 more)

### Community 7 - "KeyValueStore"
Cohesion: 0.19
Nodes (6): CachedResult, CacheEntry, TtlCacheOptions, createUpstashStore(), KeyValueStore, UpstashStore

### Community 8 - "app.ts"
Cohesion: 0.12
Nodes (24): assessDacRisk(), bimonthlyToMonthly(), DacBasis, MonthlyConsumption, balancePeriod(), PeriodBalance, PeriodBalanceInput, summarizeBalances() (+16 more)

### Community 9 - "App.tsx"
Cohesion: 0.13
Nodes (14): DaySample, DaySummary, summarizeDay(), SummarizeDayOptions, toKwh(), useHealth(), useLogout(), useSnapshot() (+6 more)

### Community 10 - "SolaxEndpoints"
Cohesion: 0.17
Nodes (4): pagedSchema(), assertSnLimit(), SolaxEndpoints, SolaxHttpClient

### Community 11 - "CalendarHeatmap.tsx"
Cohesion: 0.38
Nodes (6): CalendarHeatmap(), Cell, DailyEnergy, DAYS, MONTHS, weekdayIndex()

### Community 12 - "AuthGate.tsx"
Cohesion: 0.14
Nodes (9): ApiError, request(), createQueryClient(), useLogin(), useMe(), AuthGate(), LoginScreen(), host (+1 more)

### Community 13 - "queries.ts"
Cohesion: 0.23
Nodes (14): api, authKey, queryKeys, useDay(), useStatsMonth(), useStatsYear(), Weather, EnergyAnalysis() (+6 more)

### Community 14 - "tsconfig.json"
Cohesion: 0.25
Nodes (7): compilerOptions, baseUrl, paths, files, core/*, @core/*, references

### Community 15 - "BillHistory.tsx"
Cohesion: 0.11
Nodes (28): assertScheduleWellFormed(), Tariff, TariffBlock, TariffSchedule, BlockBreakdown, breakdownByBlock(), marginalPricePerKwh(), priceEnergy() (+20 more)

### Community 17 - "☀️ Solar"
Cohesion: 0.13
Nodes (14): Architecture, Authentication, CFE, Deploy: Vercel + Upstash (free tier), Environment variables, Experience, Features, Getting started (+6 more)

### Community 18 - "envelope.ts"
Cohesion: 0.10
Nodes (17): Envelope, envelopeSchema, HUMAN_MESSAGES, RETRYABLE, SOLAX_OK_AUTH, SOLAX_OK_BUSINESS, SolaxCode, SolaxCodeValue (+9 more)

### Community 19 - "create-server.ts"
Cohesion: 0.24
Nodes (10): apiErrorHandler(), createServer(), describeEnv(), loadDotEnv(), loadEnv(), schema, app, dotEnvFound (+2 more)

### Community 20 - "auth.test.ts"
Cohesion: 0.22
Nodes (10): AppDeps, loginSchema, matches(), parseSession(), registerAuth(), currentUser(), Env, appWith() (+2 more)

### Community 21 - "client.ts"
Cohesion: 0.06
Nodes (50): assertReadingsUsable(), MeterReading, monthsBetween(), parsePeriod(), DacRisk, addMonths(), BankPeriod, BankProjection (+42 more)

### Community 22 - "ReadingsForm.tsx"
Cohesion: 0.29
Nodes (11): useDeleteReading(), useReadings(), useReadingsMutation(), useSaveMeter(), useSaveReading(), Draft, EMPTY, ReadingsForm() (+3 more)

### Community 23 - "Skill Registry — solarpanel-system"
Cohesion: 0.33
Nodes (5): Contract, Loading protocol, Skill Registry — solarpanel-system, Skills, Sources scanned

### Community 24 - "WeatherCard.tsx"
Cohesion: 0.21
Nodes (10): useWeather(), SunWindow, describe(), WeatherCard(), Card(), CardProps, Stat(), StatProps (+2 more)

### Community 25 - "Skeleton.tsx"
Cohesion: 0.20
Nodes (7): BolsaPanel(), CONFIDENCE_LABEL, ChartSkeleton(), FlowSkeleton(), GaugeSkeleton(), RowsSkeleton(), StatSkeleton()

### Community 27 - "ImpactCard.tsx"
Cohesion: 0.27
Nodes (9): estimateDailySavings(), CO2_KG_PER_KWH, CO2_KG_PER_TREE_YEAR, COAL_KG_PER_KWH, environmentalBenefits, useBillingSummary(), usePlantRealtime(), ImpactCard() (+1 more)

### Community 30 - "RateLimiter"
Cohesion: 0.20
Nodes (3): RateLimiter, RateLimiterOptions, RateLimitExceededError

### Community 32 - "RadialGauge.tsx"
Cohesion: 0.60
Nodes (5): arcPath(), atPercent(), polar(), RadialGauge(), RadialGaugeProps

### Community 33 - "vercel.json"
Cohesion: 0.40
Nodes (4): buildCommand, framework, installCommand, $schema

### Community 34 - "PowerGauge.tsx"
Cohesion: 1.00
Nodes (3): arc(), polar(), PowerGauge()

## Knowledge Gaps
- **199 isolated node(s):** `TariffBlock`, `Tariff`, `MonthlyConsumption`, `CFE_CREDIT_LIFETIME_MONTHS`, `EnergyBankOptions` (+194 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 260 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **4 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `SystemTopology` connect `client.ts` to `app.ts`, `App.tsx`, `snapshot.ts`?**
  _High betweenness centrality (0.043) - this node is a cross-community bridge._
- **Why does `SolaxEndpoints` connect `SolaxEndpoints` to `app.ts`, `create-server.ts`, `auth.test.ts`, `snapshot.ts`?**
  _High betweenness centrality (0.030) - this node is a cross-community bridge._
- **Why does `MeterReading` connect `client.ts` to `queries.ts`, `ReadingsRepository`, `readings-store.ts`, `ReadingsForm.tsx`?**
  _High betweenness centrality (0.020) - this node is a cross-community bridge._
- **What connects `TariffBlock`, `Tariff`, `MonthlyConsumption` to the rest of the system?**
  _199 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `devDependencies` be split into smaller, more focused modules?**
  _Cohesion score 0.07407407407407407 - nodes in this community are weakly interconnected._
- **Should `compilerOptions` be split into smaller, more focused modules?**
  _Cohesion score 0.08 - nodes in this community are weakly interconnected._
- **Should `dependencies` be split into smaller, more focused modules?**
  _Cohesion score 0.047619047619047616 - nodes in this community are weakly interconnected._