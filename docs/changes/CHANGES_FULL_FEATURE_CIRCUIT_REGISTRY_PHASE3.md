# AYZEN 40-Phase Enforcement Roadmap — Phase 03: Full Feature Circuit Registry

## Scope (from the roadmap)
- Deliverables: `schemas/circuit/*`, `infrastructure/platform/feature-circuits.json`, `services/circuit-registry/*`
- Definition of done: machine-readable circuit per production feature.
- Verification: missing-edge and incomplete-circuit gate.

## Non-duplication — কী দুটো জিনিসের ওপর এই ফেজ বসলো
দুটো জায়গায় circuit-shaped data আগে থেকেই ছিল, দুটোই আলাদা কাজের জন্য বানানো:
1. Phase 01-এর component registry-তে ৪টা `kind: "feature"` component, প্রতিটার `metadata.circuit`-এ hand-curated পুরো circuit (domain/api/service/db-resource/eventbus/audit/intelligence/artifact/deployment/admin-telegram) — richer কিন্তু মাত্র ৪টা।
2. `tools/circuit-registry/build.mjs` (আগে থেকেই ছিল) যেটা `packages/endpoint-registry` + `infra/event-catalog/catalog.json` থেকে auto-generate করে `config/circuit/platform-circuit.json` — এখন ৮৩টা circuit (feature/api/service/data/route/auth/policy/audit বা feature/event/consumers), কিন্তু Phase 01-এর feature component id-র সাথে wire করা ছিল না।

Phase 03 এই দুটোকে **রিপ্লেস বা ডুপ্লিকেট না করে** merge করে একটা single source of truth বানালো: `services/circuit-registry/*`।

## যা যোগ করা হলো

| ফাইল | কী আছে |
|---|---|
| `schemas/circuit/feature-circuit.v1.json` | **নতুন** — একটা circuit entry-র shape। Roadmap section 4-এর পুরো universal circuit (Feature→...→Enforcement Gate) কভার করে optional field হিসেবে, কিন্তু required শুধু যেগুলো এই মুহূর্তে actual source registry থেকে পাওয়া যায় (`feature`, `componentId`, `api`, `service`, `data`, `audit`, `stages`, `source`) — বাকিগুলো (scheduler/notification/telemetry/intelligence/recovery/lifecycle/runtime-graph/enforcement-gate) পরের ফেজ (13/16/17/24/30...) data দিলে populate হবে |
| `services/circuit-registry/src/validate.mjs` | **নতুন** — `validateCircuitDefinition()` + `REQUIRED_STAGES` (`feature`, `api`, `service`, `data`, `audit`) + `OPTIONAL_STAGES` |
| `services/circuit-registry/src/index.mjs` | **নতুন** — `createFeatureCircuitCatalog()`: register/resolve/resolveByFeature, আর `findings()`-এ দুটো gate implement করে — **missing-edge gate** (`REQUIRED_STAGE_MISSING`, critical) আর **incomplete-circuit gate** (`FEATURE_COMPONENT_UNTRACED`, critical — একটা Phase 01 feature component-এর কোনো circuit নেই; `CIRCUIT_MISSING_FEATURE_COMPONENT`, warning — একটা circuit-এর কোনো curated Phase 01 feature component নেই) |
| `services/circuit-registry/src/build.mjs` | **নতুন** — component-registry.json-এর ৪টা feature component + platform-circuit.json-এর ৮৩টা auto-derived circuit merge করে `infrastructure/platform/feature-circuits.json` লেখে। একই feature দুই জায়গায় থাকলে curated version জেতে। `--check` flag দিয়ে CI-তে staleness check করা যায় (`tools/circuit-registry/build.mjs`-এর existing `--check` pattern অনুসরণ করে) |
| `infrastructure/platform/feature-circuits.json` | **generated** — বর্তমানে ৮৭টা circuit (৪ curated + ৮৩ auto-derived), `completeness`/`findings` embedded |
| `services/circuit-registry/test/index.test.mjs` | **নতুন** — `node --test`, ১০/১০ pass: schema validation, দুই gate-এর প্রতিটার positive+negative case, completeness ratio |

## বর্তমান অবস্থা (build চালিয়ে পাওয়া actual numbers, fabricated না)
```
totalCircuits: 87
requiredStageComplete: 87/87  (ratio 1.0)   ← missing-edge gate: ০টা finding
tracedToFeatureComponent: 4/87 (ratio 0.046) ← incomplete-circuit gate: ৮৩টা warning
knownFeatureComponents: 4, সবগুলোই traced   ← ০টা critical FEATURE_COMPONENT_UNTRACED
status: READY (warning আছে, critical নেই)
```
মানে: যে ৮৭টা circuit registered আছে তার প্রতিটার required stage (feature/api/service/data/audit) সম্পূর্ণ — missing-edge gate clean। কিন্তু মাত্র ৪টা circuit-এর একটা curated Phase 01 feature component আছে; বাকি ৮৩টা (সবগুলোই endpoint/event auto-derived) এখনো কোনো Phase 01 feature-এ promote করা হয়নি — এই ৮৩টা warning-ই বলে দেয় Phase 01-এর feature backlog ঠিক কতটা বাকি, সংখ্যাটা লুকানো হয়নি।

## Definition of done — status
- ✅ Machine-readable circuit per production feature — `infrastructure/platform/feature-circuits.json`, schema-validated।
- ✅ Missing-edge gate — `REQUIRED_STAGE_MISSING`, প্রতিটা registered circuit-এ enforced, বর্তমানে ০টা finding।
- ⚠️ Incomplete-circuit gate — `FEATURE_COMPONENT_UNTRACED`/`CIRCUIT_MISSING_FEATURE_COMPONENT` দুটোই কাজ করছে (test করা আছে), কিন্তু গেটটা যা ধরার কথা সেটাই এখন ধরছে: ৮৩টা circuit এখনো কোনো curated Phase 01 feature-এ traced না। এই gap বন্ধ করা মানে Phase 01-এ আরো feature component register করা (ongoing, এই ফেজের scope না — Phase 01-এর নিজের কাজ)।

## যা এই ফেজে touch করা হয়নি
- `tools/circuit-registry/build.mjs` অপরিবর্তিত রাখা হয়েছে — সেটা এখনো `config/circuit/platform-circuit.json` নিজের মতো generate করে; `services/circuit-registry/src/build.mjs` সেটাকে input হিসেবে পড়ে, ওভাররাইট করে না।

## Addendum — Phase 01/03 gap বন্ধ করা হলো
`tools/component-registry/promote-circuits-to-features.mjs` (**নতুন**) — বাকি ৮৩টা auto-derived circuit-কে `infrastructure/platform/feature-completeness.json`-এ curated feature entry হিসেবে promote করে (`service-registry.json` থেকে সঠিক owner resolve করে, fabricate না করে)। Idempotent — আগে থেকে থাকা id আবার promote করে না (re-run করে verify করা হয়েছে: দ্বিতীয়বার `promoted: 0`)।

তারপর `tools/component-registry/build.mjs` + `services/circuit-registry/src/build.mjs` re-run করে regenerate করা হলো। Before/after:

```
                          আগে       পরে
component-registry total  112   →   195   (feature kind: 4 → 87)
feature-circuits traced   4/87  →   87/87  (ratio 0.046 → 1.0)
feature-circuits findings 83    →   0
```

সব test suite আবার pass করে (component-registry 9/9, circuit-registry 10/10, identity-context 11/11, correlation 7/7), `--check` flag দিয়ে idempotency confirm করা হয়েছে।

**Assumption যেটা flag করা দরকার:** promoted প্রতিটা feature-এর `api-server: "monolith"` আর `artifact: "api-gateway"` / `deployment: "<service>-deployment"` set করা হয়েছে existing ৪টা curated entry-র pattern অনুসরণ করে — endpoint registry-তে per-route hosting-এর real data নেই, তাই এই ৩টা field একটা reasonable default, real inspection না। `workspace`, `authorization`, `event-bus`, `audit`, `alerting`, `incident`, `backup` — এই ৭টা circuit-এর `service` value কোনো `service-registry.json` id-র সাথে মেলেনি, তাই owner `"platform"` fallback হয়েছে; কেউ manually review করে নিলে ভালো হয়।
