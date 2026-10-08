// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { Runtime } from "../runtime.ts";
import type { KindCount } from "./areas.ts";

export const GROUP_BYS = ["family", "authority", "namespace", "version"] as const;
export type GroupBy = (typeof GROUP_BYS)[number];

export const GROUP_LABELS: Record<GroupBy, string> = {
  family: "Family",
  authority: "Authority",
  namespace: "Namespace",
  version: "Schema version",
};

// A kind is authority:namespace:entity:version; each group is one segment of it.
const SEGMENT: Record<GroupBy, number> = { authority: 0, namespace: 1, family: 2, version: 3 };

export interface KindGroup {
  key: string;
  label: string;
  count: number;
  kinds: number;
  versions: number;
  // The kind pattern that lists this group's records in search.
  pattern: string;
}

export function kindParts(kind: string): string[] | undefined {
  const parts = kind.split(":");
  return parts.length === 4 && parts.every(Boolean) ? parts : undefined;
}

// "work-product-component--WellLog" reads as "WellLog".
export function entityLabel(entity: string): string {
  const i = entity.indexOf("--");
  return i >= 0 ? entity.slice(i + 2) : entity;
}

export function groupKinds(kinds: readonly KindCount[], by: GroupBy): KindGroup[] {
  const at = SEGMENT[by];
  const groups = new Map<string, { count: number; kinds: number; versions: Set<string> }>();
  for (const k of kinds) {
    const parts = kindParts(k.kind);
    if (!parts) continue;
    const key = parts[at] as string;
    const g = groups.get(key) ?? { count: 0, kinds: 0, versions: new Set<string>() };
    g.count += k.count;
    g.kinds += 1;
    g.versions.add(parts[3] as string);
    groups.set(key, g);
  }
  return [...groups.entries()]
    .map(([key, g]) => {
      const pattern = ["*", "*", "*", "*"];
      pattern[at] = key;
      return {
        key,
        label: by === "family" ? entityLabel(key) : key,
        count: g.count,
        kinds: g.kinds,
        versions: g.versions.size,
        pattern: pattern.join(":"),
      };
    })
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

export function isGroupBy(value: unknown): value is GroupBy {
  return typeof value === "string" && (GROUP_BYS as readonly string[]).includes(value);
}

// In memory only: the Inventory opens grouped by family after a restart.
const state = new WeakMap<Runtime, GroupBy>();

export function groupBy(rt: Runtime): GroupBy {
  return state.get(rt) ?? "family";
}

export function setGroupBy(rt: Runtime, by: GroupBy): void {
  state.set(rt, by);
}
