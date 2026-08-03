import type {
  Classification,
  CompanyData,
  EnrichInput,
  Provenance,
  SourceStatus,
} from "./types.js";

/** Render a human-readable markdown brief from merged enrichment data. */
export function renderMarkdown(
  input: EnrichInput,
  company: CompanyData,
  provenance: Provenance,
  sources: SourceStatus[],
  classification?: Classification,
): string {
  const c = company;
  const lines: string[] = [];
  const title = c.name ?? input.name;
  lines.push(`# ${title}`);
  if (c.description) lines.push("", c.description);

  // Taxonomy classification (against the caller's own ontology).
  if (classification) {
    const fmt = (a: { name: string; confidence?: string }) =>
      `${a.name}${a.confidence ? ` (${a.confidence})` : ""}`;
    if (classification.primary) {
      let line = `**Category:** ${fmt(classification.primary)}`;
      if (classification.secondary?.length) {
        line += ` · also: ${classification.secondary.map(fmt).join(", ")}`;
      }
      lines.push("", line);
      if (classification.primary.rationale) lines.push(`*${classification.primary.rationale}*`);
    } else if (classification.needsReview) {
      lines.push("", "**Category:** ⚠️ needs review — no taxonomy match");
    }
  }

  // Key facts table.
  const facts: [string, string | undefined][] = [
    ["Website", c.website ?? (c.domain ? `https://${c.domain}` : undefined)],
    ["Domain", c.domain],
    ["Founded", c.foundedDate ?? (c.foundedYear ? String(c.foundedYear) : undefined)],
    ["Founders", c.founders?.map((f) => f.name).join(", ")],
    ["CEO", c.ceo],
    ["Headquarters", formatHq(c)],
    ["Industry", c.industry],
    ["Categories", c.categories?.slice(0, 8).join(", ")],
    ["Products", c.products?.slice(0, 8).join(", ")],
    ["Product stage", c.productStage],
    ["TRL", c.trl?.level !== undefined ? `${c.trl.level}/9${c.trl.confidence ? ` (${c.trl.confidence} confidence)` : ""}` : undefined],
    ["Accelerators", c.accelerators?.join(", ")],
    ["Corporate engagement", c.corporatePartners?.map((p) => (p.relationship ? `${p.name} (${p.relationship})` : p.name)).join(", ")],
    ["Parent company", c.parentCompany],
    ["Employees", formatEmployees(c)],
    ["Headcount growth (1y)", c.headcountGrowthYoY !== undefined ? formatPct(c.headcountGrowthYoY) : undefined],
    ["Revenue (est.)", c.revenue !== undefined ? formatMoney(c.revenue) : undefined],
    ["Stock", c.stockSymbol ? `${c.stockSymbol}${c.stockExchange ? ` (${c.stockExchange.toUpperCase()})` : ""}` : undefined],
    ["Total funding", c.fundingTotal !== undefined ? formatMoney(c.fundingTotal) : undefined],
    ["Valuation", c.valuation !== undefined ? formatMoney(c.valuation) : undefined],
    ["Latest stage", c.latestFundingStage],
    ["Growth stage", c.growthStage],
    ["Last funding", c.lastFundingDate],
    ["Investors", c.investors?.slice(0, 8).join(", ")],
    ["Patents", c.patents?.count !== undefined ? c.patents.count.toLocaleString("en-US") : undefined],
  ];
  const rows = facts.filter(([, v]) => v);
  if (rows.length) {
    lines.push("", "| Field | Value |", "| --- | --- |");
    for (const [k, v] of rows) lines.push(`| ${k} | ${escapePipes(v!)} |`);
  }

  // Links.
  const links: string[] = [];
  const s = c.socialLinks ?? {};
  if (s.linkedin) links.push(`[LinkedIn](${s.linkedin})`);
  if (s.twitter) links.push(`[X/Twitter](${s.twitter})`);
  if (s.facebook) links.push(`[Facebook](${s.facebook})`);
  if (s.github) links.push(`[GitHub](${s.github})`);
  if (s.crunchbase) links.push(`[Crunchbase](${s.crunchbase})`);
  if (c.dealroomUrl) links.push(`[Dealroom](${c.dealroomUrl})`);
  if (c.wikipediaUrl) links.push(`[Wikipedia](${c.wikipediaUrl})`);
  if (c.wikidataId) links.push(`[Wikidata](https://www.wikidata.org/wiki/${c.wikidataId})`);
  if (links.length) lines.push("", "**Links:** " + links.join(" · "));

  // Patents / IP.
  const patents = c.patents;
  if (
    patents &&
    (patents.count || patents.recent?.length || patents.notable?.length || patents.summary)
  ) {
    lines.push("", "## Patents & IP");
    if (patents.summary) lines.push(patents.summary);
    const vintage =
      patents.earliestPriorityYear !== undefined
        ? `${patents.earliestPriorityYear}${patents.estimatedCoreExpiryYear ? ` → ~${patents.estimatedCoreExpiryYear} core expiry` : ""}`
        : undefined;
    const legal =
      patents.grantedCount !== undefined || patents.pendingCount !== undefined
        ? `${patents.grantedCount ?? 0} granted / ${patents.pendingCount ?? 0} pending`
        : undefined;
    const ipRows: [string, string | undefined][] = [
      ["Publications", patents.count !== undefined ? patents.count.toLocaleString("en-US") : undefined],
      ["Families", patents.familyCount !== undefined ? String(patents.familyCount) : undefined],
      ["Legal status", legal],
      ["Vintage", vintage],
      ["Status", patents.status],
      ["Jurisdictions", patents.jurisdictions?.join(", ")],
      ["CPC", patents.cpc?.map((c) => `${c.code}${c.count ? ` ×${c.count}` : ""} (${c.label ?? "—"})`).join("; ")],
      ["Areas", patents.areas?.slice(0, 8).join(", ")],
      ["Assignee", patents.assignee],
    ];
    const filtered = ipRows.filter(([, v]) => v);
    if (filtered.length) {
      lines.push("", "| Field | Value |", "| --- | --- |");
      for (const [k, v] of filtered) lines.push(`| ${k} | ${escapePipes(v!)} |`);
    }
    if (patents.recent?.length) {
      lines.push("", "Most recent grants:");
      for (const p of patents.recent.slice(0, 5)) {
        const label = p.title ?? p.id;
        const link = p.url ? `[${label}](${p.url})` : label;
        lines.push(`- ${link}${p.date ? ` — ${p.date}` : ""}`);
      }
    }
    if (patents.notable?.length) {
      lines.push("", "Notable filings:");
      for (const t of patents.notable.slice(0, 5)) lines.push(`- ${t}`);
    }
  }

  // Patent verification links (always available).
  const ps = c.patentSearch;
  if (ps) {
    if (!patents) lines.push("", "## Patents & IP");
    lines.push("", "**Verify:** " + ps.company.map((l) => `[${l.label}](${l.url})`).join(" · "));
    if (ps.byInventor?.length) {
      lines.push("", "By inventor:");
      for (const inv of ps.byInventor) {
        lines.push(`- ${inv.name}: ` + inv.links.map((l) => `[${l.label}](${l.url})`).join(" · "));
      }
    }
  }

  // Legal entity.
  const le = c.legalEntity;
  if (le && Object.keys(le).length) {
    lines.push("", "## Legal entity");
    const leRows: [string, string | undefined][] = [
      ["Legal name", c.legalName],
      ["Company number", le.companyNumber],
      ["Jurisdiction", le.jurisdiction],
      ["Incorporated", le.incorporationDate],
      ["Type", le.type],
      ["Status", le.status],
    ];
    const filtered = leRows.filter(([, v]) => v);
    if (filtered.length) {
      lines.push("| Field | Value |", "| --- | --- |");
      for (const [k, v] of filtered) lines.push(`| ${k} | ${escapePipes(v!)} |`);
    }
    if (le.officers?.length) {
      lines.push(
        "",
        "**Officers:** " +
          le.officers
            .slice(0, 10)
            .map((o) => (o.role ? `${o.name} (${o.role})` : o.name))
            .join(", "),
      );
    }
    if (le.openCorporatesUrl) lines.push("", `[View on OpenCorporates](${le.openCorporatesUrl})`);
  }

  // Provenance + source status footer.
  lines.push("", "## Sources");
  for (const src of sources) {
    const icon = statusIcon(src.status);
    let line = `- ${icon} **${src.source}** — ${src.status}`;
    if (src.detail) line += ` (${src.detail})`;
    lines.push(line);
    if (src.candidates?.length) {
      for (const cand of src.candidates.slice(0, 5)) {
        const bits = [cand.domain, cand.jurisdiction, cand.identifier, cand.hint].filter(Boolean);
        lines.push(`  - candidate: ${cand.name}${bits.length ? ` — ${bits.join(", ")}` : ""}`);
      }
    }
  }

  const provEntries = Object.entries(provenance);
  if (provEntries.length) {
    lines.push("", "<details><summary>Field provenance</summary>", "");
    for (const [field, srcs] of provEntries) {
      lines.push(`- \`${field}\`: ${(srcs ?? []).join(", ")}`);
    }
    lines.push("", "</details>");
  }

  return lines.join("\n");
}

function formatHq(c: CompanyData): string | undefined {
  const h = c.headquarters;
  if (!h) return undefined;
  return [h.city, h.region, h.country].filter(Boolean).join(", ") || undefined;
}

function formatEmployees(c: CompanyData): string | undefined {
  if (c.employeeCount !== undefined) return c.employeeCount.toLocaleString("en-US");
  return c.employeeRange;
}

function formatPct(fraction: number): string {
  const pct = fraction * 100;
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(pct >= 10 || pct <= -10 ? 0 : 1)}%`;
}

function formatMoney(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n}`;
}

function escapePipes(v: string): string {
  return v.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function statusIcon(status: SourceStatus["status"]): string {
  switch (status) {
    case "ok":
      return "✅";
    case "no_match":
      return "➖";
    case "skipped":
      return "⏭️";
    case "error":
      return "⚠️";
  }
}
