# startup-enrich

Give it a startup **name** (and optionally a **domain**), get back everything available
from **free-tier sources** — as a normalized JSON object with per-field source
attribution **and** a human-readable markdown brief.

Built as a free alternative to Crunchbase (which removed its free API tier in 2025).
Uses official APIs only — no scraping of ToS-protected sites.

## Sources

| Source | Data | Credential | Free tier |
| --- | --- | --- | --- |
| **Wikidata / Wikipedia** | Description, founders, founded date, HQ, industry, website | none | keyless, always on |
| **Apollo.io** | **Opt-in (`--apollo`), 1 credit/match.** Moat: exact headcount, revenue, headcount growth, logo, verified socials | `APOLLO_API_KEY` | 75 credits/mo |
| **Dealroom** | Funding total, valuation, latest round, investors, growth stage | `DEALROOM_API_KEY` | no free tier (paid key) |
| **OpenCorporates** | Legal entity: company number, jurisdiction, incorporation, status, officers | `OPENCORPORATES_API_TOKEN` | free token for open-data use |
| **PatentsView (USPTO)** | US patent grants: count + most-recent by assignee | `PATENTSVIEW_API_KEY` | free key on request |
| **EPO Open Patent Services** | EP / WO / worldwide filings: verified count, jurisdictions, publications | `EPO_OPS_KEY` + `EPO_OPS_SECRET` | free registration |
| **Web research (Claude)** | **Primary source**: profile basics (description, industry, categories, HQ, founded, headcount range, LinkedIn) + founders, funding, investors, accelerators, corporate engagement, products, TRL, patent/IP read | `ANTHROPIC_API_KEY` | pay-per-use (default `claude-haiku-4-5`) |

Missing credentials are **skipped, not fatal** — with no keys at all you still get a full
Wikidata-based profile. A slow or failing source never blocks the others.

All sources merge into **one unified profile**. Every field keeps its origin in the
`provenance` map (for traceability and data-quality checks) even though a consumer UI can
ignore it and just read `company`.

## Setup

```bash
npm install
cp .env.example .env   # fill in whichever keys you have (optional)
```

## CLI

```bash
# keyless — Wikidata only
npm run enrich -- "Stripe"

# disambiguate with a domain, emit JSON
npm run enrich -- "Notion" --domain notion.so --json --pretty
```

Flags: `--domain/-d <domain>`, `--json`, `--md` (default), `--pretty`, `--help/-h`.

## Classification against your own taxonomy

Pass your taxonomy and each company is classified **strictly against it**, returning your
category IDs (never invented ones). Export your ontology to this shape:

```json
[
  { "id": "alt-protein", "name": "Alternative Proteins", "description": "plant-based, cultivated, mimetic…" },
  { "id": "fermentation", "name": "Precision & Biomass Fermentation", "parentId": "ingredients" }
]
```

```bash
enrich "Cocuus" --domain cocuus.com --taxonomy ./jarvis-taxonomy.json --json
```

The result gains a `classification` block — `primary` + `secondary` assignments (each with the
node's `id`, `name`, a confidence, and a one-line rationale). The `id`s come straight from your
file, so results join back to your DB. A JSON-schema `enum` constrains the model to your IDs —
it cannot return a category you didn't define. Needs `ANTHROPIC_API_KEY`; classification uses
`CLASSIFY_MODEL` (default `claude-sonnet-5` — separate from the cheaper web-research model).

Classification is **evidence-gated and vote-stabilized**: a term is assigned only when the
enriched profile explicitly supports it (rationales must point to the evidence), the classify
call runs `CLASSIFY_VOTES` times (default 5) and only majority-supported terms survive —
votes for a parent and its descendant count as one lineage (resolved to the most specific
term), contested sibling leaves resolve to the dominant one or their shared parent, and
secondaries require unanimity. Each result is one of three outcomes rather than a forced
guess:

- **classified** — `primary` (+ optional `secondary`) with confidence and rationale.
  Low-confidence assignments are discarded in post-processing, never surfaced.
- **`notApplicable: true`** — the category genuinely doesn't apply (e.g. a consumer CPG brand
  has no technology stack). A valid answer, not an error.
- **`needsReview: true`** — evidence too thin to decide; route to a human.

For repeatable results (e.g. DB pipelines), enrich once, store the JSON, and re-classify from
the stored profile — fixed evidence plus voting makes categories stable across runs:

```bash
enrich "Cocuus" --domain cocuus.com --json > cocuus.json      # research once
enrich --reclassify cocuus.json --taxonomy ./tax.json --json  # classify (repeatable)
```

### Multi-dimensional taxonomies

If your ontology has orthogonal dimensions (e.g. *application domain* / *market application* /
*technology stack*), add a `dimension` slug to each node. The company is then classified
**independently within each dimension** — one API call total — and the result carries
`classification.dimensions` (one `{ dimension, primary, secondary, notApplicable, needsReview }`
block per dimension) instead of a single top-level primary. The classifier prefers the most specific
(leaf) term and never assigns a term together with its ancestor.

`scripts/export-taxonomy.ts` converts a canonical-taxonomy repo (dimensions of terms with
`id`/`name`/`parent_id`/`description`/`excludes`/`synonyms`/`examples`, deprecated terms
dropped) into this flat node format:

```bash
npx tsx scripts/export-taxonomy.ts ../path-to-taxonomy-repo taxonomy.json
```

## Programmatic use

```ts
import { enrich } from "startup-enrich";

const result = await enrich({ name: "Stripe", domain: "stripe.com" });
result.company;     // normalized CompanyData
result.provenance;  // which source supplied each field
result.sources;     // per-source status: ok | no_match | skipped | error (+ candidates)
result.markdown;    // formatted brief
```

Build for `node`/publish: `npm run build` (emits `dist/`).

## How it works

1. **Wikidata** runs first (keyless) — it also yields an official domain so the keyed
   sources can match by domain instead of a fuzzy name search. It scores candidates by
   official-website match and organization type, so name collisions (e.g. *Vercel* the
   company vs. the French commune) resolve correctly.
2. **Web research**, **Dealroom**, **OpenCorporates**, **PatentsView** and **EPO** run in
   parallel with the resolved domain. **Apollo** joins only on explicit opt-in
   (`--apollo` / `enrich({ apollo: true })`) — each org match costs a credit, and its unique
   value is 5 fields: exact headcount, revenue, headcount growth, logo, verified socials.
3. Results are **merged** into one profile with per-field precedence — structured sources
   (Wikidata, Apollo, Dealroom, OpenCorporates, EPO/PatentsView) win where present; web
   research is the primary fallback that keeps small-startup profiles complete (basics +
   traction) when the DBs are silent — and every contributing source is recorded in
   `provenance`.

The **web research** source uses Claude (Anthropic Messages API) with the server-side
`web_search` tool to extract exactly the facts structured providers tend to miss for
early-stage startups — founders, funding rounds, investors, accelerator programs, corporate
engagement, products, a derived **TRL** (Technology Readiness Level), and a patent/IP read —
returned as structured data with `web` provenance. It's model-aware and defaults to the cheap
`claude-haiku-4-5` for DB-scale enrichment (override with `RESEARCH_MODEL`).

### Patents / IP

Patents merge across three sources into one `patents` object: **EPO OPS** for the verified
worldwide count + EP/WO publications, **PatentsView** for US grants, and **web research** for
the qualitative read (status, technology areas, one-line assessment). On top, every profile
gets **`patentSearch`** — deterministic Google Patents + Espacenet links by company *and* by
founder, computed with no API so a human can verify in one click even on a keyless run. Early
IP is often filed under a founder or a university (spin-out), so the per-founder links matter.

When a name is ambiguous (common name, multiple legal entities), the matching source
returns `candidates` instead of silently guessing.

## Extending

Add a source by implementing `(ctx: SourceContext) => Promise<SourceResult>` in
`src/sources/`, wiring it into `src/index.ts`, and adding its fields to the precedence maps
in `src/merge.ts`. FMP / SEC EDGAR / EPO OPS (European patents) would slot in this way.

> **Note on Dealroom & PatentsView:** both are implemented against their documented
> schemas but require a key to exercise live. Dealroom has no free tier; PatentsView's
> current Search API (`search.patentsview.org`) needs a free key (the old keyless
> `api.patentsview.org` was retired into USPTO's Open Data Portal in 2026). If your
> Dealroom account's field names differ, adjust `src/sources/dealroom.ts`.
