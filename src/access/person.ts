// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { Batch, CallResult } from "../client.ts";
import type { Runtime } from "../runtime.ts";
import { groupSets, type Identity } from "./model.ts";
import type { GroupKey } from "./read.ts";

// Tier 3: one person's effective groups, read when the inspector opens.
export interface PersonRead {
  at: string;
  groups: string[];
}

interface Selection {
  instance: string;
  id?: string;
  reads: Map<string, PersonRead>;
  errors: Map<string, { message: string; at: string }>;
}

const selections = new WeakMap<Runtime, Selection>();

function instanceOf(rt: Runtime): string {
  return rt.profile ? `${rt.profile.host}/${rt.profile.partition}` : "";
}

// A selection made against another instance is dropped.
function selection(rt: Runtime): Selection {
  const instance = instanceOf(rt);
  let s = selections.get(rt);
  if (!s || s.instance !== instance) {
    s = { instance, reads: new Map(), errors: new Map() };
    selections.set(rt, s);
  }
  return s;
}

export function selectedId(rt: Runtime): string | undefined {
  const s = selections.get(rt);
  return s?.instance === instanceOf(rt) ? s.id : undefined;
}

export function selectPerson(rt: Runtime, id: string): void {
  selection(rt).id = id;
}

export function personRead(rt: Runtime, id: string): PersonRead | undefined {
  return selection(rt).reads.get(id);
}

export function personError(rt: Runtime, id: string): { message: string; at: string } | undefined {
  return selection(rt).errors.get(id);
}

export function recordRead(rt: Runtime, id: string, groups: string[]): void {
  const s = selection(rt);
  s.reads.set(id, { at: rt.now().toISOString(), groups });
  s.errors.delete(id);
}

export function recordError(rt: Runtime, id: string, message: string): void {
  selection(rt).errors.set(id, { message, at: rt.now().toISOString() });
}

export async function readPersonGroups(batch: Batch, id: string): Promise<CallResult<string[]>> {
  const res = await batch.adme<{ groups?: { email?: string }[] }>(
    "entitlements",
    `/members/${encodeURIComponent(id)}/groups?type=NONE`,
  );
  if (!res.ok) {
    if (res.failure.kind === "signin" && res.failure.status === null) return res;
    return {
      ok: false,
      failure: { ...res.failure, message: `effective groups: ${res.failure.message}` },
    };
  }
  const groups = (res.data.groups ?? []).flatMap((g) => (g.email ? [g.email.toLowerCase()] : []));
  return { ok: true, status: res.status, data: [...new Set(groups)] };
}

export interface GroupAudit {
  // The per-person read, or the role groups' closures when there is none.
  source: "read" | "computed";
  held: string[];
  expected: string[];
  gaps: string[];
  extras: string[];
  baseline: string[];
}

export function auditGroups(
  person: Pick<Identity, "memberships">,
  closures: Record<GroupKey, string[]>,
  read: readonly string[] | undefined,
  accepted: readonly string[],
): GroupAudit {
  const sets = groupSets(person.memberships, closures);
  const held = read ? new Set(read) : sets.held;
  const known = new Set(accepted);
  const beyond = [...held].filter((g) => !sets.expected.has(g));
  return {
    source: read ? "read" : "computed",
    held: [...held],
    expected: [...sets.expected],
    gaps: [...sets.expected].filter((g) => !held.has(g)).sort(),
    extras: beyond.filter((g) => !known.has(g)).sort(),
    baseline: beyond.filter((g) => known.has(g)).sort(),
  };
}
