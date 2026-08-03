#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { enrich } from "./index.js";
import type { TaxonomyNode } from "./types.js";

const HELP = `startup-enrich — assemble startup info from free-tier sources

Usage:
  enrich "<startup name>" [--domain <domain>] [--json | --md] [--pretty]

Options:
  --domain, -d   Optional domain/URL to disambiguate (e.g. stripe.com)
  --taxonomy, -t Path to a taxonomy JSON file ([{id,name,description?,parentId?,dimension?}])
                 to classify the company against (needs ANTHROPIC_API_KEY)
  --json         Output the full result as JSON
  --md           Output the markdown brief (default)
  --pretty       Pretty-print JSON (with --json)
  --help, -h     Show this help

Sources: Wikidata/Wikipedia (keyless), Apollo.io (APOLLO_API_KEY),
OpenCorporates (OPENCORPORATES_API_TOKEN). Missing keys are skipped, not fatal.

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
      json: { type: "boolean", default: false },
      md: { type: "boolean", default: false },
      pretty: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help || positionals.length === 0) {
    process.stdout.write(HELP);
    process.exit(values.help ? 0 : 1);
  }

  const name = positionals.join(" ").trim();
  let taxonomy: TaxonomyNode[] | undefined;
  if (values.taxonomy) {
    const parsed = JSON.parse(readFileSync(values.taxonomy, "utf8"));
    if (!Array.isArray(parsed)) throw new Error("taxonomy file must be a JSON array of nodes");
    taxonomy = parsed as TaxonomyNode[];
  }
  const result = await enrich({ name, domain: values.domain, taxonomy });

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
