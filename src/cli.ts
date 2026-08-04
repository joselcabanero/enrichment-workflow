#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { categorize, enrich } from "./index.js";
import type { EnrichmentResult, TaxonomyNode } from "./types.js";

const HELP = `startup-enrich — assemble startup info from free-tier sources

Usage:
  enrich "<startup name>" [--domain <domain>] [--json | --md] [--pretty]

Options:
  --domain, -d   Optional domain/URL to disambiguate (e.g. stripe.com)
  --taxonomy, -t Path to a taxonomy JSON file ([{id,name,description?,parentId?,dimension?}])
                 to classify the company against (needs ANTHROPIC_API_KEY)
  --reclassify   Path to a previously saved --json result: skip the sources and
                 re-run only the taxonomy classification on its stored profile.
                 Fixed evidence + majority voting = stable, repeatable categories.
  --apollo       Spend 1 Apollo credit for its moat fields: exact headcount,
                 revenue, headcount growth, logo, socials (requires APOLLO_API_KEY;
                 off by default — web research covers the profile basics)
  --json         Output the full result as JSON
  --md           Output the markdown brief (default)
  --pretty       Pretty-print JSON (with --json)
  --help, -h     Show this help

Sources: Wikidata/Wikipedia (keyless), web research (ANTHROPIC_API_KEY, primary),
Apollo.io (opt-in --apollo), OpenCorporates (OPENCORPORATES_API_TOKEN).
Missing keys are skipped, not fatal.

Examples:
  enrich "Stripe"
  enrich "Notion" --domain notion.so --json --pretty
`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      domain: { type: "string", short: "d" },
      taxonomy: { type: "string", short: "t" },
      apollo: { type: "boolean", default: false },
      reclassify: { type: "string" },
      json: { type: "boolean", default: false },
      md: { type: "boolean", default: false },
      pretty: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help || (positionals.length === 0 && !values.reclassify)) {
    process.stdout.write(HELP);
    process.exit(values.help ? 0 : 1);
  }

  let taxonomy: TaxonomyNode[] | undefined;
  if (values.taxonomy) {
    const parsed = JSON.parse(readFileSync(values.taxonomy, "utf8"));
    if (!Array.isArray(parsed)) throw new Error("taxonomy file must be a JSON array of nodes");
    taxonomy = parsed as TaxonomyNode[];
  }

  if (values.reclassify) {
    if (!taxonomy) throw new Error("--reclassify requires --taxonomy");
    const prev = JSON.parse(readFileSync(values.reclassify, "utf8")) as EnrichmentResult;
    if (!prev?.company) throw new Error("--reclassify file is not a saved enrichment result");
    const classification = await categorize(prev.company, taxonomy);
    const { markdown: _md, ...rest } = { ...prev, ...(classification ? { classification } : {}) };
    process.stdout.write(JSON.stringify(rest, null, values.pretty ? 2 : 0) + "\n");
    return;
  }

  const name = positionals.join(" ").trim();
  const result = await enrich({ name, domain: values.domain, taxonomy, apollo: values.apollo });

  if (values.json) {
    const { markdown, ...rest } = result; // omit markdown from JSON payload
    process.stdout.write(JSON.stringify(rest, null, values.pretty ? 2 : 0) + "\n");
  } else {
    process.stdout.write(result.markdown + "\n");
  }
}

main().catch((err) => {
  process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
