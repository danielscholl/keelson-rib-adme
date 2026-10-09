// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { Identity } from "../access/model.ts";
import { GROUP_NAMES, type GroupKey } from "../access/read.ts";
import type { Batch } from "../client.ts";
import { ALL_KINDS } from "./records.ts";

// Who can reach the records: each identity's ACL groups, through a role group or a direct grant.

// Role groups in the order a path is named by: the narrowest one that explains it.
const ROLE_ORDER: readonly Exclude<GroupKey, "users">[] = ["viewers", "editors", "admins", "ops"];

export interface Path {
  group: string;
  // A role group's name, or "direct" for a membership of the ACL group itself.
  via: string;
}

export type Gate = "ok" | "no-users" | "no-role";

export interface PersonReach {
  id: string;
  gate: Gate;
  paths: Path[];
}

// Direct members of each ACL group by principal id; null when the group was not read.
export type DirectMembers = Record<string, string[] | null>;

export function rolesHeld(p: Identity): Exclude<GroupKey, "users">[] {
  return ROLE_ORDER.filter((k) => p.memberships[k]);
}

// Entitlements turns away anyone outside users@ before ACLs are checked, and storage and
// search need a role group's service grants, so either missing means no path is usable.
export function reachOf(
  p: Identity,
  groups: readonly string[],
  closures: Record<GroupKey, string[]> | undefined,
  direct: DirectMembers,
): PersonReach {
  const roles = rolesHeld(p);
  const gate: Gate = !p.memberships.users ? "no-users" : roles.length === 0 ? "no-role" : "ok";
  const ids = new Set([p.id, ...(p.appId ? [p.appId] : [])]);
  const paths: Path[] = [];
  for (const group of groups) {
    const g = group.toLowerCase();
    const role = closures ? roles.find((k) => closures[k]?.includes(g)) : undefined;
    if (role) paths.push({ group, via: GROUP_NAMES[role] });
    else if (direct[group]?.some((id) => ids.has(id))) paths.push({ group, via: "direct" });
  }
  return { id: p.id, gate, paths };
}

// Identities that reach the same groups share one count; the key names that set.
export function setKey(paths: readonly Path[]): string {
  return [...new Set(paths.map((x) => x.group))].sort().join("\n");
}

function quoted(value: string): string {
  return `"${value.replace(/[\\"]/g, "\\$&")}"`;
}

export function reachQuery(groups: readonly string[]): string {
  const any = `(${groups.map(quoted).join(" OR ")})`;
  return `acl.viewers:${any} OR acl.owners:${any}`;
}

interface MemberList {
  members?: { email?: string }[];
}

// Direct principals of each ACL group; nested groups are left to the role closures.
export async function readDirect(
  batch: Batch,
  groups: readonly string[],
): Promise<{ direct: DirectMembers; errors: string[] }> {
  const results = await Promise.all(
    groups.map((g) =>
      batch.adme<MemberList>("entitlements", `/groups/${encodeURIComponent(g)}/members`),
    ),
  );
  const direct: DirectMembers = {};
  const errors: string[] = [];
  for (const [i, res] of results.entries()) {
    const g = groups[i] as string;
    if (res.ok) {
      direct[g] = (res.data.members ?? [])
        .map((m) => (m.email ?? "").toLowerCase())
        .filter((e) => e && !e.includes("@"));
    } else if (res.failure.kind === "not-found") {
      direct[g] = [];
    } else {
      direct[g] = null;
      errors.push(`${g}: ${res.failure.message}`);
    }
  }
  return { direct, errors };
}

// Records any of the groups can read or own: one tracked total per distinct set.
export async function readReachCount(
  batch: Batch,
  groups: readonly string[],
): Promise<number | null> {
  if (groups.length === 0) return 0;
  const res = await batch.adme<{ totalCount?: unknown }>("search", "/query", {
    method: "POST",
    body: {
      kind: ALL_KINDS,
      query: reachQuery(groups),
      limit: 1,
      returnedFields: ["id"],
      trackTotalCount: true,
    },
  });
  return res.ok && typeof res.data?.totalCount === "number" ? res.data.totalCount : null;
}
