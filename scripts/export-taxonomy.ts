/**
 * Export the Jarvis DB canonical taxonomy to the flat TaxonomyNode[] JSON the
 * enrich CLI consumes (--taxonomy <path>).
 *
 * Usage:
 *   npx tsx scripts/export-taxonomy.ts <path-to-jarvis-repo> [out.json]
 *
 * Reads <repo>/taxonomy/index.ts (the canonicalTaxonomy export), flattens all
 * dimensions, drops deprecated terms, and folds excludes/synonyms/examples into
 * each node's description so the classifier can use them for disambiguation.
 * IDs are the Jarvis stable slugs — echoed back in classification results so
 * they join directly to the DB.
 *
 * NOTE: the output contains the full proprietary ontology — it is gitignored;
 * do not commit it to a public repo.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repo = process.argv[2];
const out = process.argv[3] ?? "jarvis-taxonomy.json";
if (!repo) {
  console.error("usage: npx tsx scripts/export-taxonomy.ts <path-to-jarvis-repo> [out.json]");
  process.exit(1);
}

const indexPath = resolve(repo, "taxonomy/index.ts");
const mod = await import(pathToFileURL(indexPath).href);
const taxonomy = mod.canonicalTaxonomy;
if (!taxonomy?.dimensions) {
  console.error(`no canonicalTaxonomy export found at ${indexPath}`);
  process.exit(1);
}

interface ExportedNode {
  id: string;
  name: string;
  dimension: string;
  parentId?: string;
  description: string;
}

const nodes: ExportedNode[] = [];
for (const dim of Object.values(taxonomy.dimensions) as any[]) {
  for (const t of dim.terms) {
    if (t.deprecated) continue;
    let description: string = t.description ?? "";
    if (t.excludes) description += ` EXCLUDES: ${t.excludes}`;
    if (t.synonyms?.length) description += ` Synonyms: ${t.synonyms.join(", ")}.`;
    if (t.examples?.length) description += ` Examples: ${t.examples.slice(0, 4).join(", ")}.`;
    nodes.push({
      id: t.id,
      name: t.name,
      dimension: t.dimension,
      ...(t.parent_id ? { parentId: t.parent_id } : {}),
      description: description.trim(),
    });
  }
}

writeFileSync(out, JSON.stringify(nodes, null, 2));
const byDim = new Map<string, number>();
for (const n of nodes) byDim.set(n.dimension, (byDim.get(n.dimension) ?? 0) + 1);
console.log(
  `${nodes.length} terms → ${out} (` +
    [...byDim].map(([d, c]) => `${d}: ${c}`).join(", ") +
    `) — taxonomy v${taxonomy.version}`,
);
