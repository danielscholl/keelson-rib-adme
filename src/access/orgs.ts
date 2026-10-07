// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { Identity } from "./model.ts";

export interface Org {
  // The registrable domain, the filter key.
  domain: string;
  name: string;
}

// The People filter for one organization: "org:<domain>".
export const ORG_FILTER = "org:";

export const NO_ORG: Org = { domain: "", name: "No email" };

// "alumni.northwind.ac.uk" is northwind.ac.uk: a two-letter country code under a
// short second level (ac, co, com) takes one more label.
export function registrableDomain(host: string): string {
  const labels = host.toLowerCase().split(".").filter(Boolean);
  const n = labels.length;
  const last = labels[n - 1] ?? "";
  const second = labels[n - 2] ?? "";
  const take = n >= 3 && last.length === 2 && second.length <= 3 ? 3 : 2;
  return labels.slice(-take).join(".");
}

// The label before the suffix, each word capitalized; a short lone label or a
// word with a digit reads as an acronym (xyz, k2).
function orgName(domain: string): string {
  const words = (domain.split(".")[0] ?? domain).split(/[-_]/).filter(Boolean);
  const acronym = (w: string) => (words.length === 1 && w.length <= 3) || /\d/.test(w);
  return words
    .map((w) => (acronym(w) ? w.toUpperCase() : w[0]?.toUpperCase() + w.slice(1)))
    .join(" ");
}

export function orgOf(p: Pick<Identity, "email">): Org {
  const host = p.email?.split("@")[1];
  if (!host) return NO_ORG;
  const domain = registrableDomain(host);
  return { domain, name: orgName(domain) || domain };
}

export interface OrgGroup {
  org: Org;
  people: Identity[];
}

export function groupByOrg(people: readonly Identity[]): OrgGroup[] {
  const groups = new Map<string, OrgGroup>();
  for (const p of people) {
    const org = orgOf(p);
    const g = groups.get(org.domain) ?? { org, people: [] };
    g.people.push(p);
    groups.set(org.domain, g);
  }
  return [...groups.values()].sort(
    (a, b) => b.people.length - a.people.length || a.org.name.localeCompare(b.org.name),
  );
}
