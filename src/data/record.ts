// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { Batch, CallResult } from "../client.ts";
import type { Runtime } from "../runtime.ts";
import { instanceOf } from "./records.ts";

// The fields the drawer draws. The record body itself is never kept.
export interface RecordDetail {
  id: string;
  kind: string;
  version?: number;
  name?: string;
  createTime?: string;
  createUser?: string;
  modifyTime?: string;
  modifyUser?: string;
  legaltags: string[];
  countries: string[];
  legalStatus?: string;
  viewers: string[];
  owners: string[];
  parents: string[];
  // UTF-8 bytes of the latest version serialized as JSON.
  bytes: number;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);
const strs = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

interface RawRecord {
  id?: unknown;
  kind?: unknown;
  version?: unknown;
  createTime?: unknown;
  createUser?: unknown;
  modifyTime?: unknown;
  modifyUser?: unknown;
  legal?: { legaltags?: unknown; otherRelevantDataCountries?: unknown; status?: unknown };
  acl?: { viewers?: unknown; owners?: unknown };
  ancestry?: { parents?: unknown };
  data?: { FacilityName?: unknown; Name?: unknown };
}

export function parseRecord(body: unknown, fallbackId: string): RecordDetail {
  const raw = (body && typeof body === "object" ? body : {}) as RawRecord;
  const opt = (key: keyof RecordDetail, v: string | undefined) => (v ? { [key]: v } : {});
  return {
    id: str(raw.id) ?? fallbackId,
    kind: str(raw.kind) ?? "?",
    ...(typeof raw.version === "number" ? { version: raw.version } : {}),
    ...opt("name", str(raw.data?.FacilityName) ?? str(raw.data?.Name)),
    ...opt("createTime", str(raw.createTime)),
    ...opt("createUser", str(raw.createUser)),
    ...opt("modifyTime", str(raw.modifyTime)),
    ...opt("modifyUser", str(raw.modifyUser)),
    legaltags: strs(raw.legal?.legaltags),
    countries: strs(raw.legal?.otherRelevantDataCountries),
    ...opt("legalStatus", str(raw.legal?.status)),
    viewers: strs(raw.acl?.viewers),
    owners: strs(raw.acl?.owners),
    parents: strs(raw.ancestry?.parents),
    bytes: new TextEncoder().encode(JSON.stringify(body ?? null)).length,
  };
}

export async function readRecord(batch: Batch, id: string): Promise<CallResult<RecordDetail>> {
  const res = await batch.adme("storage", `/records/${encodeURIComponent(id)}`);
  if (!res.ok) return res;
  return { ok: true, status: res.status, data: parseRecord(res.data, id) };
}

// ---- Module-held drawer state, one per runtime ----

export type RecordView =
  | { instance: string; id: string; at: string; ok: true; record: RecordDetail }
  | { instance: string; id: string; at: string; ok: false; error: string };

const views = new WeakMap<Runtime, RecordView>();

// A record read from another instance is never drawn.
export function openedRecord(rt: Runtime): RecordView | undefined {
  const v = views.get(rt);
  return v && v.instance === instanceOf(rt.profile) ? v : undefined;
}

export function setOpenedRecord(rt: Runtime, view: RecordView): void {
  views.set(rt, view);
}
