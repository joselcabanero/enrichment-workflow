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
| **Apollo.io** | Firmographics: employees, industry, funding, socials, logo | `APOLLO_API_KEY` | 75 credits/mo |
| **Dealroom** | Funding total, valuation, latest round, investors, growth stage | `DEALROOM_API_KEY` | no free tier (paid key) |
| **OpenCorporates** | Legal entity: company number, jurisdiction, incorporation, status, officers | `OPENCORPORATES_API_TOKEN` | free token for open-data use |
| **PatentsView (USPTO)** | US patent grants: count + most-recent by assignee | `PATENTSVIEW_API_KEY` | free key on request |
| **EPO Open Patent Services** | EP / WO / worldwide filings: verified count, jurisdictions, publications | `EPO_OPS_KEY` + `EPO_OPS_SECRET` | free registration |
| **Web research (Claude)** | Founders, funding, investors, accelerators, corporate engagement, products, TRL, patent/IP read | `ANTHROPIC_API_KEY` | pay-per-use (default `claude-haiku-4-5`) |

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
node's `id`, `name`, a confidence, and a one-line rationale) or `needsReview: true` when nothing
fits. The `id`s come straight from your file, so results join back to your DB. A JSON-schema
`enum` constrains the model to your IDs — it cannot return a category you didn't define. Needs
`ANTHROPIC_API_KEY`; classification uses `RESEARCH_MODEL` (default `claude-haiku-4-5`).

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
2. **Apollo**, **Dealroom**, **OpenCorporates**, **PatentsView** and **web research** run in
   parallel with the resolved domain.
3. Results are **merged** into one profile with per-field precedence — Wikidata for
   descriptive fields, Apollo for firmographics, Dealroom for funding/valuation/investors,
   web research for founders/funding/investors when the DBs are silent, OpenCorporates for
   legal entity, PatentsView for patents — and every contributing source is recorded in
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
