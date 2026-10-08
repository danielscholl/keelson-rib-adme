// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { Batch, CallResult, Service } from "../client.ts";
import { CONNECTION_KEY, HEADER_KEY, SEIS_PULSE_KEY } from "../keys.ts";
import type { Area } from "../runtime.ts";

export const HEALTH_AREA = "health";
export const HEALTH_EVERY_MS = 60 * 60_000;

export type ServiceGroup = "Core" | "Files and ingestion" | "Reference" | "Domain data (DDMS)";

interface CatalogEntry {
  service: Service;
  label: string;
  group: ServiceGroup;
  // Path under the service's base that answers without side effects.
  probe: string;
}

// Every service an ADME instance can expose. A 404 means it is not enabled here.
export const SERVICE_CATALOG: readonly CatalogEntry[] = [
  { service: "entitlements", label: "entitlements", group: "Core", probe: "/info" },
  { service: "legal", label: "legal", group: "Core", probe: "/info" },
  { service: "storage", label: "storage", group: "Core", probe: "/info" },
  { service: "search", label: "search", group: "Core", probe: "/info" },
  { service: "indexer", label: "indexer", group: "Core", probe: "/info" },
  { service: "schema", label: "schema", group: "Core", probe: "/info" },
  { service: "partition", label: "partition", group: "Core", probe: "/info" },
  { service: "file", label: "file", group: "Files and ingestion", probe: "/info" },
  { service: "dataset", label: "dataset", group: "Files and ingestion", probe: "/info" },
  { service: "workflow", label: "workflow", group: "Files and ingestion", probe: "/info" },
  { service: "register", label: "register", group: "Files and ingestion", probe: "/info" },
  { service: "notification", label: "notification", group: "Files and ingestion", probe: "/info" },
  { service: "unit", label: "unit", group: "Reference", probe: "/info" },
  { service: "crs-catalog", label: "CRS catalog", group: "Reference", probe: "/info" },
  { service: "crs-conversion", label: "CRS conversion", group: "Reference", probe: "/info" },
  { service: "policy", label: "policy", group: "Reference", probe: "/info" },
  { service: "seismic", label: "seismic", group: "Domain data (DDMS)", probe: "/svcstatus" },
  { service: "wellbore", label: "wellbore", group: "Domain data (DDMS)", probe: "/ddms/v2/about" },
  { service: "reservoir", label: "reservoir", group: "Domain data (DDMS)", probe: "/info" },
];

// up: any HTTP answer but 404, so a 403 is a live service saying no.
// down: 5xx, a timeout or no answer. off: 404, not enabled on this instance.
export type ProbeState = "up" | "down" | "off";

export interface ServiceProbe {
  service: string;
  state: ProbeState;
  version?: string;
  status?: number;
  message?: string;
}

export type AzureState = "Available" | "Degraded" | "Unavailable" | "Unknown";

export type AzureHealth =
  | { state: AzureState; since?: string; summary?: string }
  | { state: "unread"; reason: string };

export interface Health {
  services: ServiceProbe[];
  azure: AzureHealth;
}

export function probe(service: string, res: CallResult<unknown>): ServiceProbe {
  if (res.ok) {
    const v = (res.data as { version?: unknown } | undefined)?.version;
    return { service, state: "up", ...(typeof v === "string" && v ? { version: v } : {}) };
  }
  const f = res.failure;
  const status = f.status !== null ? { status: f.status } : {};
  if (f.status === 404) return { service, state: "off", ...status };
  if (f.status === null || f.status >= 500) {
    return { service, state: "down", ...status, message: f.message };
  }
  return { service, state: "up", ...status, message: f.message };
}

const AZURE_STATES = new Set<string>(["Available", "Degraded", "Unavailable", "Unknown"]);

function quoted(s: string): string {
  return s.replace(/["\\]/g, "");
}

// Azure's own availability verdict for the instance, the signal the SLA is measured on.
// It needs Reader on the resource; without it the verdict rests on the probes alone.
export async function readAzureHealth(batch: Batch): Promise<AzureHealth> {
  const query =
    'resources | where type =~ "microsoft.openenergyplatform/energyservices"' +
    ` | where properties.dnsName =~ "${quoted(batch.profile.host)}" | project id`;
  const found = await batch.arm<{ data?: { id?: unknown }[] }>(
    "/providers/Microsoft.ResourceGraph/resources?api-version=2021-03-01",
    { method: "POST", body: { query, options: { $top: 5 } } },
  );
  if (!found.ok) return { state: "unread", reason: found.failure.message };
  const id = found.data?.data?.find((r) => typeof r.id === "string")?.id as string | undefined;
  if (!id) return { state: "unread", reason: "this sign-in cannot see the Azure resource" };
  const res = await batch.arm<{
    properties?: {
      availabilityState?: unknown;
      summary?: unknown;
      occuredTime?: unknown;
      occurredTime?: unknown;
    };
  }>(
    `${id}/providers/Microsoft.ResourceHealth/availabilityStatuses/current?api-version=2022-10-01`,
  );
  if (!res.ok) return { state: "unread", reason: res.failure.message };
  const p = res.data?.properties;
  const state = typeof p?.availabilityState === "string" ? p.availabilityState : "";
  if (!AZURE_STATES.has(state)) return { state: "unread", reason: "no availability state" };
  const since = p?.occurredTime ?? p?.occuredTime;
  return {
    state: state as AzureState,
    ...(typeof since === "string" ? { since } : {}),
    ...(typeof p?.summary === "string" ? { summary: p.summary } : {}),
  };
}

export async function readHealth(batch: Batch): Promise<CallResult<Health>> {
  const [results, azure] = await Promise.all([
    Promise.all(SERVICE_CATALOG.map((e) => batch.adme(e.service, e.probe))),
    readAzureHealth(batch),
  ]);
  for (const res of results) {
    if (!res.ok && res.failure.status === null && res.failure.kind === "signin") return res;
  }
  const services = results.map((res, i) =>
    probe((SERVICE_CATALOG[i] as CatalogEntry).service, res),
  );
  return { ok: true, status: 200, data: { services, azure } };
}

export const HEALTH_AREAS: readonly Area[] = [
  {
    name: HEALTH_AREA,
    keys: [HEADER_KEY, CONNECTION_KEY, SEIS_PULSE_KEY],
    read: readHealth,
    everyMs: HEALTH_EVERY_MS,
  },
];

// ---- The verdict: pure, from the measured health ----

export type Tone = "ok" | "caution" | "error" | "neutral";

export interface Verdict {
  tone: Tone;
  word: string;
  release?: string;
}

const MAJOR_MINOR = /^(\d+\.\d+)/;

// Releases by major.minor among services that report a version, most common first.
export function releases(services: readonly ServiceProbe[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const s of services) {
    const m = s.state === "up" ? s.version?.match(MAJOR_MINOR) : null;
    if (m?.[1]) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1] || b[0].localeCompare(a[0]));
}

export function labelOf(service: string): string {
  return SERVICE_CATALOG.find((e) => e.service === service)?.label ?? service;
}

export function verdict(health: Health | undefined): Verdict {
  if (!health) return { tone: "neutral", word: "health ?" };
  const found = releases(health.services);
  const release =
    found.length === 1 ? found[0]?.[0] : found.length > 1 ? "mixed versions" : undefined;
  const withRelease = (v: Verdict): Verdict => (release ? { ...v, release } : v);
  const down = health.services.filter((s) => s.state === "down");
  const azure = health.azure.state;
  if (azure === "Unavailable") return withRelease({ tone: "error", word: "Azure: unavailable" });
  if (down.length === 1) {
    return withRelease({
      tone: "caution",
      word: `${labelOf(down[0]?.service ?? "")} not answering`,
    });
  }
  if (down.length > 1) {
    return withRelease({ tone: "caution", word: `${down.length} services not answering` });
  }
  if (azure === "Degraded") return withRelease({ tone: "caution", word: "Azure: degraded" });
  return withRelease({ tone: "ok", word: "healthy" });
}
