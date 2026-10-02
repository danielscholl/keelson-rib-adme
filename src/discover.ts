// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { RibExec } from "@keelson/shared";
import { z } from "zod";

export interface Instance {
  id: string;
  name: string;
  host: string;
  location: string;
  tenantId: string;
  admeAppId: string;
  partitions: string[];
  state: string;
}

export type Discovery =
  | { state: "idle" }
  | { state: "looking" }
  | { state: "found"; instances: Instance[] }
  | { state: "failed"; error: string };

const GRAPH_URL =
  "https://management.azure.com/providers/Microsoft.ResourceGraph/resources?api-version=2021-03-01";

const QUERY =
  'resources | where type =~ "microsoft.openenergyplatform/energyservices"' +
  " | project id, name, location, tenantId, properties | order by name asc";

const DISCOVER_TIMEOUT_MS = 60_000;

const rowSchema = z.object({
  id: z.string(),
  name: z.string(),
  location: z.string().optional(),
  tenantId: z.string(),
  properties: z.object({
    dnsName: z.string(),
    authAppId: z.string(),
    provisioningState: z.string().optional(),
    dataPartitionNames: z.array(z.object({ name: z.string() })).optional(),
  }),
});

export function parseInstances(data: unknown): Instance[] {
  const rows = (data as { data?: unknown } | undefined)?.data;
  if (!Array.isArray(rows)) return [];
  const out: Instance[] = [];
  for (const row of rows) {
    const parsed = rowSchema.safeParse(row);
    if (!parsed.success) continue;
    const r = parsed.data;
    out.push({
      id: r.id,
      name: r.name,
      host: r.properties.dnsName,
      location: r.location ?? "",
      tenantId: r.tenantId,
      admeAppId: r.properties.authAppId,
      partitions: (r.properties.dataPartitionNames ?? []).map((p) => p.name),
      state: r.properties.provisioningState ?? "",
    });
  }
  return out;
}

// Resource Graph through `az rest` covers every subscription the sign-in can
// read, not only the selected one, and needs no az extension.
export async function discoverInstances(exec: RibExec): Promise<Discovery> {
  const res = await exec.runJSON<unknown>(
    "az",
    [
      "rest",
      "--method",
      "post",
      "--url",
      GRAPH_URL,
      "--body",
      JSON.stringify({ query: QUERY, options: { $top: 200 } }),
      "--output",
      "json",
    ],
    { timeoutMs: DISCOVER_TIMEOUT_MS },
  );
  if (!res.ok) {
    const line = res.error.trim().split("\n")[0] ?? "";
    return {
      state: "failed",
      error: line.replace(/^ERROR:\s*/, "").slice(0, 300) || "az returned no result",
    };
  }
  return { state: "found", instances: parseInstances(res.data) };
}
