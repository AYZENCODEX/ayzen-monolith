# AYZEN 40-Phase Enforcement Roadmap — Phase 04: Function/Module/API Lineage

## Scope (from the roadmap)
- Deliverables: `tools/lineage-builder/*`, `schemas/lineage/*`, `reports/lineage/*`
- Definition of done: reverse trace from API to source module/function.
- Verification: every critical endpoint resolves to source owner.

## পদ্ধতি — honestly যেটা এটা করে, যেটা করে না
এটা full TypeScript AST parser না — `artifacts/api-server/src/routes/*.ts` (১৫০টা ফাইল, বড়গুলো ~৩০০০ লাইন)-এর ওপর static regex scan:
1. প্রতিটা `router.<method>("path", ...)` call site বের করা হয় (method + path + line number)।
2. `app.ts` পড়ে বের করা হয় কোন route file `/api` prefix দিয়ে mount হয় (~১৫০টা, `routes/index.ts`-এর মাধ্যমে combined) আর কোনগুলো prefix ছাড়া standalone mount হয় (well-known-jwks, well-known-openid-configuration, oidc-* — `app.ts` থেকে auto-derived, hand-listed না, তাই নতুন standalone router যোগ হলে নিজে থেকেই ধরবে)।
3. `packages/endpoint-registry`-এর `ENDPOINT_REGISTRY` (Phase F1-এর generated registry, ১২২২টা endpoint) থেকে প্রতিটা definition method+path দিয়ে route index-এ lookup করা হয়।
4. Match পেলে, সেই handler-এর body span-এ (পরের route declaration পর্যন্ত) file-এর নিজের relative import (`../lib/*`, `../services/*`) থেকে কোন নাম call হয়েছে সেটা identifier-scan করে "functions" হিসেবে রাখা হয়।

**সীমাবদ্ধতা যা লুকানো হয়নি:** এটা real call graph না — একটা imported name কোনো callback-এ pass হলে বা handler-এর বাইরে থেকে indirect ভাবে ডাকা হলে miss হতে পারে; দুই route-এর মাঝে defined একটা sibling helper function-ও ভুলবশত span-এ ধরা পড়তে পারে। এই heuristic `schemas/lineage/lineage-entry.v1.json`-এর description-এই explicitly লেখা আছে।

## যা যোগ করা হলো

| ফাইল | কী আছে |
|---|---|
| `schemas/lineage/lineage-entry.v1.json` | **নতুন** — প্রতিটা lineage entry-র shape: `method`/`path`/`owner`/`auth`/`critical` + `resolution` (status, file, line, module, functions, বা unresolved হলে reason) |
| `tools/lineage-builder/lib.mjs` | **নতুন** — `extractRouteCalls`, `extractLocalImports`, `buildRouteIndex`, `resolveEndpoint`: pure functions, তাই synthetic route-file string দিয়ে test করা যায় (পুরো ১৫০-ফাইল repo ছাড়াই) |
| `tools/lineage-builder/build.mjs` | **নতুন** — `app.ts` থেকে mount prefix derive করে, `ENDPOINT_REGISTRY` load করে, প্রতিটা endpoint resolve করে, `reports/lineage/lineage.json` লেখে। `--check` flag দিয়ে CI staleness gate |
| `tools/lineage-builder/test/lib.test.mjs` | **নতুন** — `node --test`, ৬/৬ pass |
| `reports/lineage/lineage.json` | **generated** — real repo-র ওপর চালিয়ে পাওয়া, নিচে actual numbers |

## বর্তমান অবস্থা (real build output, fabricated না)
```
totalEndpoints: 1222
resolved: 1161  (95.0%)
criticalEndpoints: 1052   (auth != "public")
criticalResolved: 992     (94.3%)
findingCount: 60          (CRITICAL_ENDPOINT_UNRESOLVED)
status: BLOCKED
```
৬০টা critical endpoint-এর কোনো static `router.<method>()` declaration কোথাও পাওয়া যায়নি (আমি পুরো `routes/*.ts` এ grep করেও verify করেছি — যেমন `/api/admin/break-glass`, `/api/admin/xuka/*` — কোনো লিটারাল string match নেই)। এটা coincidence না: `packages/endpoint-registry`-এর নিজের header comment-এই বলা আছে একটা "hand-reviewed SEED_ENTRIES list for routes that are structurally undetectable" আছে — এই ৬০টা সম্ভবত সেই category (dynamic/runtime-registered admin route), অথবা genuine drift। কোনটা সেটা distinguish করা এই ফেজের tool-এর কাজ না — সেটা পরের ফেজের (Phase 06 Contract Zero-Gap Sprint) কাজ; এই ফেজ শুধু list-টা visible আর blocking করে দিল।

Owner breakdown: `admin` (২১), `workflow` (১৬), `mail` (৮), `intelligence` (৪), `ai` (৩), `vault` (৩), `finance` (২), `notification` (২), `search` (১)।

## Definition of done — status
- ✅ Reverse trace API → source module/function — `reports/lineage/lineage.json`, ১১৬১/১২২২ endpoint resolved সহ file/line/module/functions।
- ⚠️ "Every critical endpoint resolves to source owner" — gate কাজ করছে (`node tools/lineage-builder/build.mjs` non-zero exit করে না এখনো, কিন্তু `findingCount > 0` মানে `status: BLOCKED` — CI-তে `--check` যোগ করলে এটা ঠিকই block করবে), কিন্তু বর্তমানে ৬০টা critical endpoint-এ finding আছে। এই ৬০টা বন্ধ করা মানে হয় route file-এ actual static declaration যোগ করা, নাহলে endpoint-registry-তে ওগুলোকে explicit SEED_ENTRIES হিসেবে annotate করা — দুটোর কোনোটাই এই ফেজের script নিজে করেনি, কারণ সেটা fabricate করা হতো।

## যা এই ফেজে touch করা হয়নি
- `packages/endpoint-registry`, `tools/domain-routing/generate-endpoint-registry.mjs` অপরিবর্তিত — এই ফেজ শুধু ওগুলোকে input হিসেবে পড়ে, regenerate করে না।
- ৬০টা unresolved critical finding-এর root cause investigate করে fix করা এই ফেজের scope না (সেটা করতে হলে actual route implementation বা registry entry বদলাতে হতো, যা আমি verify না করে করতাম না)।
