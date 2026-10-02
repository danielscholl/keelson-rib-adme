// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { Batch, CallResult } from "../client.ts";
import type { Profile } from "../profile.ts";
import type { Runtime } from "../runtime.ts";

export const PAGE_SIZE = 25;
export const SEARCH_WINDOW = 10_000;
export const ALL_KINDS = "*:*:*:*";

export const FIND_MODES = ["kind", "id", "lucene", "acl", "legal"] as const;
export type FindMode = (typeof FIND_MODES)[number];

// FacilityName names wells and wellbores; Name names most other kinds.
export const RETURNED_FIELDS = [
  "id",
  "kind",
  "version",
  "createTime",
  "modifyTime",
  "legal",
  "acl",
  "data.FacilityName",
  "data.Name",
] as const;

export interface RecordQuery {
  mode: FindMode;
  kind: string;
  query?: string;
  // What the operator typed, drawn after the mode word in the chip and title.
  subject: string;
}

export const MODE_WORDS: Record<FindMode, string> = {
  kind: "kind",
  id: "id",
  lucene: "lucene",
  acl: "acl",
  legal: "legal tag",
};

export function queryLabel(q: RecordQuery): string {
  return `${MODE_WORDS[q.mode]} ${q.subject}`;
}

export type Built = { ok: true; query: RecordQuery } | { ok: false; error: string };

const KIND = /^[^:\s]+:[^:\s]+:[^:\s]+:[^:\s]+$/;

function text(input: Record<string, unknown>, name: string): string {
  const v = input[name];
  return typeof v === "string" ? v.trim() : "";
}

function quoted(value: string): string {
  return `"${value.replace(/[\\"]/g, "\\$&")}"`;
}

export function buildQuery(mode: FindMode, input: Record<string, unknown>): Built {
  switch (mode) {
    case "kind": {
      const kind = text(input, "kind");
      if (!KIND.test(kind)) {
        return { ok: false, error: "kind is authority:source:type:version, * allowed in any part" };
      }
      const query = text(input, "query");
      return {
        ok: true,
        query: {
          mode,
          kind,
          ...(query ? { query } : {}),
          subject: query ? `${kind} · ${query}` : kind,
        },
      };
    }
    case "id": {
      const id = text(input, "id");
      if (!id) return { ok: false, error: "enter a record id" };
      return { ok: true, query: { mode, kind: ALL_KINDS, query: `id:${quoted(id)}`, subject: id } };
    }
    case "lucene": {
      const query = text(input, "query");
      if (!query) return { ok: false, error: "enter a Lucene query" };
      return { ok: true, query: { mode, kind: ALL_KINDS, query, subject: query } };
    }
    case "acl": {
      const group = text(input, "group");
      if (!group) return { ok: false, error: "enter a group email" };
      return {
        ok: true,
        query: {
          mode,
          kind: ALL_KINDS,
          query: `acl.viewers:${quoted(group)} OR acl.owners:${quoted(group)}`,
          subject: group,
        },
      };
    }
    case "legal": {
      const tag = text(input, "tag");
      if (!tag) return { ok: false, error: "enter a legal tag name" };
      return {
        ok: true,
        query: {
          mode,
          kind: ALL_KINDS,
          query: `legal.legaltags:${quoted(tag)}`,
          subject: tag,
        },
      };
    }
  }
}

export function searchBody(q: RecordQuery, page: number): Record<string, unknown> {
  return {
    kind: q.kind,
    ...(q.query ? { query: q.query } : {}),
    offset: page * PAGE_SIZE,
    limit: PAGE_SIZE,
    trackTotalCount: true,
    returnedFields: [...RETURNED_FIELDS],
  };
}

export interface PageInfo {
  page: number;
  // null when search did not say how many records match.
  pages: number | null;
  prev: { ok: true } | { ok: false; reason: string };
  next: { ok: true } | { ok: false; reason: string };
}

export const FIRST_PAGE_REASON = "first page";
export const LAST_PAGE_REASON = "last page";
export const WINDOW_REASON = "search pages stop at 10,000 records: narrow the query to see more";

export function pageInfo(total: number | null, page: number): PageInfo {
  const nextOffset = (page + 1) * PAGE_SIZE;
  let next: PageInfo["next"] = { ok: true };
  if (total !== null && nextOffset >= total) next = { ok: false, reason: LAST_PAGE_REASON };
  else if (nextOffset + PAGE_SIZE > SEARCH_WINDOW) next = { ok: false, reason: WINDOW_REASON };
  return {
    page,
    pages: total === null ? null : Math.max(1, Math.ceil(total / PAGE_SIZE)),
    prev: page > 0 ? { ok: true } : { ok: false, reason: FIRST_PAGE_REASON },
    next,
  };
}

export interface FoundRecord {
  id: string;
  kind: string;
  // Microseconds since the epoch, not a revision counter.
  version?: number;
  createTime?: string;
  modifyTime?: string;
  name?: string;
  legalStatus?: string;
  legaltags: string[];
  countries: string[];
  viewers: string[];
  owners: string[];
}

export interface RecordPage {
  total: number | null;
  records: FoundRecord[];
}

interface RawHit {
  id?: unknown;
  kind?: unknown;
  version?: unknown;
  createTime?: unknown;
  modifyTime?: unknown;
  legal?: { legaltags?: unknown; otherRelevantDataCountries?: unknown; status?: unknown };
  acl?: { viewers?: unknown; owners?: unknown };
  data?: { FacilityName?: unknown; Name?: unknown };
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);
const strs = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

export function parseHit(raw: RawHit): FoundRecord | undefined {
  const id = str(raw.id);
  if (!id) return undefined;
  const name = str(raw.data?.FacilityName) ?? str(raw.data?.Name);
  const createTime = str(raw.createTime);
  const modifyTime = str(raw.modifyTime);
  const legalStatus = str(raw.legal?.status);
  return {
    id,
    kind: str(raw.kind) ?? "?",
    ...(typeof raw.version === "number" ? { version: raw.version } : {}),
    ...(createTime ? { createTime } : {}),
    ...(modifyTime ? { modifyTime } : {}),
    ...(name ? { name } : {}),
    ...(legalStatus ? { legalStatus } : {}),
    legaltags: strs(raw.legal?.legaltags),
    countries: strs(raw.legal?.otherRelevantDataCountries),
    viewers: strs(raw.acl?.viewers),
    owners: strs(raw.acl?.owners),
  };
}

export function parsePage(body: unknown): RecordPage {
  const b = (body ?? {}) as { results?: unknown; totalCount?: unknown };
  const results = Array.isArray(b.results) ? (b.results as RawHit[]) : [];
  return {
    total: typeof b.totalCount === "number" ? b.totalCount : null,
    records: results.map(parseHit).filter((r): r is FoundRecord => r !== undefined),
  };
}

export async function searchRecords(
  batch: Batch,
  q: RecordQuery,
  page: number,
): Promise<CallResult<RecordPage>> {
  const res = await batch.adme("search", "/query", { method: "POST", body: searchBody(q, page) });
  if (!res.ok) return res;
  return { ok: true, status: res.status, data: parsePage(res.data) };
}

// ---- Module-held search state, one per runtime ----

export interface RecordsState {
  instance: string;
  query: RecordQuery;
  page: number;
  result: RecordPage;
  at: string;
}

const states = new WeakMap<Runtime, RecordsState>();

export function instanceOf(profile: Profile | undefined): string {
  return profile ? `${profile.host}/${profile.partition}` : "";
}

// A search made against another instance is never drawn or paged.
export function activeSearch(rt: Runtime): RecordsState | undefined {
  const s = states.get(rt);
  return s && s.instance === instanceOf(rt.profile) ? s : undefined;
}

export function setSearch(rt: Runtime, state: RecordsState): void {
  states.set(rt, state);
}

export function clearSearch(rt: Runtime): void {
  states.delete(rt);
}
