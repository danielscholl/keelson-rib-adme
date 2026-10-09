// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { RibExec } from "@keelson/shared";
import { SERVICE_PATHS, type Service, type Transport } from "../client.ts";
import {
  APPS,
  AUDIT,
  AZURE_SINCE,
  aclOf,
  DOMAIN,
  guid,
  idOf,
  PARENTS,
  PEOPLE,
  type Person,
  RECORD_CLASSES,
  RECORD_GROUPS,
  type RecordClass,
  ROLE_GROUPS,
  ROSTER_GROUP_NAME,
  SAMPLE_PROFILE,
  SERVICES,
  SUBPROJECTS,
  sdmsGroup,
  TAGS,
  YOU,
} from "./world.ts";

export const READ_ONLY = "The sample instance is read-only.";

type Reply = { status: number; body?: unknown };

const ok = (body: unknown): Reply => ({ status: 200, body });
const notFound = (message = "Not found"): Reply => ({ status: 404, body: { message } });

// Answers `az account get-access-token` with a placeholder and refuses every other command.
export const sampleExec: RibExec = {
  runJSON: async <T>(cmd: string, args: string[]) => {
    if (cmd === "az" && args[0] === "account" && args[1] === "get-access-token") {
      return { ok: true as const, data: { accessToken: "sample" } as T };
    }
    return { ok: false as const, error: "the sample instance runs no commands", code: 1 };
  },
  runText: async () => ({
    ok: false as const,
    error: "the sample instance runs no commands",
    code: 1,
  }),
};

// ---- Entitlements ----

interface Member {
  email: string;
  role: "OWNER" | "MEMBER";
}

function buildGroups(): Map<string, Member[]> {
  const groups = new Map<string, Member[]>();
  const add = (group: string, email: string, role: Member["role"] = "MEMBER") => {
    const list = groups.get(group) ?? [];
    if (!list.some((m) => m.email === email)) list.push({ email, role });
    groups.set(group, list);
  };
  for (const g of Object.values(ROLE_GROUPS)) groups.set(g, []);
  for (const p of PEOPLE) {
    const owner = p.role === "ops" ? "OWNER" : "MEMBER";
    if (!p.notInUsers) add(ROLE_GROUPS.users, p.id, owner);
    add(ROLE_GROUPS[p.role], p.id, owner);
    if (p.duplicate) add(ROLE_GROUPS[p.role], p.mail);
  }
  for (const a of APPS) {
    add(ROLE_GROUPS.users, a.appId);
    add(ROLE_GROUPS[a.group], a.appId);
  }
  for (const [key, parents] of Object.entries(PARENTS)) {
    const own = ROLE_GROUPS[key as keyof typeof ROLE_GROUPS];
    for (const parent of parents) add(parent, own);
  }
  const root = SAMPLE_PROFILE.admeAppId;
  for (const g of Object.values(RECORD_GROUPS)) add(g, root, "OWNER");
  for (const s of SUBPROJECTS) {
    for (const role of ["admin", "viewer"] as const) {
      const who = role === "admin" ? s.admins : s.viewers;
      if (who === "default") continue;
      const g = sdmsGroup(s.name, role);
      add(g, root, "OWNER");
      add(g, `users.data.root@${DOMAIN}`);
      for (const w of who) add(g, idOf(w));
    }
  }
  return groups;
}

const GROUPS = buildGroups();

function parentsOf(member: string): string[] {
  const m = member.toLowerCase();
  const out: string[] = [];
  for (const [g, list] of GROUPS) if (list.some((x) => x.email.toLowerCase() === m)) out.push(g);
  return out;
}

// Every group a member reaches, nested groups followed.
function ancestors(member: string): string[] {
  const seen = new Set<string>();
  const queue = parentsOf(member);
  while (queue.length > 0) {
    const g = queue.shift() as string;
    if (seen.has(g)) continue;
    seen.add(g);
    queue.push(...parentsOf(g));
  }
  return [...seen];
}

function groupInfo(email: string) {
  return { name: email.split("@")[0], email, description: "" };
}

function entitlements(method: string, path: string): Reply {
  if (method !== "GET") return { status: 403, body: { message: READ_ONLY } };
  if (path === "/groups") {
    return ok({ desId: YOU.id, memberEmail: YOU.mail, groups: ancestors(YOU.id).map(groupInfo) });
  }
  if (path.startsWith("/groups/all")) {
    return ok({ groups: [...GROUPS.keys()].slice(0, 1).map(groupInfo), totalCount: GROUPS.size });
  }
  const members = /^\/groups\/([^/]+)\/members$/.exec(path);
  if (members) {
    const list = GROUPS.get(decodeURIComponent(members[1] as string).toLowerCase());
    return list ? ok({ members: list }) : notFound("Group not found");
  }
  const memberOf = /^\/members\/([^/]+)\/groups$/.exec(path);
  if (memberOf) {
    const id = decodeURIComponent(memberOf[1] as string);
    return ok({ desId: id, memberEmail: id, groups: ancestors(id).map(groupInfo) });
  }
  return notFound();
}

// ---- Microsoft Graph ----

function upnOf(p: Person): string {
  if (p.member) return p.mail;
  return `${p.mail.replace("@", "_")}#EXT#@contoso.onmicrosoft.com`;
}

function userObject(p: Person) {
  const guest = !p.member;
  return {
    "@odata.type": "#microsoft.graph.user",
    id: p.id,
    displayName: p.name,
    mail: p.mail,
    userPrincipalName: upnOf(p),
    otherMails: p.otherMails ?? [],
    userType: guest ? "Guest" : "Member",
    externalUserState: guest ? (p.accepted ? "Accepted" : "PendingAcceptance") : null,
    externalUserStateChangeDateTime: guest ? `${p.accepted ?? p.invited}T09:00:00Z` : null,
    createdDateTime: `${p.invited}T08:00:00Z`,
  };
}

function servicePrincipal(a: (typeof APPS)[number]) {
  return {
    "@odata.type": "#microsoft.graph.servicePrincipal",
    id: a.objectId,
    appId: a.appId,
    displayName: a.name,
  };
}

function quotedValues(filter: string): string[] {
  return [...filter.matchAll(/'((?:[^']|'')*)'/g)].map((m) => (m[1] as string).replace(/''/g, "'"));
}

function graph(method: string, url: URL, body: unknown): Reply {
  const path = url.pathname;
  const filter = url.searchParams.get("$filter") ?? "";
  if (method === "POST" && path === "/v1.0/directoryObjects/getByIds") {
    const ids = new Set(((body as { ids?: string[] })?.ids ?? []).map((i) => i.toLowerCase()));
    return ok({
      value: [
        ...PEOPLE.filter((p) => ids.has(p.id)).map(userObject),
        ...APPS.filter((a) => ids.has(a.objectId)).map(servicePrincipal),
      ],
    });
  }
  if (method !== "GET") return { status: 403, body: { error: { message: READ_ONLY } } };
  if (path === "/v1.0/me") {
    return ok({ userPrincipalName: YOU.mail, mail: YOU.mail, userType: "Member" });
  }
  if (path === "/v1.0/policies/authorizationPolicy") {
    return ok({ allowInvitesFrom: "adminsGuestInvitersAndAllMembers" });
  }
  if (path.startsWith("/v1.0/directory/deletedItems")) return ok({ value: [] });
  if (path === "/v1.0/servicePrincipals") {
    const wanted = new Set(quotedValues(filter).map((v) => v.toLowerCase()));
    return ok({ value: APPS.filter((a) => wanted.has(a.appId)).map(servicePrincipal) });
  }
  if (path === "/v1.0/groups") {
    const named = quotedValues(filter)[0];
    return ok({
      value:
        named === ROSTER_GROUP_NAME
          ? [{ id: SAMPLE_PROFILE.rosterGroupId, displayName: ROSTER_GROUP_NAME }]
          : [],
    });
  }
  if (path === `/v1.0/groups/${SAMPLE_PROFILE.rosterGroupId}/members`) {
    return ok({ value: PEOPLE.map((p) => ({ id: p.id, displayName: p.name, mail: p.mail })) });
  }
  if (path === "/v1.0/users") {
    const wanted = new Set(quotedValues(filter).map((v) => v.toLowerCase()));
    const hit = PEOPLE.filter(
      (p) =>
        wanted.has(p.mail) ||
        wanted.has(upnOf(p).toLowerCase()) ||
        (p.otherMails ?? []).some((m) => wanted.has(m)),
    );
    return ok({ value: hit.map(userObject) });
  }
  const user = /^\/v1\.0\/users\/([^/]+)$/.exec(path);
  if (user) {
    const p = PEOPLE.find((x) => x.id === decodeURIComponent(user[1] as string).toLowerCase());
    return p ? ok(userObject(p)) : notFound();
  }
  return notFound();
}

// ---- Azure Resource Manager and Log Analytics ----

const RESOURCE_ID =
  "/subscriptions/00000000-0000-4000-8000-000000000000/resourceGroups/contoso-adme-rg" +
  "/providers/Microsoft.OpenEnergyPlatform/energyServices/contoso-adme";

function arm(method: string, url: URL): Reply {
  if (method === "POST" && url.pathname === "/providers/Microsoft.ResourceGraph/resources") {
    return ok({ data: [{ id: RESOURCE_ID }] });
  }
  if (url.pathname.endsWith("/availabilityStatuses/current")) {
    return ok({
      properties: {
        availabilityState: "Available",
        summary: "This resource is available.",
        occurredTime: AZURE_SINCE,
      },
    });
  }
  return notFound();
}

function logs(): Reply {
  const rows = AUDIT.map((c) => [idOf(c.who), c.day, c.calls]);
  return ok({
    tables: [
      {
        name: "PrimaryResult",
        columns: [
          { name: "id", type: "string" },
          { name: "day", type: "string" },
          { name: "calls", type: "long" },
        ],
        rows,
      },
    ],
  });
}

// ---- Search and storage ----

type Pred = (c: RecordClass) => boolean;

const FIELDS: Record<string, (c: RecordClass) => string[]> = {
  kind: (c) => [c.kind],
  "legal.legaltags": (c) => [c.tag],
  "acl.viewers": (c) => c.viewers,
  "acl.owners": (c) => c.owners,
};

function glob(pattern: string): RegExp {
  const esc = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${esc}$`, "i");
}

export function kindMatches(pattern: string, kind: string): boolean {
  const want = pattern.split(":");
  const have = kind.split(":");
  return want.length === have.length && want.every((w, i) => glob(w).test(have[i] as string));
}

// A small Lucene subset: field:"value", field:(a OR b), AND, OR, parentheses and *.
// A clause on any other field matches nothing.
export function parseQuery(query: string): Pred {
  const tokens = query.match(/"(?:[^"\\]|\\.)*"|\(|\)|[^\s()]+/g) ?? [];
  let i = 0;
  const peek = () => tokens[i];
  const unquote = (t: string) => (t.startsWith('"') ? t.slice(1, -1).replace(/\\(.)/g, "$1") : t);

  function values(): string[] {
    if (peek() !== "(") return [unquote(tokens[i++] ?? "")];
    i++;
    const out: string[] = [];
    while (i < tokens.length && peek() !== ")") {
      const t = tokens[i++] as string;
      if (t !== "OR") out.push(unquote(t));
    }
    i++;
    return out;
  }

  function term(): Pred {
    const t = peek();
    if (t === "(") {
      i++;
      const inner = or();
      i++;
      return inner;
    }
    i++;
    if (t === "*" || t === undefined) return () => true;
    const colon = t.indexOf(":");
    if (colon < 0) return () => false;
    const field = t.slice(0, colon);
    const rest = t.slice(colon + 1);
    const wanted = rest ? [unquote(rest)] : values();
    const read = FIELDS[field];
    if (!read) return () => false;
    const tests = wanted.map(glob);
    return (c) => read(c).some((v) => tests.some((re) => re.test(v)));
  }

  function and(): Pred {
    let left = term();
    while (peek() === "AND") {
      i++;
      const l = left;
      const r = term();
      left = (c) => l(c) && r(c);
    }
    return left;
  }

  function or(): Pred {
    let left = and();
    while (peek() === "OR") {
      i++;
      const l = left;
      const r = and();
      left = (c) => l(c) || r(c);
    }
    return left;
  }

  return or();
}

const WELLS = [
  "15/9-F-1",
  "15/9-F-1 A",
  "15/9-F-4",
  "15/9-F-5",
  "15/9-F-11",
  "15/9-F-11 T2",
  "15/9-F-12",
  "15/9-F-14",
  "15/9-F-15 D",
  "15/9-19 A",
  "15/9-19 BT2",
  "ADR-01",
  "AMR-01",
  "BLT-01",
  "KDZ-02",
  "NLW-GT-01",
  "VRS-01",
  "ZWO-01",
];
const CURVES = ["GR", "RHOB", "NPHI", "DT", "RT", "CALI", "PEF", "SP"];

function typeOf(kind: string): string {
  return kind.split(":")[2] ?? kind;
}

function nameOf(kind: string, n: number): { FacilityName?: string; Name?: string } {
  const type = typeOf(kind);
  const well = WELLS[n % WELLS.length] as string;
  const lap = Math.floor(n / WELLS.length);
  const tag = lap > 0 ? ` (${lap + 1})` : "";
  if (type === "master-data--Well") return { FacilityName: `${well}${tag}` };
  if (type === "master-data--Wellbore") return { FacilityName: `${well} wellbore${tag}` };
  if (type === "work-product-component--WellLog") {
    return { Name: `${well} ${CURVES[n % CURVES.length]}${tag}` };
  }
  if (type === "work-product-component--SeismicTraceData") {
    return { Name: `ST${10010 + (n % 40)} PSDM full stack` };
  }
  const short = type.replace(/^[a-z-]+--/, "");
  return { Name: `${short} ${n + 1}` };
}

const recordCache = new Map<string, unknown>();

function recordOf(classIndex: number, n: number) {
  const c = RECORD_CLASSES[classIndex] as RecordClass;
  const serial = (1_000 + classIndex) * 1_000_000 + n;
  const id = `${SAMPLE_PROFILE.partition}:${typeOf(c.kind)}:${serial}`;
  const tag = TAGS.find((t) => t.name === c.tag);
  const day = 1 + ((classIndex * 7 + n) % 28);
  const created = `2026-09-${String(day).padStart(2, "0")}T0${n % 10}:12:00.000Z`;
  const record = {
    id,
    kind: c.kind,
    version: Date.parse(created) * 1_000 + n,
    acl: { viewers: c.viewers, owners: c.owners },
    legal: {
      legaltags: [c.tag],
      otherRelevantDataCountries: tag?.countries ?? [],
      status: "compliant",
    },
    createTime: created,
    createUser: SAMPLE_PROFILE.admeAppId,
    modifyTime: created,
    modifyUser: SAMPLE_PROFILE.admeAppId,
    ancestry: { parents: [] },
    data: nameOf(c.kind, n),
  };
  recordCache.set(id, record);
  return record;
}

interface SearchBody {
  kind?: string;
  query?: string;
  limit?: number;
  offset?: number;
  aggregateBy?: string;
}

function search(body: SearchBody): Reply {
  const query = body.query?.trim() || "*";
  const idClause = /^id:"([^"]+)"$/.exec(query);
  if (idClause) {
    const hit = recordCache.get(idClause[1] as string);
    return ok({ results: hit ? [hit] : [], totalCount: hit ? 1 : 0, aggregations: [] });
  }
  const pred = parseQuery(query);
  const kind = body.kind ?? "*:*:*:*";
  const matched: number[] = [];
  RECORD_CLASSES.forEach((c, i) => {
    if (kindMatches(kind, c.kind) && pred(c)) matched.push(i);
  });
  const total = matched.reduce((n, i) => n + (RECORD_CLASSES[i] as RecordClass).count, 0);
  const results: unknown[] = [];
  let skip = body.offset ?? 0;
  const limit = Math.min(body.limit ?? 10, 1_000);
  for (const i of matched) {
    if (results.length >= limit) break;
    const count = (RECORD_CLASSES[i] as RecordClass).count;
    if (skip >= count) {
      skip -= count;
      continue;
    }
    for (let n = skip; n < count && results.length < limit; n++) results.push(recordOf(i, n));
    skip = 0;
  }
  const field = body.aggregateBy ? FIELDS[body.aggregateBy] : undefined;
  let aggregations: { key: string; count: number }[] | undefined;
  if (field) {
    const buckets = new Map<string, number>();
    for (const i of matched) {
      const c = RECORD_CLASSES[i] as RecordClass;
      for (const key of new Set(field(c))) buckets.set(key, (buckets.get(key) ?? 0) + c.count);
    }
    aggregations = [...buckets].map(([key, count]) => ({ key, count }));
  }
  return ok({ results, totalCount: total, ...(aggregations ? { aggregations } : {}) });
}

function storage(method: string, path: string): Reply {
  if (method !== "GET") return { status: 403, body: { message: READ_ONLY } };
  const m = /^\/records\/([^/]+)$/.exec(path);
  const hit = m ? recordCache.get(decodeURIComponent(m[1] as string)) : undefined;
  return hit ? ok(hit) : notFound("Record not found");
}

// ---- Legal and seismic ----

function legal(path: string, url: URL): Reply {
  if (path !== "/legaltags") return notFound();
  const valid = url.searchParams.get("valid") !== "false";
  return ok({
    legalTags: TAGS.filter((t) => t.valid === valid).map((t) => ({
      name: t.name,
      description: t.description,
      properties: {
        countryOfOrigin: t.countries,
        contractId: "No Contract Related",
        expirationDate: t.expires,
        originator: "Contoso",
        dataType: t.dataType,
        securityClassification: t.classification,
        personalData: "No Personal Data",
        exportClassification: "EAR99",
      },
    })),
  });
}

function subprojects(): unknown[] {
  return SUBPROJECTS.map((s) => ({
    name: s.name,
    tenant: SAMPLE_PROFILE.partition,
    ltag: s.ltag,
    acls: { admins: [aclOf(s, "admin")], viewers: [aclOf(s, "viewer")] },
    access_policy: s.policy,
    enforce_key: true,
    gcs_bucket: `ss-${guid(`bucket:${s.name}`).slice(0, 8)}`,
  }));
}

// ---- Routing ----

const PROBES: Partial<Record<Service, string>> = {
  seismic: "/svcstatus",
  wellbore: "/ddms/v2/about",
};

function adme(method: string, url: URL, body: unknown): Reply {
  const entry = (Object.entries(SERVICE_PATHS) as [Service, string][])
    .filter(([, base]) => url.pathname.startsWith(base))
    .sort((a, b) => b[1].length - a[1].length)[0];
  if (!entry) return notFound();
  const [service, base] = entry;
  const path = url.pathname.slice(base.length);
  const svc = SERVICES[service];
  if (svc?.off) return notFound();
  if (path === "/info" || path === PROBES[service]) {
    if (svc?.status) return { status: svc.status, body: { message: "Forbidden" } };
    return ok(svc?.version ? { version: svc.version, groupId: "org.opengroup.osdu" } : "running");
  }
  switch (service) {
    case "entitlements":
      return entitlements(method, path);
    case "search":
      return method === "POST" && path === "/query" ? search(body as SearchBody) : notFound();
    case "storage":
      return storage(method, path);
    case "legal":
      return legal(path, url);
    case "seismic":
      return path === `/subproject/tenant/${SAMPLE_PROFILE.partition}`
        ? ok(subprojects())
        : notFound();
    case "partition":
      return { status: 403, body: { message: "Forbidden" } };
    default:
      return notFound();
  }
}

function route(method: string, url: URL, body: unknown): Reply {
  if (url.host === SAMPLE_PROFILE.host) return adme(method, url, body);
  if (url.host === "graph.microsoft.com") return graph(method, url, body);
  if (url.host === "management.azure.com") return arm(method, url);
  if (url.host === "api.loganalytics.io") return logs();
  return notFound();
}

export const sampleTransport: Transport = async (req) => {
  const body = req.body === undefined ? undefined : JSON.parse(req.body);
  const reply = route(req.method, new URL(req.url), body);
  return {
    status: reply.status,
    body:
      reply.body === undefined
        ? ""
        : typeof reply.body === "string"
          ? reply.body
          : JSON.stringify(reply.body),
  };
};
