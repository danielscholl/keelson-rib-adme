// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { KIND_BUCKET_LIMIT } from "../data/areas.ts";
import { groupKinds, kindParts } from "../data/inventory.ts";
import { type BriefInputs, type Item, tagsNeedingCare } from "./index.ts";
import { fmt, listOf, plural } from "./words.ts";

export const NAMED_FAMILIES = 6;

export interface DataFact {
  label: string;
  value: string | null;
  sub: string;
  tone: "warn" | "neutral";
}

export interface FamilyKind {
  kind: string;
  count: number;
}

export interface Family {
  id: string;
  key: string;
  label: string;
  count: number;
  pattern: string;
  kinds: FamilyKind[];
  versions: number;
  authorities: string[];
}

export interface DataBrief {
  headline: string;
  facts: DataFact[];
  families: Family[];
  // The kinds past the named families, summed.
  rest?: { kinds: number; count: number };
  queue: Item[];
  lower: string[];
  scopes: [string, string][];
}

export function familyId(key: string): string {
  return `fam:${key}`;
}

const SCOPES: [string, string][] = [
  [
    "Records, families, kinds",
    "Indexed records visible to this sign-in. Unindexed records and records outside its ACL groups are not counted.",
  ],
  [
    "Records per tag or group",
    "Search aggregates. One record can carry several tags or groups, so these counts overlap and are never summed.",
  ],
  [
    "Grants, people with grants",
    "Explicit grants in the seismic groups read. At least, when a group was not read.",
  ],
  ["Active, idle, no call yet", "Calls in the audit log. Not measured without a workspace."],
];

export function familiesOf(i: BriefInputs): Family[] {
  const kinds = i.kinds?.kinds ?? [];
  return groupKinds(kinds, "family").map((g) => {
    const members = kinds.filter((k) => kindParts(k.kind)?.[2] === g.key);
    const authorities = [...new Set(members.map((k) => kindParts(k.kind)?.[0] ?? ""))].filter(
      Boolean,
    );
    return {
      id: familyId(g.key),
      key: g.key,
      label: g.label,
      count: g.count,
      pattern: g.pattern,
      kinds: members.map((k) => ({ kind: k.kind, count: k.count })),
      versions: g.versions,
      authorities,
    };
  });
}

export function dataBrief(i: BriefInputs, items: readonly Item[]): DataBrief | undefined {
  const k = i.kinds;
  const { care, unused } = tagsNeedingCare(i);
  const queue = items.filter((x) => x.cls === "LEGAL");
  const lower = unused.map((u) =>
    u.empty.length > 0
      ? `${u.name} is invalid. No indexed record carries it; ${listOf(u.empty)} ${u.empty.length === 1 ? "names it and has" : "name it and have"} no members.`
      : `${u.name} is invalid. No indexed record or subproject uses it.`,
  );
  if (!k && !i.legal) return undefined;
  const all = familiesOf(i);
  const named = all.slice(0, NAMED_FAMILIES);
  const rest = all.slice(NAMED_FAMILIES);
  const facts: DataFact[] = [];
  if (k) {
    const visible = k.visible ?? null;
    facts.push(
      visible === null
        ? {
            label: "Indexed records",
            value: fmt(k.total),
            sub: "summed over kinds, may be incomplete",
            tone: "neutral",
          }
        : {
            label: "Indexed records",
            value: fmt(visible),
            sub: "visible to this sign-in",
            tone: "neutral",
          },
    );
    const truncated = k.kinds.length >= KIND_BUCKET_LIMIT;
    facts.push({
      label: "Kinds",
      value: fmt(k.kinds.length),
      sub: truncated
        ? `search's ${fmt(KIND_BUCKET_LIMIT)} limit, may be more`
        : `${plural(named.length, "named family", "named families")}, ${fmt(Math.max(0, k.kinds.length - named.reduce((n, f) => n + f.kinds.length, 0)))} more kinds`,
      tone: "neutral",
    });
  } else {
    facts.push(
      { label: "Indexed records", value: null, sub: "not measured", tone: "neutral" },
      { label: "Kinds", value: null, sub: "not measured", tone: "neutral" },
    );
  }
  if (i.legal) {
    facts.push({
      label: "Tags needing care",
      value: fmt(care.length),
      sub:
        unused.length > 0
          ? `in use; ${plural(unused.length, "invalid tag", "invalid tags")} unused`
          : i.tagCounts === null
            ? "records per tag not counted"
            : "in use",
      tone: care.length > 0 ? "warn" : "neutral",
    });
  } else {
    facts.push({
      label: "Tags needing care",
      value: null,
      sub: "legal tags not read",
      tone: "neutral",
    });
  }
  const records = k ? (k.visible ?? k.total) : undefined;
  const headline = !k
    ? "Record counts are not read yet."
    : `${fmt(records ?? 0)} indexed records in ${plural(all.length, "family", "families")}${care.length > 0 ? `; ${plural(care.length, "legal tag needs", "legal tags need")} care` : ""}.`;
  return {
    headline,
    facts,
    families: named,
    ...(rest.length > 0
      ? {
          rest: {
            kinds: rest.reduce((n, f) => n + f.kinds.length, 0),
            count: rest.reduce((n, f) => n + f.count, 0),
          },
        }
      : {}),
    queue,
    lower,
    scopes: SCOPES,
  };
}
