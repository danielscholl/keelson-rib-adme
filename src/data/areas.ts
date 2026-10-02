// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { Batch, CallResult, Service } from "../client.ts";
import {
  DATA_BADGE_KEY,
  DATA_PULSE_KEY,
  LEGAL_KEY,
  RECORDS_KEY,
  SEIS_PULSE_KEY,
  SERVICES_KEY,
} from "../keys.ts";
import type { Area } from "../runtime.ts";

export const SERVICES_AREA = "services";
export const LEGAL_AREA = "legal";
export const KINDS_AREA = "kinds";

// ---- Services: GET /info per service ----

export type ProbeState = "ok" | "forbidden" | "error" | "unprobed";

export interface ServiceProbe {
  service: string;
  state: ProbeState;
  version?: string;
  status?: number;
  message?: string;
}

// Probed on every sweep. Others are listed as not probed so the gap is visible.
export const PROBED_SERVICES: readonly Service[] = [
  "entitlements",
  "legal",
  "storage",
  "search",
  "schema",
  "workflow",
  "file",
  "indexer",
  "partition",
];

export async function readServices(batch: Batch): Promise<CallResult<ServiceProbe[]>> {
  const infos = await Promise.all(
    PROBED_SERVICES.map((s) => batch.adme<{ version?: string }>(s, "/info")),
  );
  const seismic = await batch.adme<string>("seismic", "/svcstatus");
  for (const res of [...infos, seismic]) {
    if (!res.ok && res.failure.status === null && res.failure.kind === "signin") return res;
  }
  const probes: ServiceProbe[] = infos.map((res, i) => probe(PROBED_SERVICES[i] as string, res));
  probes.push(probe("seismic", seismic));
  return { ok: true, status: 200, data: probes };
}

function probe(service: string, res: CallResult<{ version?: string } | string>): ServiceProbe {
  if (res.ok) {
    const version = typeof res.data === "object" ? res.data?.version : undefined;
    return { service, state: "ok", ...(version ? { version } : {}) };
  }
  const f = res.failure;
  return {
    service,
    state: f.kind === "forbidden" ? "forbidden" : "error",
    ...(f.status !== null ? { status: f.status } : {}),
    message: f.message,
  };
}

// ---- Legal tags: valid and invalid lists ----

export interface LegalTag {
  name: string;
  description?: string;
  expirationDate?: string;
  countries: string[];
  dataType?: string;
  securityClassification?: string;
  personalData?: string;
  exportClassification?: string;
  originator?: string;
}

export interface LegalTags {
  valid: LegalTag[];
  invalid: LegalTag[];
}

interface RawTag {
  name: string;
  description?: string;
  properties?: {
    expirationDate?: string;
    countryOfOrigin?: string[];
    dataType?: string;
    securityClassification?: string;
    personalData?: string;
    exportClassification?: string;
    originator?: string;
  };
}

export function parseTag(raw: RawTag): LegalTag {
  const p = raw.properties ?? {};
  return {
    name: raw.name,
    ...(raw.description ? { description: raw.description } : {}),
    ...(p.expirationDate ? { expirationDate: p.expirationDate } : {}),
    countries: p.countryOfOrigin ?? [],
    ...(p.dataType ? { dataType: p.dataType } : {}),
    ...(p.securityClassification ? { securityClassification: p.securityClassification } : {}),
    ...(p.personalData ? { personalData: p.personalData } : {}),
    ...(p.exportClassification ? { exportClassification: p.exportClassification } : {}),
    ...(p.originator ? { originator: p.originator } : {}),
  };
}

export async function readLegal(batch: Batch): Promise<CallResult<LegalTags>> {
  const [valid, invalid] = await Promise.all([
    batch.adme<{ legalTags?: RawTag[] }>("legal", "/legaltags?valid=true"),
    batch.adme<{ legalTags?: RawTag[] }>("legal", "/legaltags?valid=false"),
  ]);
  if (!valid.ok) return valid;
  if (!invalid.ok) return invalid;
  return {
    ok: true,
    status: 200,
    data: {
      valid: (valid.data.legalTags ?? []).map(parseTag),
      invalid: (invalid.data.legalTags ?? []).map(parseTag),
    },
  };
}

// ---- Record counts by kind ----

export interface KindCount {
  kind: string;
  count: number;
}

export interface KindCounts {
  // Summed from the kind buckets: search caps totalCount at 10,000.
  total: number;
  kinds: KindCount[];
}

export async function readKinds(batch: Batch): Promise<CallResult<KindCounts>> {
  const res = await batch.adme<{ aggregations?: { key: string; count: number }[] }>(
    "search",
    "/query",
    {
      method: "POST",
      body: { kind: "*:*:*:*", query: "*", limit: 1, aggregateBy: "kind", returnedFields: ["id"] },
    },
  );
  if (!res.ok) return res;
  const kinds = (res.data.aggregations ?? [])
    .map((a) => ({ kind: a.key, count: a.count }))
    .sort((a, b) => b.count - a.count);
  return {
    ok: true,
    status: 200,
    data: { total: kinds.reduce((n, k) => n + k.count, 0), kinds },
  };
}

export const DATA_AREAS: readonly Area[] = [
  { name: SERVICES_AREA, keys: [SERVICES_KEY, DATA_PULSE_KEY, SEIS_PULSE_KEY], read: readServices },
  { name: LEGAL_AREA, keys: [LEGAL_KEY, DATA_PULSE_KEY, DATA_BADGE_KEY], read: readLegal },
  { name: KINDS_AREA, keys: [RECORDS_KEY, DATA_PULSE_KEY], read: readKinds },
];
