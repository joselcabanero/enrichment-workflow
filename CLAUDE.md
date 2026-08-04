# startup-enrich — project guide

A TypeScript/Node **startup enrichment + scouting-intelligence** pipeline. Given a company
name (+ optional domain), it assembles a unified profile from multiple sources, merges them
with **per-field provenance**, and (optionally) classifies the company against the caller's own
taxonomy. Built for foodtech/agtech deal scouting (user = Eatable Adventures).

## Resume here (immediate next task)
**Taxonomy is wired** (see memory: `taxonomy-classification.md` for where the ontology lives
and how it was mapped). `TaxonomyNode` now carries an optional `dimension` slug; when present,
`src/categorize.ts` classifies **independently per dimension in one API call** (per-dimension
primary + secondaries, leaf-preferred, deprecated terms excluded, enum-constrained to the
caller's IDs) and results land in `classification.dimensions`. Flat taxonomies behave as
before. `scripts/export-taxonomy.ts <taxonomy-repo> [out.json]` produces the node file; the
output is **gitignored — proprietary ontology, repo is public, never commit it**.

**Done (2026-08-03, live run):** all 7 demo companies classified per-dimension with a real
`ANTHROPIC_API_KEY` (key lives in the local `.env`, gitignored). One `needsReview`: Brami's
technology_stack (CPG brand, no distinctive tech — correct refusal). The demo artifact now
shows a **Classification — Jarvis taxonomy** section per card (primary highlighted + secondaries,
confidence, rationale, IDs in tooltips; classification also included in the raw-JSON details).
Note: nullable enum fields in the JSON schema must use `anyOf` — a `null` inside `enum` is a
400 (fixed in `src/categorize.ts`).

**Classification v2 (2026-08-03, after user feedback):** evidence-gated. Three outcomes per
dimension — classified / `notApplicable` (valid "no tech stack", e.g. CPG brands) /
`needsReview`; low-confidence assignments dropped in post-processing (low primary → review);
rationales must cite profile evidence; CPC codes explicitly not tech-stack evidence.
Classification runs on `CLASSIFY_MODEL` (default `claude-sonnet-5`); web research stays on
`RESEARCH_MODEL` haiku. Verified on the demo set: Brami + Foreverland tech stack →
not applicable (previously hallucinated "Supervised Learning"); Cocuus tech stack improved to
the specific `ts-mt-mg-foodprint` leaf. The model now abstains more (several needs-review) —
by design.

**Classification v3 (2026-08-04, stability):** `CLASSIFY_VOTES` (default 5) self-consistency
votes with lineage-aware majority aggregation (parent+descendant votes = one lineage →
most specific term; contested siblings → dominant sibling or shared parent; runner-up
lineages with ≥2 primary votes become secondaries; other secondaries need unanimity).
Prompt: market/use-case dimensions ~always apply (abstention there is wrong), tech dimensions
often don't; no overlapping siblings; secondaries only for what the company ITSELF does.
CLI `--reclassify <saved.json>` classifies a stored profile without re-running sources —
the repeatable path for DB use. Known limit: for genuinely ~50/50 sibling pairs (e.g.
`ts-mt-mg-3dbio` vs `ts-mt-mg-foodprint` for Cocuus) output oscillates within the lineage
(dominant sibling ↔ parent) — full determinism requires classify-once-and-store (DB cache,
future). Those near-duplicate leaves are also taxonomy feedback for Jarvis DB.

Next: cost-strategy remainder (DB cache w/ TTL, lazy enrichment, dedupe, credit budget).

## Build / run
```bash
npm install
npm run typecheck            # tsc --noEmit — keep clean
npm run build                # tsc -> dist/
node dist/cli.js "Stripe" --domain stripe.com            # markdown
node dist/cli.js "Notion" --domain notion.so --json --pretty
node dist/cli.js "Cocuus" --domain cocuus.com --taxonomy ./tax.json --json
# npm run enrich -- "…"  uses tsx (esbuild postinstall may be sandbox-skipped; prefer build+node)
```
Node 18+, near-zero deps (only `@anthropic-ai/sdk` runtime). No test suite yet — verify via
`typecheck` + CLI runs.

## Architecture
- `src/index.ts` — `enrich()` orchestrator: Wikidata first (yields a domain), then all keyed
  sources in parallel, merge, compute patent-search links, optional classify, render.
- `src/sources/*` — each returns a `SourceResult` (`ok|no_match|skipped|error` + partial data):
  `wikidata` (keyless), `apollo`, `dealroom`, `opencorporates`, `patents` (PatentsView/USPTO),
  `epo` (EPO OPS), `research` (Claude + web_search).
- `src/merge.ts` — per-field precedence + provenance; object fields (headquarters, socialLinks,
  patents) merge sub-fields across sources.
- `src/patentSearch.ts` — deterministic Google Patents + Espacenet links (company + per founder),
  **no API, always computed**.
- `src/cpc.ts` — CPC label map + subclass clustering.
- `src/categorize.ts` — taxonomy classification (enum-constrained to caller IDs).
- `src/report.ts` — markdown brief. `src/types.ts` — all types. `src/config.ts` — env keys.

## Source status (which run without keys)
| Source | Key | Notes |
|---|---|---|
| wikidata | none | keyless, always runs; scores candidates by org-type + official-website domain match |
| apollo | `APOLLO_API_KEY` | best for **headcount, revenue, growth, tech stack, funding** (its moat) |
| dealroom | `DEALROOM_API_KEY` | no free tier; built-to-spec, unexercised live |
| opencorporates | `OPENCORPORATES_API_TOKEN` | legal entity |
| patentsview | `PATENTSVIEW_API_KEY` | US grants only |
| epo | `EPO_OPS_KEY` + `EPO_OPS_SECRET` | EP/WO/worldwide; count, families, CPC, titles, priority/legal-status via kind codes |
| research (web) | `ANTHROPIC_API_KEY` | founders, funding, investors, accelerators, corporate, products, **TRL**, patent/IP read, CPC estimates. Default model `claude-haiku-4-5` (override `RESEARCH_MODEL`) |

Missing keys are **skipped, not fatal** — Wikidata-only still returns a profile. Sources report
their own status in `result.sources`.

## Key decisions & context
- **Cost strategy — waterfall FLIPPED (2026-08-04):** web research is now the primary source
  (extracts profile basics: description/industry/categories/foundedYear/HQ/employeeRange/
  LinkedIn, plus traction facts); **Apollo is opt-in per run** (`--apollo` /
  `enrich({apollo: true})`, 1 credit/match) for its 5-field moat: exact headcount, revenue,
  headcount growth, logo, verified socials. Merge precedence: structured sources still win
  when present; web fills gaps. Remaining cost work: **DB cache w/ TTL**, **lazy on-demand**
  enrichment, dedupe, **credit budget/dry-run**.
  ⚠️ Live verification of the flipped waterfall is PENDING — the Anthropic key ran out of
  credits mid-verification (2026-08-04). Once topped up: rerun the 7 demo companies, confirm
  web-sourced basics + provenance, refresh the artifact.
- **Apollo calls cost the user credits** — the MCP tool requires an explicit "1 credit per match"
  confirmation before every call, and the module now requires explicit opt-in too. Honor both.
- **Patents stack:** verified counts/families (EPO+USPTO when keyed) → legal status (granted/
  pending via kind codes) → CPC tech fingerprint → vintage/expiry (priority+20) → one-click
  verify links. Web research fills estimates when keys absent; EPO wins on merge.
- **Provenance is core** — every field records which source(s) supplied it; keep it. Traceability
  matters to the user (data quality).
- **No scraping** ToS-protected sites (Crunchbase/Dealroom/Tracxn); official APIs only.
- **Anthropic API code:** consult the `claude-api` skill for model IDs / params. Current cheap
  default `claude-haiku-4-5`; Haiku needs the **basic** `web_search_20250305` tool and **rejects**
  adaptive thinking + effort — the sources are already model-aware for this.

## ⚠️ Demo data is hand-populated
This sandbox has **no API keys** (Apollo came via the connected MCP tool; no `ANTHROPIC_API_KEY`,
no EPO/Dealroom/PatentsView keys, no `ant` profile). So EPO/web/classification could not run live
here — the published artifact's founders/funding/TRL/patent/CPC values were **populated by hand**
(real, sourced, but manual) to demonstrate the schema. The module code is built-to-spec and
typechecks; a future session **with keys** produces these automatically.

- **Demo artifact (7 foodtech companies):** https://claude.ai/code/artifact/81bee55d-0cd0-4023-bea6-a9478ee8d5ae
- **Tool-preview artifact (tech companies):** https://claude.ai/code/artifact/60e245b3-d5e0-44ef-a18c-f149522641d4
- Artifacts are private HTML (self-contained; CSP blocks remote assets, so logos are inlined
  data URIs). Republish same file path to keep the URL.

## Companies enriched so far (demo set)
Cocuus, MOA Foodtech, Ekonoke, Foreverland Food, Aflabox (EU foodtech) + Brami (US CPG) +
Optiflux (BE agtech). Three are Eatable Adventures portfolio (Cocuus, Ekonoke, Foreverland).

## Env
Copy `.env.example` → `.env`. All keys optional (module degrades gracefully).
`RESEARCH_MODEL` overrides the classify/research model.
