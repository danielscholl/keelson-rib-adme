// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { Batch, CallResult } from "../client.ts";
import {
  ACTIVITY_KEY,
  ATTENTION_KEY,
  ORGS_KEY,
  PEOPLE_KEY,
  PERSON_KEY,
  PULSE_KEY,
} from "../keys.ts";
import type { Area, Runtime } from "../runtime.ts";
import type { AccessModel, Identity } from "./model.ts";

export const ACTIVITY_AREA = "activity";
export const ACTIVITY_DAYS = 90;
export const RECENT_DAYS = 14;
export const ACTIVE_DAYS = 7;

export const NO_WORKSPACE = "no audit log workspace is set";

const DAY_MS = 86_400_000;

// Calls one identity made on one UTC day, from OEPAuditLogs.
export interface ActivityRow {
  id: string;
  day: string;
  calls: number;
}

export interface ActivityRead {
  windowDays: number;
  rows: ActivityRow[];
}

// Invited has not accepted, Not used has no call since access was granted,
// Active called in the last 7 days, Idle has called but not in the last 7 days.
export type Usage = "invited" | "not-used" | "idle" | "active";

export const USAGE_LABEL: Record<Usage, string> = {
  invited: "Invited",
  "not-used": "Not used",
  idle: "Idle",
  active: "Active",
};

export const USAGE_TONE = {
  invited: "info",
  "not-used": "warn",
  idle: "caution",
  active: "ok",
} as const;

export interface PersonActivity {
  last: string;
  calls: number;
  perDay: Record<string, number>;
}

export interface ActivityModel {
  windowDays: number;
  byId: Map<string, PersonActivity>;
  // The recent window, oldest day first, as YYYY-MM-DD.
  recent: string[];
  // The oldest day the log returned: "never" only reaches back this far.
  since?: string;
}

function kqlString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// Puid carries the caller's object id, the same id entitlements lists people by.
export function activityQuery(partition: string): string {
  return [
    "OEPAuditLogs",
    `| where TimeGenerated > ago(${ACTIVITY_DAYS}d)`,
    `| where DataPartitionId =~ ${kqlString(partition)}`,
    "| where isnotempty(Puid)",
    "| summarize calls = count() by id = tolower(Puid), day = format_datetime(startofday(TimeGenerated), 'yyyy-MM-dd')",
  ].join("\n");
}

interface LogsTable {
  columns?: { name?: string }[];
  rows?: unknown[][];
}

export function parseActivity(body: unknown): ActivityRow[] | undefined {
  const table = (body as { tables?: LogsTable[] } | undefined)?.tables?.[0];
  if (!table?.columns || !Array.isArray(table.rows)) return undefined;
  const col = (name: string) => table.columns?.findIndex((c) => c.name === name) ?? -1;
  const [id, day, calls] = [col("id"), col("day"), col("calls")];
  if (id < 0 || day < 0 || calls < 0) return undefined;
  const out: ActivityRow[] = [];
  for (const row of table.rows) {
    const i = row[id];
    const d = row[day];
    const n = Number(row[calls]);
    if (typeof i !== "string" || typeof d !== "string" || !Number.isFinite(n)) continue;
    out.push({ id: i.toLowerCase(), day: d.slice(0, 10), calls: n });
  }
  return out;
}

export async function readActivity(batch: Batch): Promise<CallResult<ActivityRead>> {
  const workspace = batch.profile.logWorkspaceId;
  if (!workspace) {
    return { ok: false, failure: { kind: "client", status: null, message: NO_WORKSPACE } };
  }
  const res = await batch.logs(
    workspace,
    activityQuery(batch.profile.partition),
    `P${ACTIVITY_DAYS}D`,
  );
  // A sign-in that cannot read the workspace leaves the rest of the rib connected.
  if (!res.ok) {
    return {
      ok: false,
      failure: { ...res.failure, kind: "client", message: `Audit log: ${res.failure.message}` },
    };
  }
  const rows = parseActivity(res.data);
  if (!rows) {
    return {
      ok: false,
      failure: {
        kind: "client",
        status: res.status,
        message: "Audit log: the query did not return id, day and calls",
      },
    };
  }
  return { ok: true, status: res.status, data: { windowDays: ACTIVITY_DAYS, rows } };
}

export function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function daysBetween(fromDay: string, to: Date): number {
  return Math.round((Date.parse(utcDay(to)) - Date.parse(fromDay.slice(0, 10))) / DAY_MS);
}

export function recentDays(now: Date, n = RECENT_DAYS): string[] {
  return Array.from({ length: n }, (_, i) =>
    utcDay(new Date(now.getTime() - (n - 1 - i) * DAY_MS)),
  );
}

export function buildActivity(read: ActivityRead, now: Date): ActivityModel {
  const byId = new Map<string, PersonActivity>();
  for (const r of read.rows) {
    const a = byId.get(r.id) ?? { last: r.day, calls: 0, perDay: {} };
    a.calls += r.calls;
    a.perDay[r.day] = (a.perDay[r.day] ?? 0) + r.calls;
    if (r.day > a.last) a.last = r.day;
    byId.set(r.id, a);
  }
  const since = read.rows.reduce<string | undefined>(
    (m, r) => (!m || r.day < m ? r.day : m),
    undefined,
  );
  return {
    windowDays: read.windowDays,
    byId,
    recent: recentDays(now),
    ...(since ? { since } : {}),
  };
}

export function noCall(model: ActivityModel): string {
  return model.since ? `no data call since ${model.since}` : "no data call in the audit log";
}

export function usageOf(
  p: Identity,
  activity: ActivityModel | undefined,
  now: Date,
): Usage | undefined {
  if (p.state === "pending") return "invited";
  if (!activity) return undefined;
  const a = activity.byId.get(p.id);
  if (!a) return "not-used";
  return daysBetween(a.last, now) < ACTIVE_DAYS ? "active" : "idle";
}

// When access was granted, as near as Entra can say.
export function grantedAt(p: Identity): string | undefined {
  return p.acceptedAt ?? p.invitedAt ?? p.createdAt;
}

export function callsIn(a: PersonActivity | undefined, days: readonly string[]): number {
  if (!a) return 0;
  return days.reduce((n, d) => n + (a.perDay[d] ?? 0), 0);
}

export type ActivityState =
  | { kind: "measured"; model: ActivityModel }
  | { kind: "unset" }
  | { kind: "unread"; error?: string };

// Fail closed: the rib's own sweep calls as the operator, so a log that holds
// no call from them is not this instance's log, or Puid is not the object id.
export function activityState(rt: Runtime, access: AccessModel): ActivityState {
  if (!rt.profile?.logWorkspaceId) return { kind: "unset" };
  const cached = rt.cache.get<ActivityRead>(ACTIVITY_AREA);
  if (!cached.data)
    return cached.error ? { kind: "unread", error: cached.error } : { kind: "unread" };
  const model = buildActivity(cached.data, rt.now());
  const you = access.people.find((p) => p.you);
  const known = [...access.people, ...access.apps];
  const trusted = you ? model.byId.has(you.id) : known.some((p) => model.byId.has(p.id));
  if (!trusted) {
    return {
      kind: "unread",
      error: you
        ? "the audit log holds no call from you, so it is not read as this instance's log"
        : "no caller in the audit log matches anyone with access",
    };
  }
  return { kind: "measured", model };
}

export const ACTIVITY_AREAS: readonly Area[] = [
  {
    name: ACTIVITY_AREA,
    keys: [PULSE_KEY, ATTENTION_KEY, ACTIVITY_KEY, ORGS_KEY, PEOPLE_KEY, PERSON_KEY],
    read: readActivity,
  },
];
