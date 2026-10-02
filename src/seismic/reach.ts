// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { Identity } from "../access/model.ts";
import type { SeismicModel, SeisRole } from "./model.ts";

export interface Reach {
  subproject: string;
  path: string;
  role: SeisRole;
  via: "direct" | "default";
  // The data.default group, for reach through the default ACL.
  group?: string;
}

export function hasDataRole(p: Identity): boolean {
  const m = p.memberships;
  return Boolean(m.viewers || m.editors || m.admins || m.ops);
}

// Default-ACL reach first, then direct grants, each in list order.
export function reachOf(model: SeismicModel, person: Identity): Reach[] {
  const ids = [person.id, ...(person.appId ? [person.appId] : [])];
  const grants = ids.flatMap((id) => model.grants[id] ?? []);
  const viaDefault: Reach[] = [];
  const direct: Reach[] = [];
  for (const s of model.subprojects) {
    const roles = new Set(grants.filter((g) => g.subproject === s.name).map((g) => g.role));
    if (roles.size > 0) {
      direct.push({
        subproject: s.name,
        path: s.path,
        role: roles.has("admin") ? "admin" : "viewer",
        via: "direct",
      });
    } else if (s.viewers.kind === "default" && hasDataRole(person)) {
      viaDefault.push({
        subproject: s.name,
        path: s.path,
        role: "viewer",
        via: "default",
        group: s.viewers.group,
      });
    }
  }
  return [...viaDefault, ...direct];
}

const WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

function count(n: number): string {
  return WORDS[n] ?? String(n);
}

export function andList(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

export function accessNote(reach: readonly Reach[], tenant: string, host: string): string {
  const n = reach.length;
  const paths = andList(reach.map((r) => r.path));
  const noun = n === 1 ? "subproject" : "subprojects";
  const admin = reach.filter((r) => r.role === "admin");
  const roles =
    admin.length === 0
      ? `Your role in ${n === 1 ? "it" : "each"} is viewer.`
      : admin.length === n
        ? `Your role in ${n === 1 ? "it" : "each"} is admin.`
        : `You are admin on ${andList(admin.map((r) => r.path))} and viewer on the others.`;
  return [
    `You can read ${count(n)} seismic ${noun} in tenant ${tenant} on ${host}: ${paths}.`,
    roles,
    `Listing subprojects is admin only, so open ${n === 1 ? "it" : "them"} by path.`,
  ].join(" ");
}
