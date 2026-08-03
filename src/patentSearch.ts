import type { Person, PatentSearchLinks } from "./types.js";

/**
 * Build deterministic patent-database search links for a company and its
 * founders. No API calls — pure URL construction, so these are available on
 * every run (even keyless) and let a human verify web-derived patent claims in
 * one click.
 *
 *   Google Patents: ?assignee= / ?inventor=
 *   Espacenet:      advanced query  pa="…" (applicant) / in="…" (inventor)
 */
function googlePatents(param: "assignee" | "inventor", value: string): string {
  return `https://patents.google.com/?${param}=${encodeURIComponent(value)}`;
}

function espacenet(field: "pa" | "in", value: string): string {
  const q = `${field}="${value}"`;
  return `https://worldwide.espacenet.com/patent/search?q=${encodeURIComponent(q)}`;
}

export function buildPatentSearch(name: string, founders?: Person[]): PatentSearchLinks {
  const company = [
    { label: "Google Patents (assignee)", url: googlePatents("assignee", name) },
    { label: "Espacenet (applicant)", url: espacenet("pa", name) },
  ];

  const byInventor = (founders ?? [])
    .map((f) => f.name)
    .filter((n): n is string => !!n)
    .map((inventor) => ({
      name: inventor,
      links: [
        { label: "Google Patents", url: googlePatents("inventor", inventor) },
        { label: "Espacenet", url: espacenet("in", inventor) },
      ],
    }));

  return { company, ...(byInventor.length ? { byInventor } : {}) };
}
