// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { Batch, CallFailure, CallResult } from "../client.ts";
import {
  ACCESS_BADGE_KEY,
  ATTENTION_KEY,
  COHORTS_KEY,
  PEOPLE_KEY,
  PRINCIPALS_KEY,
  PULSE_KEY,
} from "../keys.ts";
import type { Area } from "../runtime.ts";

export const ACCESS_AREA = "access";

export const GROUP_NAMES = {
  users: "users",
  viewers: "users.datalake.viewers",
  editors: "users.datalake.editors",
  admins: "users.datalake.admins",
  ops: "users.datalake.ops",
} as const;

export type GroupKey = keyof typeof GROUP_NAMES;
export const GROUP_KEYS = Object.keys(GROUP_NAMES) as GroupKey[];

export interface GroupMember {
  // An Entra object id, an app id, or (rarely) an email address, lowercased.
  id: string;
  owner: boolean;
}

export interface DirectoryEntry {
  kind: "user" | "app";
  name: string;
  mail?: string;
  upn?: string;
  otherMails?: string[];
  guest?: boolean;
  inviteState?: string;
  inviteChangedAt?: string;
  createdAt?: string;
  appId?: string;
}

export interface RosterMember {
  id: string;
  name?: string;
  mail?: string;
}

export interface AccessRead {
  groups: Record<GroupKey, GroupMember[]>;
  directory: Record<string, DirectoryEntry>;
  // Each role group with every group it is nested in, so anyone's effective
  // groups follow from their direct memberships without a read per person.
  closures?: Record<GroupKey, string[]>;
  // Members of the Entra roster group; absent when no roster group is set.
  roster?: RosterMember[];
  // Listed ids that Entra holds as deleted users.
  deleted?: string[];
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const GET_BY_IDS_LIMIT = 1000;
const APP_FILTER_LIMIT = 15;
const USER_SELECT =
  "id,appId,displayName,mail,userPrincipalName,otherMails,userType,externalUserState,externalUserStateChangeDateTime,createdDateTime";

interface MemberList {
  members?: { email?: string; role?: string }[];
}

interface GraphObject {
  "@odata.type"?: string;
  id?: string;
  appId?: string;
  displayName?: string;
  mail?: string | null;
  userPrincipalName?: string;
  otherMails?: string[];
  userType?: string;
  externalUserState?: string | null;
  externalUserStateChangeDateTime?: string | null;
  createdDateTime?: string;
}

function fail<T>(failure: CallFailure, prefix: string): CallResult<T> {
  if (failure.kind === "signin" && failure.status === null) return { ok: false, failure };
  return { ok: false, failure: { ...failure, message: `${prefix}: ${failure.message}` } };
}

function userEntry(o: GraphObject): DirectoryEntry {
  return {
    kind: "user",
    name: o.displayName || o.mail || o.userPrincipalName || o.id || "?",
    ...(o.mail ? { mail: o.mail } : {}),
    ...(o.userPrincipalName ? { upn: o.userPrincipalName } : {}),
    ...(o.otherMails?.length ? { otherMails: o.otherMails } : {}),
    guest: o.userType === "Guest",
    ...(o.externalUserState ? { inviteState: o.externalUserState } : {}),
    ...(o.externalUserStateChangeDateTime
      ? { inviteChangedAt: o.externalUserStateChangeDateTime }
      : {}),
    ...(o.createdDateTime ? { createdAt: o.createdDateTime } : {}),
  };
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// Entitlements lists people by object id and applications by app id, so an id
// Graph does not know as an object is looked up as an app id.
async function readDirectory(
  batch: Batch,
  ids: readonly string[],
): Promise<CallResult<Record<string, DirectoryEntry>>> {
  const directory: Record<string, DirectoryEntry> = {};
  for (const chunk of chunks(ids, GET_BY_IDS_LIMIT)) {
    const res = await batch.graph<{ value?: GraphObject[] }>(
      `/v1.0/directoryObjects/getByIds?$select=${USER_SELECT}`,
      { method: "POST", body: { ids: chunk, types: ["user", "servicePrincipal"] } },
    );
    if (!res.ok) return fail(res.failure, "Graph names");
    for (const o of res.data.value ?? []) {
      if (!o.id) continue;
      const id = o.id.toLowerCase();
      // An application listed by its object id still reads as its app id.
      directory[id] = o["@odata.type"]?.endsWith("servicePrincipal")
        ? {
            kind: "app",
            name: o.displayName || o.id,
            ...(o.appId ? { appId: o.appId.toLowerCase() } : {}),
          }
        : userEntry(o);
    }
  }
  const unresolved = ids.filter((id) => !directory[id]);
  for (const chunk of chunks(unresolved, APP_FILTER_LIMIT)) {
    const filter = `appId in (${chunk.map((id) => `'${id}'`).join(",")})`;
    const res = await batch.graph<{ value?: GraphObject[] }>(
      `/v1.0/servicePrincipals?$filter=${encodeURIComponent(filter)}&$select=id,appId,displayName`,
    );
    if (!res.ok) return fail(res.failure, "Graph applications");
    for (const o of res.data.value ?? []) {
      if (o.appId)
        directory[o.appId.toLowerCase()] = { kind: "app", name: o.displayName || o.appId };
    }
  }
  return { ok: true, status: 200, data: directory };
}

async function readClosures(
  batch: Batch,
  domain: string,
): Promise<Record<GroupKey, string[]> | undefined> {
  const lists = await Promise.all(
    GROUP_KEYS.map((key) =>
      batch.adme<{ groups?: { email?: string }[] }>(
        "entitlements",
        `/members/${encodeURIComponent(`${GROUP_NAMES[key]}@${domain}`)}/groups?type=NONE`,
      ),
    ),
  );
  const closures = {} as Record<GroupKey, string[]>;
  for (const [i, res] of lists.entries()) {
    if (!res.ok) return undefined;
    const key = GROUP_KEYS[i] as GroupKey;
    const own = `${GROUP_NAMES[key]}@${domain}`.toLowerCase();
    const emails = (res.data.groups ?? []).flatMap((g) => (g.email ? [g.email.toLowerCase()] : []));
    closures[key] = [...new Set([own, ...emails])];
  }
  return closures;
}

async function readRoster(batch: Batch, groupId: string): Promise<RosterMember[] | undefined> {
  const members: RosterMember[] = [];
  let path: string | undefined =
    `/v1.0/groups/${encodeURIComponent(groupId)}/members?$select=id,displayName,mail&$top=999`;
  while (path) {
    const res: CallResult<{ value?: GraphObject[]; "@odata.nextLink"?: string }> =
      await batch.graph(path);
    if (!res.ok) return undefined;
    for (const o of res.data.value ?? []) {
      if (!o.id) continue;
      members.push({
        id: o.id.toLowerCase(),
        ...(o.displayName ? { name: o.displayName } : {}),
        ...(o.mail ? { mail: o.mail } : {}),
      });
    }
    const next: string | undefined = res.data["@odata.nextLink"];
    path = next ? next.replace("https://graph.microsoft.com", "") : undefined;
  }
  return members;
}

async function readDeleted(batch: Batch, ids: readonly string[]): Promise<string[] | undefined> {
  const deleted: string[] = [];
  for (const chunk of chunks(ids, APP_FILTER_LIMIT)) {
    const filter = `id in (${chunk.map((id) => `'${id}'`).join(",")})`;
    const res = await batch.graph<{ value?: { id?: string }[] }>(
      `/v1.0/directory/deletedItems/microsoft.graph.user?$filter=${encodeURIComponent(filter)}&$select=id`,
    );
    if (!res.ok) return undefined;
    for (const o of res.data.value ?? []) if (o.id) deleted.push(o.id.toLowerCase());
  }
  return deleted;
}

export async function readAccess(batch: Batch): Promise<CallResult<AccessRead>> {
  const domain = batch.profile.entitlementsDomain;
  if (!domain) {
    return {
      ok: false,
      failure: {
        kind: "client",
        status: null,
        message: "the entitlements domain is not read yet; Re-test the connection",
      },
    };
  }
  const lists = await Promise.all(
    GROUP_KEYS.map((key) =>
      batch.adme<MemberList>(
        "entitlements",
        `/groups/${encodeURIComponent(`${GROUP_NAMES[key]}@${domain}`)}/members`,
      ),
    ),
  );
  const groups = {} as Record<GroupKey, GroupMember[]>;
  for (const [i, res] of lists.entries()) {
    const key = GROUP_KEYS[i] as GroupKey;
    if (!res.ok) return fail(res.failure, GROUP_NAMES[key]);
    groups[key] = (res.data.members ?? [])
      .filter((m) => m.email)
      .map((m) => ({ id: (m.email as string).toLowerCase(), owner: m.role === "OWNER" }));
  }
  const ids = [...new Set(GROUP_KEYS.flatMap((k) => groups[k].map((m) => m.id)))].filter((id) =>
    GUID.test(id),
  );
  const rosterGroupId = batch.profile.rosterGroupId;
  const [directory, closures, roster] = await Promise.all([
    readDirectory(batch, ids),
    readClosures(batch, domain),
    rosterGroupId ? readRoster(batch, rosterGroupId) : Promise.resolve(undefined),
  ]);
  if (!directory.ok) return directory;
  const unresolved = ids.filter((id) => !directory.data[id]);
  const deleted = unresolved.length > 0 ? await readDeleted(batch, unresolved) : [];
  return {
    ok: true,
    status: 200,
    data: {
      groups,
      directory: directory.data,
      ...(closures ? { closures } : {}),
      ...(roster ? { roster } : {}),
      ...(deleted ? { deleted } : {}),
    },
  };
}

export const ACCESS_AREAS: readonly Area[] = [
  {
    name: ACCESS_AREA,
    keys: [PULSE_KEY, ATTENTION_KEY, PEOPLE_KEY, COHORTS_KEY, PRINCIPALS_KEY, ACCESS_BADGE_KEY],
    read: readAccess,
  },
];
