// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { type DirectoryEntry, readDirectory } from "../access/read.ts";
import type { Batch, CallFailure, CallResult } from "../client.ts";
import {
  SEIS_CHANGE_KEY,
  SEIS_PULSE_KEY,
  SEIS_REACH_KEY,
  SEIS_SELECTED_KEY,
  SEIS_SUBPROJECTS_KEY,
} from "../keys.ts";

// Tier 2: read only when the ADME Seismic tab is used, never on the sweep.
export const SEISMIC_AREA = "seismic";
export const SEISMIC_KEYS = [
  SEIS_PULSE_KEY,
  SEIS_SUBPROJECTS_KEY,
  SEIS_SELECTED_KEY,
  SEIS_CHANGE_KEY,
  SEIS_REACH_KEY,
] as const;

export interface Subproject {
  name: string;
  legalTag?: string;
  accessPolicy?: string;
  // ACL group emails per role, lowercased; empty when the role's group is unknown.
  admins: string[];
  viewers: string[];
}

export interface GroupRead {
  // Member ids lowercased: object ids, app ids, or emails for nested groups.
  members?: string[];
  error?: string;
  refused?: boolean;
}

export interface SeismicRead {
  tenant: string;
  // "own-groups" when listing subprojects was refused and they were parsed from
  // the operator's own data.sdms groups instead.
  source: "list" | "own-groups";
  subprojects: Subproject[];
  // Keyed by group email; data.default.* groups are not read.
  groups: Record<string, GroupRead>;
  // The operator's id and own groups, read only when something was refused.
  you?: string;
  ownGroups?: string[];
  // Names for member ids the access read did not cover.
  directory?: Record<string, DirectoryEntry>;
}

interface RawSubproject {
  name?: string;
  ltag?: string | null;
  access_policy?: string | null;
  acls?: { admins?: string[]; viewers?: string[] };
}

interface OwnGroups {
  desId?: string;
  memberEmail?: string;
  groups?: { email?: string }[];
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SDMS_GROUP = /^data\.sdms\.([^.]+)\.([^.]+)(?:\.[0-9a-f-]{36})?\.(admin|viewer)@/;

export function isDefaultGroup(email: string): boolean {
  return email.startsWith("data.default.");
}

function signin(f: CallFailure): boolean {
  return f.kind === "signin" && f.status === null;
}

const lower = (xs: readonly string[] | undefined) => (xs ?? []).map((x) => x.toLowerCase());

function fromList(raw: RawSubproject[]): Subproject[] {
  return raw.flatMap((s) =>
    s.name
      ? [
          {
            name: s.name,
            ...(s.ltag ? { legalTag: s.ltag } : {}),
            ...(s.access_policy ? { accessPolicy: s.access_policy } : {}),
            admins: lower(s.acls?.admins),
            viewers: lower(s.acls?.viewers),
          },
        ]
      : [],
  );
}

export function fromOwnGroups(tenant: string, emails: readonly string[]): Subproject[] {
  const byName = new Map<string, Subproject>();
  for (const email of emails) {
    const m = SDMS_GROUP.exec(email);
    if (!m || m[1] !== tenant) continue;
    const name = m[2] as string;
    const sub = byName.get(name) ?? { name, admins: [], viewers: [] };
    sub[m[3] === "admin" ? "admins" : "viewers"].push(email);
    byName.set(name, sub);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function readOwn(
  batch: Batch,
): Promise<CallResult<{ you?: string; groups: string[] }> | undefined> {
  const res = await batch.adme<OwnGroups>("entitlements", "/groups");
  if (!res.ok) return signin(res.failure) ? res : undefined;
  const you = (res.data.desId ?? res.data.memberEmail)?.toLowerCase();
  return {
    ok: true,
    status: 200,
    data: {
      ...(you ? { you } : {}),
      groups: (res.data.groups ?? []).flatMap((g) => (g.email ? [g.email.toLowerCase()] : [])),
    },
  };
}

export async function readSeismic(
  batch: Batch,
  known: ReadonlySet<string> = new Set(),
): Promise<CallResult<SeismicRead>> {
  const tenant = batch.profile.partition;
  const list = await batch.adme<RawSubproject[]>(
    "seismic",
    `/subproject/tenant/${encodeURIComponent(tenant)}`,
  );
  let own: { you?: string; groups: string[] } | undefined;
  let subprojects: Subproject[];
  let source: SeismicRead["source"] = "list";
  if (list.ok) {
    subprojects = fromList(Array.isArray(list.data) ? list.data : []);
  } else if (list.failure.kind === "forbidden") {
    const res = await readOwn(batch);
    if (res && !res.ok) return res;
    if (!res) return { ok: false, failure: { ...list.failure, message: "subprojects: refused" } };
    own = res.data;
    subprojects = fromOwnGroups(tenant, own.groups);
    source = "own-groups";
  } else {
    if (signin(list.failure)) return list;
    return {
      ok: false,
      failure: { ...list.failure, message: `subprojects: ${list.failure.message}` },
    };
  }

  const emails = [...new Set(subprojects.flatMap((s) => [...s.admins, ...s.viewers]))].filter(
    (e) => !isDefaultGroup(e),
  );
  const reads = await Promise.all(
    emails.map((e) =>
      batch.adme<{ members?: { email?: string }[] }>(
        "entitlements",
        `/groups/${encodeURIComponent(e)}/members`,
      ),
    ),
  );
  const groups: Record<string, GroupRead> = {};
  for (const [i, res] of reads.entries()) {
    const email = emails[i] as string;
    if (res.ok) {
      groups[email] = {
        members: (res.data.members ?? []).flatMap((m) => (m.email ? [m.email.toLowerCase()] : [])),
      };
      continue;
    }
    if (signin(res.failure)) return res;
    groups[email] = {
      error: res.failure.message,
      ...(res.failure.kind === "forbidden" ? { refused: true } : {}),
    };
  }

  if (!own && Object.values(groups).some((g) => g.refused)) {
    const res = await readOwn(batch);
    if (res && !res.ok) return res;
    own = res?.data;
  }

  const root = batch.profile.admeAppId.toLowerCase();
  const unnamed = [...new Set(Object.values(groups).flatMap((g) => g.members ?? []))].filter(
    (id) => GUID.test(id) && id !== root && !known.has(id),
  );
  let directory: Record<string, DirectoryEntry> | undefined;
  if (unnamed.length > 0) {
    const res = await readDirectory(batch, unnamed);
    if (!res.ok && signin(res.failure)) return res;
    if (res.ok) directory = res.data;
  }

  return {
    ok: true,
    status: 200,
    data: {
      tenant,
      source,
      subprojects,
      groups,
      ...(own?.you ? { you: own.you } : {}),
      ...(own ? { ownGroups: own.groups } : {}),
      ...(directory && Object.keys(directory).length > 0 ? { directory } : {}),
    },
  };
}
