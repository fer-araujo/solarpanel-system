# Graph Report - solarpanel-system  (2026-09-18)

## Corpus Check
- 78 files · ~44,660 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 645 nodes · 1251 edges · 38 communities (32 shown, 3 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 11 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `d495a2d0`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- devDependencies
- compilerOptions
- dependencies
- compilerOptions
- snapshot.ts
- plumbing.test.ts
- ProductionCurve.tsx
- create-server.ts
- app.ts
- App.tsx
- SolaxEndpoints
- CalendarHeatmap.tsx
- AuthGate.tsx
- EnergyAnalysis.tsx
- tsconfig.json
- BillHistory.tsx
- ☀️ Solar
- TokenStore
- env.ts
- SolaxHttpClient
- client.ts
- queries.ts
- envelope.ts
- WeatherCard.tsx
- Skeleton.tsx
- CLAUDE.md
- power.ts
- readings-store.ts
- http-client.ts
- TtlCache
- RadialGauge.tsx
- vercel.json
- PowerGauge.tsx
- seed-upstash.mjs
- LoginScreen.tsx

## God Nodes (most connected - your core abstractions)
1. `registerApiRoutes()` - 25 edges
2. `SolaxEndpoints` - 20 edges
3. `compilerOptions` - 17 edges
4. `compilerOptions` - 17 edges
5. `TokenStore` - 16 edges
6. `SolaxError` - 14 edges
7. `SolaxHttpClient` - 14 edges
8. `createServer()` - 14 edges
9. `RateLimiter` - 13 edges
10. `TtlCache` - 13 edges

## Surprising Connections (you probably didn't know these)
- `registerApiRoutes()` --calls--> `SolaxError`  [EXTRACTED]
  server/app.ts → core/solax/dto/envelope.ts
- `topology()` --calls--> `SolaxError`  [EXTRACTED]
  server/app.ts → core/solax/dto/envelope.ts
- `EnergyFlowProps` --references--> `PowerSnapshot`  [EXTRACTED]
  src/ui/charts/EnergyFlow.tsx → core/energy/model/power.ts
- `freshStore()` --calls--> `ReadingsStore`  [EXTRACTED]
  tests/server/plumbing.test.ts → server/billing/readings-store.ts
- `registerApiRoutes()` --calls--> `savingsFromOffset()`  [EXTRACTED]
  server/app.ts → core/billing/services/price-energy.ts

## Import Cycles
- None detected.

## Communities (38 total, 3 thin omitted)

### Community 0 - "devDependencies"
Cohesion: 0.07
Nodes (27): esbuild, devDependencies, esbuild, tailwindcss, @tailwindcss/vite, @types/d3-array, @types/d3-scale, @types/d3-shape (+19 more)

### Community 1 - "compilerOptions"
Cohesion: 0.08
Nodes (25): DOM, DOM.Iterable, ES2022, src, tests, compilerOptions, baseUrl, isolatedModules (+17 more)

### Community 2 - "dependencies"
Cohesion: 0.05
Nodes (43): d3-array, d3-scale, d3-shape, hono, @hono/node-server, motion, dependencies, d3-array (+35 more)

### Community 3 - "compilerOptions"
Cohesion: 0.08
Nodes (25): ES2023, node, server, vite.config.ts, vitest.config.ts, compilerOptions, baseUrl, isolatedModules (+17 more)

### Community 4 - "snapshot.ts"
Cohesion: 0.08
Nodes (57): deriveHouseLoad(), alarmSchema, BatteryInfoDto, batteryInfoSchema, BatteryRealtimeDto, batteryRealtimeSchema, DeviceType, EvChargerInfoDto (+49 more)

### Community 6 - "ProductionCurve.tsx"
Cohesion: 0.12
Nodes (18): Watts, LoadSources, splitLoadSources(), PlantStatEntry, M, MonthlyEnergy(), MONTHS, SERIES (+10 more)

### Community 7 - "create-server.ts"
Cohesion: 0.27
Nodes (5): apiErrorHandler(), createServer(), createUpstashStore(), UpstashStore, app

### Community 8 - "app.ts"
Cohesion: 0.12
Nodes (24): assessDacRisk(), bimonthlyToMonthly(), DacBasis, MonthlyConsumption, balancePeriod(), BalanceTrend, PeriodBalance, PeriodBalanceInput (+16 more)

### Community 9 - "App.tsx"
Cohesion: 0.13
Nodes (14): DaySample, DaySummary, summarizeDay(), SummarizeDayOptions, toKwh(), useHealth(), useLogout(), useSnapshot() (+6 more)

### Community 10 - "SolaxEndpoints"
Cohesion: 0.24
Nodes (3): pagedSchema(), assertSnLimit(), SolaxEndpoints

### Community 11 - "CalendarHeatmap.tsx"
Cohesion: 0.38
Nodes (6): CalendarHeatmap(), Cell, DailyEnergy, DAYS, MONTHS, weekdayIndex()

### Community 12 - "AuthGate.tsx"
Cohesion: 0.22
Nodes (9): accessToken(), AuthConfig, AuthConfigError, getSupabase(), authKey, createQueryClient(), useMe(), AuthGate() (+1 more)

### Community 13 - "EnergyAnalysis.tsx"
Cohesion: 0.27
Nodes (11): queryKeys, useDay(), useStatsMonth(), useStatsYear(), EnergyAnalysis(), iso(), Mode, MODES (+3 more)

### Community 14 - "tsconfig.json"
Cohesion: 0.25
Nodes (7): compilerOptions, baseUrl, paths, files, core/*, @core/*, references

### Community 15 - "BillHistory.tsx"
Cohesion: 0.08
Nodes (37): assertScheduleWellFormed(), Tariff, TariffBlock, TariffSchedule, BlockBreakdown, breakdownByBlock(), marginalPricePerKwh(), priceEnergy() (+29 more)

### Community 17 - "☀️ Solar"
Cohesion: 0.13
Nodes (14): Architecture, Authentication, CFE, Deploy: Vercel + Upstash (free tier), Environment variables, Experience, Features, Getting started (+6 more)

### Community 18 - "TokenStore"
Cohesion: 0.19
Nodes (3): SolaxError, unwrapEnvelope(), TokenStore

### Community 19 - "env.ts"
Cohesion: 0.15
Nodes (14): AuthUser, registerAuth(), supabaseVerifier(), TokenVerifier, describeEnv(), loadDotEnv(), loadEnv(), schema (+6 more)

### Community 20 - "SolaxHttpClient"
Cohesion: 0.29
Nodes (3): AppDeps, Env, SolaxHttpClient

### Community 21 - "client.ts"
Cohesion: 0.10
Nodes (25): assertReadingsUsable(), MeterReading, monthsBetween(), parsePeriod(), DacRisk, addMonths(), BankPeriod, BankProjection (+17 more)

### Community 22 - "queries.ts"
Cohesion: 0.26
Nodes (13): api, useDeleteReading(), useReadings(), useReadingsMutation(), useSaveMeter(), useSaveReading(), Weather, Draft (+5 more)

### Community 23 - "envelope.ts"
Cohesion: 0.18
Nodes (11): Envelope, envelopeSchema, HUMAN_MESSAGES, RETRYABLE, SOLAX_OK_AUTH, SOLAX_OK_BUSINESS, SolaxCode, SolaxCodeValue (+3 more)

### Community 24 - "WeatherCard.tsx"
Cohesion: 0.21
Nodes (10): useWeather(), SunWindow, describe(), WeatherCard(), Card(), CardProps, Stat(), StatProps (+2 more)

### Community 25 - "Skeleton.tsx"
Cohesion: 0.18
Nodes (8): BillingSummaryResponse, BolsaPanel(), CONFIDENCE_LABEL, ChartSkeleton(), FlowSkeleton(), GaugeSkeleton(), RowsSkeleton(), StatSkeleton()

### Community 27 - "power.ts"
Cohesion: 0.09
Nodes (26): BatteryState, InverterState, KilowattHours, Percentage, PowerSample, PowerSnapshot, PvStringReading, SystemTopology (+18 more)

### Community 28 - "readings-store.ts"
Cohesion: 0.15
Nodes (8): emptyFile(), fileSchema, historySchema, isNotFound(), KvReadingsStore, readingSchema, ReadingsFile, ReadingsRepository

### Community 30 - "http-client.ts"
Cohesion: 0.21
Nodes (5): RequestOptions, SolaxHttpClientOptions, RateLimiter, RateLimiterOptions, RateLimitExceededError

### Community 31 - "TtlCache"
Cohesion: 0.16
Nodes (6): CachedResult, CacheEntry, TtlCache, TtlCacheOptions, TokenStoreOptions, KeyValueStore

### Community 32 - "RadialGauge.tsx"
Cohesion: 0.60
Nodes (5): arcPath(), atPercent(), polar(), RadialGauge(), RadialGaugeProps

### Community 33 - "vercel.json"
Cohesion: 0.40
Nodes (4): buildCommand, framework, installCommand, $schema

### Community 34 - "PowerGauge.tsx"
Cohesion: 1.00
Nodes (3): arc(), polar(), PowerGauge()

### Community 37 - "LoginScreen.tsx"
Cohesion: 0.40
Nodes (3): useLogin(), LoginScreen(), Spinner()

## Knowledge Gaps
- **197 isolated node(s):** `schema`, `AuthConfig`, `Mode`, `Tariff`, `TariffBlock` (+192 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 258 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **3 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `SystemTopology` connect `power.ts` to `app.ts`, `App.tsx`, `snapshot.ts`, `client.ts`?**
  _High betweenness centrality (0.044) - this node is a cross-community bridge._
- **Why does `SolaxEndpoints` connect `SolaxEndpoints` to `app.ts`, `SolaxHttpClient`, `snapshot.ts`, `create-server.ts`?**
  _High betweenness centrality (0.031) - this node is a cross-community bridge._
- **Why does `MeterReading` connect `client.ts` to `readings-store.ts`, `queries.ts`?**
  _High betweenness centrality (0.020) - this node is a cross-community bridge._
- **What connects `schema`, `AuthConfig`, `Mode` to the rest of the system?**
  _197 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `devDependencies` be split into smaller, more focused modules?**
  _Cohesion score 0.07407407407407407 - nodes in this community are weakly interconnected._
- **Should `compilerOptions` be split into smaller, more focused modules?**
  _Cohesion score 0.08 - nodes in this community are weakly interconnected._
- **Should `dependencies` be split into smaller, more focused modules?**
  _Cohesion score 0.045454545454545456 - nodes in this community are weakly interconnected._