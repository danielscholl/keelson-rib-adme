// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { DirectoryEntry } from "../access/read.ts";
import { shortId } from "../profile.ts";
import { isDefaultGroup, type SeismicRead, type Subproject } from "./read.ts";

export type SeisRole = "admin" | "viewer";

export interface Member {
  id: string;
  kind: "person" | "app" | "group" | "unknown";
  name: string;
  email?: string;
  you: boolean;
}

export type RoleState =
  | { kind: "members"; members: Member[] }
  | { kind: "default"; group: string }
  // Refused or failed; `you` is known from the operator's own groups.
  | { kind: "unread"; reason: string; you: boolean };

export interface SubprojectView {
  name: string;
  path: string;
  legalTag?: string;
  accessPolicy?: string;
  adminGroups: string[];
  viewerGroups: string[];
  admins: RoleState;
  viewers: RoleState;
  acl: "own" | "default";
  empty: boolean;
}

export interface Grant {
  subproject: string;
  role: SeisRole;
}

export interface SeismicModel {
  tenant: string;
  source: SeismicRead["source"];
  subprojects: SubprojectView[];
  // Explicit grants per member id, from own-ACL groups only.
  grants: Record<string, Grant[]>;
  members: Record<string, Member>;
  partial: boolean;
  unreadGroups: number;
}

export interface SeismicContext {
  directory?: Record<string, DirectoryEntry> | undefined;
  signedInAs?: string | undefined;
  admeAppId?: string | undefined;
}

function addresses(entry: DirectoryEntry): string[] {
  return [entry.mail, entry.upn, ...(entry.otherMails ?? [])]
    .filter((a): a is string => Boolean(a))
    .map((a) => a.toLowerCase());
}

interface Index {
  byId: Map<string, DirectoryEntry>;
  byAddress: Map<string, [string, DirectoryEntry]>;
}

function index(dirs: readonly (Record<string, DirectoryEntry> | undefined)[]): Index {
  const byId = new Map<string, DirectoryEntry>();
  const byAddress = new Map<string, [string, DirectoryEntry]>();
  for (const dir of dirs) {
    for (const [id, entry] of Object.entries(dir ?? {})) {
      if (!byId.has(id)) byId.set(id, entry);
      if (entry.kind === "app" && entry.appId && !byId.has(entry.appId))
        byId.set(entry.appId, entry);
      if (entry.kind !== "user") continue;
      for (const a of addresses(entry)) if (!byAddress.has(a)) byAddress.set(a, [id, entry]);
    }
  }
  return { byId, byAddress };
}

function resolve(id: string, idx: Index, you: (id: string, e?: DirectoryEntry) => boolean): Member {
  if (id.includes("@")) {
    const hit = idx.byAddress.get(id);
    if (hit) return resolve(hit[0], idx, you);
    if (id.startsWith("users.") || id.startsWith("data.")) {
      return { id, kind: "group", name: id.split("@")[0] as string, you: false };
    }
    return { id, kind: "unknown", name: id, you: false };
  }
  const entry = idx.byId.get(id);
  if (!entry) return { id, kind: "unknown", name: shortId(id), you: you(id) };
  if (entry.kind === "app") return { id, kind: "app", name: entry.name, you: false };
  const email = entry.mail ?? entry.upn;
  return {
    id,
    kind: "person",
    name: entry.name,
    ...(email ? { email } : {}),
    you: you(id, entry),
  };
}

const KIND_RANK: Record<Member["kind"], number> = { person: 0, app: 1, group: 2, unknown: 3 };

export function buildSeismic(read: SeismicRead, ctx: SeismicContext = {}): SeismicModel {
  const idx = index([ctx.directory, read.directory]);
  const signedIn = ctx.signedInAs?.toLowerCase();
  const root = ctx.admeAppId?.toLowerCase();
  const own = new Set(read.ownGroups ?? []);
  const isYou = (id: string, e?: DirectoryEntry) =>
    id === read.you ||
    (signedIn !== undefined && e !== undefined && addresses(e).includes(signedIn));

  // Every seismic group lists the instance's own app and users.data.root; neither is a grant.
  const structural = (id: string) => id === root || id.startsWith("users.data.root@");

  const members: Record<string, Member> = {};
  const grants: Record<string, Grant[]> = {};
  let unreadGroups = 0;

  const role = (sub: Subproject, r: SeisRole): RoleState => {
    const emails = r === "admin" ? sub.admins : sub.viewers;
    const def = emails.find(isDefaultGroup);
    if (def) return { kind: "default", group: def.split("@")[0] as string };
    if (emails.length === 0) {
      unreadGroups++;
      return { kind: "unread", reason: "group not known", you: false };
    }
    const ids = new Set<string>();
    for (const email of emails) {
      const g = read.groups[email];
      if (!g?.members) {
        unreadGroups++;
        const reason = g?.refused ? "listing members was refused" : (g?.error ?? "not read");
        return { kind: "unread", reason, you: own.has(email) };
      }
      for (const id of g.members) if (!structural(id)) ids.add(id);
    }
    const list: Member[] = [];
    for (const raw of ids) {
      const m = resolve(raw, idx, isYou);
      if (list.some((x) => x.id === m.id)) continue;
      list.push(m);
      members[m.id] = m;
      const held = grants[m.id] ?? [];
      held.push({ subproject: sub.name, role: r });
      grants[m.id] = held;
    }
    list.sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || a.name.localeCompare(b.name));
    return { kind: "members", members: list };
  };

  const subprojects = read.subprojects.map((sub): SubprojectView => {
    const admins = role(sub, "admin");
    const viewers = role(sub, "viewer");
    const acl = admins.kind === "default" || viewers.kind === "default" ? "default" : "own";
    const empty =
      admins.kind === "members" &&
      viewers.kind === "members" &&
      admins.members.length === 0 &&
      viewers.members.length === 0;
    return {
      name: sub.name,
      path: `sd://${read.tenant}/${sub.name}`,
      ...(sub.legalTag ? { legalTag: sub.legalTag } : {}),
      ...(sub.accessPolicy ? { accessPolicy: sub.accessPolicy } : {}),
      adminGroups: sub.admins,
      viewerGroups: sub.viewers,
      admins,
      viewers,
      acl,
      empty,
    };
  });

  return {
    tenant: read.tenant,
    source: read.source,
    subprojects,
    grants,
    members,
    partial: read.source === "own-groups" || unreadGroups > 0,
    unreadGroups,
  };
}

// Own ACL with members first, then default ACL, then empty or unread, each in list order.
export function displayOrder(model: SeismicModel): SubprojectView[] {
  const rank = (s: SubprojectView) => {
    if (s.acl === "default") return 1;
    return s.empty || s.admins.kind === "unread" || s.viewers.kind === "unread" ? 2 : 0;
  };
  return model.subprojects
    .map((s, i) => ({ s, i }))
    .sort((a, b) => rank(a.s) - rank(b.s) || a.i - b.i)
    .map((x) => x.s);
}

export interface SeismicCounts {
  subprojects: number;
  own: number;
  defaults: string[];
  empty: string[];
  // People (not applications) holding at least one explicit grant.
  peopleWithGrants: number;
}

export function countSeismic(model: SeismicModel): SeismicCounts {
  const defaults = model.subprojects.filter((s) => s.acl === "default").map((s) => s.name);
  return {
    subprojects: model.subprojects.length,
    own: model.subprojects.length - defaults.length,
    defaults,
    empty: model.subprojects.filter((s) => s.empty).map((s) => s.name),
    peopleWithGrants: Object.keys(model.grants).filter((id) => model.members[id]?.kind === "person")
      .length,
  };
}
