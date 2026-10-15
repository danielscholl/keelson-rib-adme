// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { Batch, CallFailure, CallResult } from "../client.ts";
import { ALL_KINDS } from "./records.ts";

export const FACETS_AREA = "facets";

// The search fields a record is counted by, besides kind.
export const FACETS = ["tags", "viewers", "owners"] as const;
export type Facet = (typeof FACETS)[number];

export const FACET_FIELDS: Record<Facet, string> = {
  tags: "legal.legaltags",
  viewers: "acl.viewers",
  owners: "acl.owners",
};

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
