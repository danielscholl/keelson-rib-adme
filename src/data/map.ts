// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { Batch, CallFailure, CallResult } from "../client.ts";
import type { Runtime } from "../runtime.ts";
import { ALL_KINDS, instanceOf } from "./records.ts";

export const FACETS_AREA = "facets";

// The search fields a record is counted by, besides kind.
export const FACETS = ["tags", "viewers", "owners"] as const;
export type Facet = (typeof FACETS)[number];

export const FACET_FIELDS: Record<Facet, string> = {
  tags: "legal.legaltags",
  viewers: "acl.viewers",
  owners: "acl.owners",
};

export const LENSES = ["tags", "viewers", "owners", "kinds"] as const;
export type Lens = (typeof LENSES)[number];

export interface Bucket {
  key: string;
  count: number;
}

// One aggregate per facet; a facet search refused is null with its reason, never empty.
export interface Facets {
  tags: Bucket[] | null;
  viewers: Bucket[] | null;
  owners: Bucket[] | null;
  errors: Partial<Record<Facet, string>>;
}

const NO_AGGREGATION = "search returned no aggregation";

function why(f: CallFailure): string {
  return f.kind === "forbidden" ? `search refused this sign-in (403)` : f.message;
}

async function aggregate(
  batch: Batch,
  field: string,
  kind: string,
  query: string,
): Promise<CallResult<Bucket[]>> {
  const res = await batch.adme<{ aggregations?: { key: string; count: number }[] }>(
    "search",
    "/query",
    {
      method: "POST",
      body: { kind, query, limit: 1, aggregateBy: field, returnedFields: ["id"] },
    },
  );
  if (!res.ok) return res;
  if (!Array.isArray(res.data?.aggregations)) {
    return { ok: false, failure: { kind: "server", status: res.status, message: NO_AGGREGATION } };
  }
  return {
    ok: true,
    status: res.status,
    data: res.data.aggregations
      .map((a) => ({ key: a.key, count: a.count }))
      .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key)),
  };
}

export async function readFacets(batch: Batch): Promise<CallResult<Facets>> {
  const results = await Promise.all(
    FACETS.map((f) => aggregate(batch, FACET_FIELDS[f], ALL_KINDS, "*")),
  );
  const facets: Facets = { tags: null, viewers: null, owners: null, errors: {} };
  for (const [i, res] of results.entries()) {
    const f = FACETS[i] as Facet;
    if (res.ok) facets[f] = res.data;
    else facets.errors[f] = why(res.failure);
  }
  const first = results.find((r) => !r.ok);
  if (first && !first.ok && results.every((r) => !r.ok)) return first;
  return { ok: true, status: 200, data: facets };
}

// ---- One selected row: the other dimensions for that slice ----

export interface Selection {
  lens: Lens;
  // A tag name, a group email, or a kind pattern.
  key: string;
  label: string;
}

export interface Members {
  // Nested groups by email; people and applications are object ids and only counted.
  groups: string[];
  others: number;
}

export interface Slice {
  kinds?: Bucket[] | null;
  tags?: Bucket[] | null;
  viewers?: Bucket[] | null;
  owners?: Bucket[] | null;
  errors: Partial<Record<"kinds" | Facet | "members", string>>;
  // Groups only: undefined before the read, null when entitlements has no such group.
  members?: Members | null;
}

function quoted(value: string): string {
  return `"${value.replace(/[\\"]/g, "\\$&")}"`;
}

// The kind pattern and query that select a slice in search.
export function sliceScope(sel: Selection): { kind: string; query: string } {
  if (sel.lens === "kinds") return { kind: sel.key, query: "*" };
  return { kind: ALL_KINDS, query: `${FACET_FIELDS[sel.lens]}:${quoted(sel.key)}` };
}

const SLICE_FIELDS: Record<Lens, ("kinds" | Facet)[]> = {
  tags: ["kinds", "viewers", "owners"],
  viewers: ["kinds", "tags"],
  owners: ["kinds", "tags"],
  kinds: ["tags", "viewers"],
};

interface MemberList {
  members?: { email?: string }[];
}

async function readMembers(batch: Batch, group: string): Promise<CallResult<Members | null>> {
  const res = await batch.adme<MemberList>(
    "entitlements",
    `/groups/${encodeURIComponent(group)}/members`,
  );
  if (!res.ok) {
    return res.failure.kind === "not-found" ? { ok: true, status: 404, data: null } : res;
  }
  const emails = (res.data.members ?? []).map((m) => m.email ?? "").filter(Boolean);
  const groups = emails.filter((e) => e.includes("@")).sort();
  return { ok: true, status: res.status, data: { groups, others: emails.length - groups.length } };
}

export async function readSlice(batch: Batch, sel: Selection): Promise<CallResult<Slice>> {
  const scope = sliceScope(sel);
  const fields = SLICE_FIELDS[sel.lens];
  const group = sel.lens === "viewers" || sel.lens === "owners";
  const [aggs, members] = await Promise.all([
    Promise.all(
      fields.map((f) =>
        aggregate(batch, f === "kinds" ? "kind" : FACET_FIELDS[f], scope.kind, scope.query),
      ),
    ),
    group ? readMembers(batch, sel.key) : Promise.resolve(undefined),
  ]);
  const slice: Slice = { errors: {} };
  for (const [i, res] of aggs.entries()) {
    const f = fields[i] as "kinds" | Facet;
    if (res.ok) slice[f] = res.data;
    else {
      slice[f] = null;
      slice.errors[f] = why(res.failure);
    }
  }
  if (members) {
    if (members.ok) slice.members = members.data;
    else slice.errors.members = why(members.failure);
  }
  const failed = aggs.find((r) => !r.ok);
  if (failed && !failed.ok && aggs.every((r) => !r.ok)) return failed;
  return { ok: true, status: 200, data: slice };
}

// ---- Module state, one per runtime, dropped when the instance changes ----

export interface MapState {
  instance: string;
  lens: Lens;
  selection?: Selection;
  slice?: { at: string; data: Slice } | { at: string; error: string };
}

const states = new WeakMap<Runtime, MapState>();

export function mapState(rt: Runtime): MapState {
  const s = states.get(rt);
  if (s && s.instance === instanceOf(rt.profile)) return s;
  const fresh: MapState = { instance: instanceOf(rt.profile), lens: "tags" };
  states.set(rt, fresh);
  return fresh;
}

export function isLens(value: unknown): value is Lens {
  return typeof value === "string" && (LENSES as readonly string[]).includes(value);
}
