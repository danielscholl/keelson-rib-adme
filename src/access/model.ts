// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { type AccessRead, type DirectoryEntry, GROUP_KEYS, type GroupKey } from "./read.ts";

export type Role = "Ops" | "Admin" | "Editor" | "Viewer";
export const ROLES: readonly Role[] = ["Ops", "Admin", "Editor", "Viewer"];

const ROLE_OF: Record<Exclude<GroupKey, "users">, Role> = {
  ops: "Ops",
  admins: "Admin",
  editors: "Editor",
  viewers: "Viewer",
};

export type State = "healthy" | "pending" | "broken";
export type Cause = "missing-users" | "duplicate";

export interface Identity {
  id: string;
  kind: "person" | "app" | "unknown";
  name: string;
  email?: string;
  cohort?: string;
  role?: Role;
  memberships: Partial<Record<GroupKey, "M" | "O">>;
  state: State;
  cause?: Cause;
  // The role group that lists this person twice, by object id and by email.
  duplicateIn?: GroupKey;
  guest: boolean;
  invitedAt?: string;
  acceptedAt?: string;
  you: boolean;
  appId?: string;
  // The app the instance itself runs as; entitlements treats it as root.
  root: boolean;
}

export interface AccessModel {
  people: Identity[];
  apps: Identity[];
  unknown: Identity[];
}

export interface ModelContext {
  signedInAs?: string | undefined;
  admeAppId?: string | undefined;
  cohortOf?: ((email: string | undefined) => string | undefined) | undefined;
}

function addresses(entry: DirectoryEntry): string[] {
  return [entry.mail, entry.upn, ...(entry.otherMails ?? [])]
    .filter((a): a is string => Boolean(a))
    .map((a) => a.toLowerCase());
}

function highestRole(memberships: Identity["memberships"]): Role | undefined {
  for (const key of ["ops", "admins", "editors", "viewers"] as const) {
    if (memberships[key]) return ROLE_OF[key];
  }
  return undefined;
}

export function buildAccess(read: AccessRead, ctx: ModelContext = {}): AccessModel {
  const byAddress = new Map<string, string>();
  for (const [id, entry] of Object.entries(read.directory)) {
    if (entry.kind !== "user") continue;
    for (const a of addresses(entry)) if (!byAddress.has(a)) byAddress.set(a, id);
  }

  const memberships = new Map<string, Identity["memberships"]>();
  const duplicates = new Map<string, GroupKey>();
  for (const key of GROUP_KEYS) {
    const seen = new Set<string>();
    for (const m of read.groups[key]) {
      const id = m.id.includes("@") ? (byAddress.get(m.id) ?? m.id) : m.id;
      if (seen.has(id)) {
        if (!duplicates.has(id)) duplicates.set(id, key);
        continue;
      }
      seen.add(id);
      const held = memberships.get(id) ?? {};
      held[key] = m.owner ? "O" : "M";
      memberships.set(id, held);
    }
  }

  const you = ctx.signedInAs?.toLowerCase();
  const model: AccessModel = { people: [], apps: [], unknown: [] };
  for (const [id, held] of memberships) {
    const entry = read.directory[id];
    const role = highestRole(held);
    const base = { id, memberships: held, ...(role ? { role } : {}), you: false, root: false };
    if (!entry) {
      model.unknown.push({ ...base, kind: "unknown", name: id, state: "healthy", guest: false });
      continue;
    }
    if (entry.kind === "app") {
      const appId = entry.appId ?? id;
      model.apps.push({
        ...base,
        kind: "app",
        name: entry.name,
        state: "healthy",
        guest: false,
        appId,
        root: appId === ctx.admeAppId?.toLowerCase(),
      });
      continue;
    }
    const email = entry.mail ?? entry.upn;
    const cohort = addresses(entry)
      .map((a) => ctx.cohortOf?.(a))
      .find((c) => c !== undefined);
    const duplicateIn = duplicates.get(id);
    const pending = entry.inviteState === "PendingAcceptance";
    const cause: Cause | undefined =
      role && !held.users ? "missing-users" : duplicateIn ? "duplicate" : undefined;
    model.people.push({
      ...base,
      kind: "person",
      name: entry.name,
      ...(email ? { email } : {}),
      ...(cohort ? { cohort } : {}),
      state: cause ? "broken" : pending ? "pending" : "healthy",
      ...(cause ? { cause } : {}),
      ...(duplicateIn ? { duplicateIn } : {}),
      guest: entry.guest ?? false,
      ...(pending && entry.inviteChangedAt ? { invitedAt: entry.inviteChangedAt } : {}),
      ...(entry.inviteState === "Accepted" && entry.inviteChangedAt
        ? { acceptedAt: entry.inviteChangedAt }
        : {}),
      you: you !== undefined && addresses(entry).includes(you),
    });
  }
  const byName = (a: Identity, b: Identity) => a.name.localeCompare(b.name);
  model.people.sort(byName);
  model.apps.sort(byName);
  model.unknown.sort(byName);
  return model;
}

export interface AccessCounts {
  people: number;
  guests: number;
  healthy: number;
  pending: number;
  broken: number;
  missingUsers: number;
  duplicates: number;
  needsYou: number;
  roles: Record<Role, number>;
  noRole: number;
  apps: number;
  rootApps: number;
  unknown: number;
  oldestInvite?: string;
}

export function countAccess(model: AccessModel): AccessCounts {
  const roles: Record<Role, number> = { Ops: 0, Admin: 0, Editor: 0, Viewer: 0 };
  let oldestInvite: string | undefined;
  for (const p of model.people) {
    if (p.role) roles[p.role]++;
    if (p.state !== "pending" || !p.invitedAt) continue;
    if (!oldestInvite || p.invitedAt < oldestInvite) oldestInvite = p.invitedAt;
  }
  const n = (f: (p: Identity) => boolean) => model.people.filter(f).length;
  const pending = n((p) => p.state === "pending");
  const broken = n((p) => p.state === "broken");
  return {
    people: model.people.length,
    guests: n((p) => p.guest),
    healthy: n((p) => p.state === "healthy"),
    pending,
    broken,
    missingUsers: n((p) => p.cause === "missing-users"),
    duplicates: n((p) => p.duplicateIn !== undefined),
    needsYou: pending + broken + model.unknown.length,
    roles,
    noRole: n((p) => !p.role),
    apps: model.apps.length,
    rootApps: model.apps.filter((a) => a.root).length,
    unknown: model.unknown.length,
    ...(oldestInvite ? { oldestInvite } : {}),
  };
}
