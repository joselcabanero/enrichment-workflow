# startup-enrich — project guide

A TypeScript/Node **startup enrichment + scouting-intelligence** pipeline. Given a company
name (+ optional domain), it assembles a unified profile from multiple sources, merges them
with **per-field provenance**, and (optionally) classifies the company against the caller's own
taxonomy. Built for foodtech/agtech deal scouting (user = Eatable Adventures).

## Resume here (immediate next task)
**Wire the user's taxonomy** for classification. The classify step is already built
(`src/categorize.ts`) and consumes a taxonomy passed to `enrich({ taxonomy })` or via CLI
`--taxonomy <path>`. The user will provide access to their **taxonomy/ontology from another
repo** ("Jarvis DB"). Steps to resume:
1. Read their taxonomy from the other repo; transform to `TaxonomyNode[]` =
   `[{ id, name, description?, parentId? }]` (their stable IDs — echoed back so results join).
2. Run classification on the 7 demo companies (needs `ANTHROPIC_API_KEY`) and add a **Category**
   line to each artifact card.
3. Confirm: leaf-node assignment + parent roll-up vs. top-vertical; single vs multi-label
   (currently **primary + secondaries**, each with confidence + rationale + `needsReview`).
- See memory: `taxonomy-classification.md` — **must use their ontology + their IDs; never invent
  categories; enum-constrained; flag `needsReview` when nothing fits.**

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
- **Cost strategy (planned next):** Apollo credits get expensive at DB scale. Plan = flip the
  waterfall: **search+Haiku primary** (covers ~everything cheaply), **Apollo optional** only for
  its 5-field moat (headcount/revenue/growth/tech/codes), plus **DB cache w/ TTL**, **lazy
  on-demand** enrichment, **field-gated** Apollo, dedupe, and a **credit budget/dry-run**. Not
  built yet — offered as the alternative to the classification work.
- **Apollo calls cost the user credits** — the MCP tool requires an explicit "1 credit per match"
  confirmation before every call. Honor that.
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
