// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { ACTIVE_DAYS } from "../access/activity.ts";
import type { Measured } from "../access/measured.ts";
import type { Identity, Role } from "../access/model.ts";
import type { AccessRead } from "../access/read.ts";
import type { ConnectionStatus } from "../connection.ts";
import type { KindCounts, LegalTags } from "../data/areas.ts";
import { daysUntil, EXPIRY_WINDOW_DAYS } from "../data/legal.ts";
import type { Bucket } from "../data/map.ts";
import type { Directory } from "../directory/index.ts";
import { shortId } from "../profile.ts";
import type { Grant, SeismicModel } from "../seismic/model.ts";
import {
  type Configured,
  configuredOf,
  type Observed,
  observedOf,
  onboardingOf,
  type ReadSignal,
  readTrouble,
} from "../status/index.ts";
import {
  ageText,
  daysText,
  dayText,
  fmt,
  limitText,
  listOf,
  opening,
  plural,
  stampText,
} from "./words.ts";

export const ITEM_CLASSES = [
  "BLOCKED",
  "INCONSISTENT",
  "IDENTITY",
  "GRANT",
  "LEGAL",
  "READ",
] as const;
export type ItemClass = (typeof ITEM_CLASSES)[number];

// Where a fact comes from; the console colours each source the same way everywhere.
export type Source = "directory" | "instance" | "audit" | "operator";
export type Tone = "bad" | "warn" | "ok" | "neutral";

export interface Fact {
  label: string;
  value: string;
  source: Source;
  tone: Tone;
}

export interface Item {
  id: string;
  cls: ItemClass;
  title: string;
  sub: string;
  facts: Fact[];
  next: string;
  // What the claim rests on, in words: "configured: users@ and 4 role groups, read 14:05Z".
  scope?: string;
  // The inspector id the item opens beside its own.
  subject?: string;
  // Oldest first within a class.
  at?: string;
}

export interface Onboarding {
  count: number;
  text: string;
  tone: Tone;
  people: { id: string; name: string; days?: number }[];
}

export interface StampNote {
  text: string;
  inspect: string;
}

export type Phase = ConnectionStatus["phase"];

export interface BriefInputs {
  now: Date;
  phase: Phase;
  sample: boolean;
  instance?: { name: string; partition: string };
  operator?: { name: string; role?: string };
  directory: Directory;
  access?: Measured;
  accessRead?: AccessRead;
  seismic?: SeismicModel;
  legal?: LegalTags;
  // Records per legal tag from search; null when search refused the count.
  tagCounts?: Bucket[] | null;
  kinds?: KindCounts;
  // The instance's health in a few words, when something is not answering.
  health?: { text: string; tone: "ok" | "caution" | "error" | "neutral" };
  signals: ReadSignal[];
}

export interface Brief {
  state: "unconnected" | "signin" | "unmeasured" | "measured";
  instance?: string;
  operator?: string;
  sweptAt?: string;
  headline: string;
  summary: string;
  items: Item[];
  onboarding?: Onboarding;
  adoption?: string;
  stamp: { text?: string; notes: StampNote[] };
  reads: ReadSignal[];
}

const CLASS_RANK = new Map(ITEM_CLASSES.map((c, i) => [c, i]));
const INVITE_WARN_DAYS = 14;

export function itemId(cls: ItemClass, key: string): string {
  return `item:${cls.toLowerCase()}:${key}`;
}

export function whoId(id: string): string {
  return `who:${id}`;
}

export function readId(area: string): string {
  return `read:${area}`;
}

export function tagId(name: string): string {
  return `tag:${name}`;
}

export function cellId(id: string, subproject: string): string {
  return `cell:${id}:${subproject}`;
}

function roleWord(role: Role | undefined): string {
  return role ?? "no";
}

// "Viewer on alpha and delta"; "Admin on bravo, Viewer on alpha".
export function reachText(grants: readonly Grant[] | undefined): string {
  if (!grants || grants.length === 0) return "none";
  const by = (r: Grant["role"]) =>
    grants
      .filter((g) => g.role === r)
      .map((g) => g.subproject)
      .sort();
  const parts: string[] = [];
  const admin = by("admin");
  const viewer = by("viewer");
  if (admin.length > 0) parts.push(`Admin on ${listOf(admin)}`);
  if (viewer.length > 0) parts.push(`Viewer on ${listOf(viewer)}`);
  return parts.join(", ");
}

function invitationFact(p: Identity, now: Date): Fact {
  const o = onboardingOf(p, now);
  if (o.state === "invited") {
    return {
      label: "Invitation",
      value: o.since ? `pending since ${dayText(o.since, now)}` : "pending",
      source: "directory",
      tone: "warn",
    };
  }
  if (o.state === "accepted") {
    return {
      label: "Invitation",
      value: o.at ? `accepted ${dayText(o.at, now)}` : "accepted",
      source: "directory",
      tone: "neutral",
    };
  }
  return {
    label: "Directory account",
    value: "member account",
    source: "directory",
    tone: "neutral",
  };
}

export function observedFact(o: Observed, now: Date): Fact {
  switch (o.state) {
    case "active":
      return {
        label: "Observed use",
        value: `data calls, last ${dayText(o.last, now)}`,
        source: "audit",
        tone: "ok",
      };
    case "idle":
      return {
        label: "Observed use",
        value: `idle, last call ${dayText(o.last, now)}`,
        source: "audit",
        tone: "neutral",
      };
    case "no-call":
      return {
        label: "Observed use",
        value: o.since ? `no call since ${dayText(o.since, now)}` : "no call yet",
        source: "audit",
        tone: "neutral",
      };
    case "unmeasured":
      return { label: "Observed use", value: "not measured", source: "audit", tone: "neutral" };
  }
}

function observedFor(i: BriefInputs, p: Identity): Observed {
  const a = i.access;
  const activity = a?.activity.kind === "measured" ? a.activity.model : undefined;
  const reason =
    a?.activity.kind === "unset"
      ? "no audit log workspace"
      : a?.activity.kind === "unread"
        ? (a.activity.error ?? "the audit log is not read")
        : "";
  return observedOf(p, activity, a?.usage.get(p.id), reason);
}

function readClock(i: BriefInputs, area: string): string | undefined {
  const s = i.signals.find((x) => x.area === area);
  return stampText(s?.at, i.now);
}

function roleCount(p: Identity): number {
  return (["ops", "admins", "editors", "viewers"] as const).filter((k) => p.memberships[k]).length;
}

function blockedItems(i: BriefInputs): Item[] {
  const a = i.access;
  if (!a) return [];
  const out: Item[] = [];
  const read = readClock(i, "access");
  for (const p of a.model.people) {
    const c = configuredOf(p);
    if (c.state !== "blocked" || c.reason !== "no-users") continue;
    const reach = reachText(i.seismic?.grants[p.id]);
    out.push({
      id: itemId("BLOCKED", p.id),
      cls: "BLOCKED",
      title: `${p.name} cannot use the instance`,
      sub: `${roleWord(p.role)} role configured; users@ membership missing`,
      facts: [
        invitationFact(p, i.now),
        { label: "users@ membership", value: "missing", source: "instance", tone: "bad" },
        {
          label: "Data role",
          value: `${roleWord(p.role)} configured`,
          source: "instance",
          tone: "neutral",
        },
        ...(i.seismic
          ? [
              {
                label: "Named seismic reach",
                value: reach,
                source: "instance" as const,
                tone: "neutral" as const,
              },
            ]
          : []),
        observedFact(observedFor(i, p), i.now),
      ],
      next: `Add ${p.name} to users@. Every call returns 401 until then, and seismic grants do not help before it.`,
      scope: `configured: ${plural(roleCount(p), "role group", "role groups")}, no users@${read ? `, read ${read}` : ""} · no participant session is claimed`,
      subject: whoId(p.id),
      ...(p.acceptedAt || p.createdAt ? { at: p.acceptedAt ?? p.createdAt } : {}),
    });
  }
  for (const u of a.model.unknown) {
    if (!u.deleted || !u.role) continue;
    out.push({
      id: itemId("BLOCKED", u.id),
      cls: "BLOCKED",
      title: `A deleted account still holds ${u.role}`,
      sub: `${u.label ?? shortId(u.id)} · Entra holds the account as deleted`,
      facts: [
        { label: "Directory account", value: "deleted", source: "directory", tone: "bad" },
        { label: "Data role", value: `${u.role} configured`, source: "instance", tone: "neutral" },
      ],
      next: "Remove the id from its role groups; a deleted account cannot sign in.",
      subject: whoId(u.id),
    });
  }
  return out;
}

const GROUP_ROLE: Record<string, string> = {
  users: "users@",
  viewers: "Viewer",
  editors: "Editor",
  admins: "Admin",
  ops: "Ops",
};

function inconsistentItems(i: BriefInputs): Item[] {
  const a = i.access;
  if (!a) return [];
  const out: Item[] = [];
  for (const p of a.model.people) {
    const c = configuredOf(p);
    if (c.state !== "inconsistent") continue;
    const observed = observedFact(observedFor(i, p), i.now);
    if (c.reason === "duplicate") {
      const group = GROUP_ROLE[p.duplicateIn ?? ""] ?? "role";
      out.push({
        id: itemId("INCONSISTENT", p.id),
        cls: "INCONSISTENT",
        title: `${p.name} is listed twice in the ${group} group`,
        sub: "by object id and by email",
        facts: [
          {
            label: `${group} group, by object id`,
            value: "member",
            source: "instance",
            tone: "neutral",
          },
          {
            label: `${group} group, by email`,
            value: "also member",
            source: "instance",
            tone: "warn",
          },
          observed,
        ],
        next: "Remove the email entry. Access works today; the second entry stops matching if the address changes.",
        subject: whoId(p.id),
      });
      continue;
    }
    out.push({
      id: itemId("INCONSISTENT", p.id),
      cls: "INCONSISTENT",
      title: `${p.name} holds users@ with no role`,
      sub: "users@ membership configured; no role group",
      facts: [
        invitationFact(p, i.now),
        { label: "users@ membership", value: "member", source: "instance", tone: "neutral" },
        { label: "Data role", value: "none", source: "instance", tone: "warn" },
        observed,
      ],
      next: "Add a role group if the access is still needed, or remove users@.",
      subject: whoId(p.id),
    });
  }
  return out;
}

function identityItems(i: BriefInputs): Item[] {
  const out: Item[] = [];
  const unknown = i.access?.model.unknown ?? [];
  const seen = new Set<string>();
  for (const u of unknown) {
    if (u.deleted && u.role) continue;
    const r = i.directory.resolve(u.id);
    const grants = i.seismic?.grants[u.id];
    if (!u.role && !grants?.length) continue;
    seen.add(u.id);
    const holds = u.role ? u.role : "a seismic grant";
    if (r.nameSource === "label") {
      if (!r.historical || !u.role) continue;
      out.push({
        id: itemId("IDENTITY", u.id),
        cls: "IDENTITY",
        title: `${r.name} still holds ${u.role}`,
        sub: `historical actor · ${shortId(u.id)}`,
        facts: [
          { label: "Directory", value: "not in Entra", source: "directory", tone: "neutral" },
          {
            label: "Operator label",
            value: `${r.name}${r.annotation?.source ? `, ${r.annotation.source.from} ${dayText(r.annotation.source.at, i.now)}` : ""}`,
            source: "operator",
            tone: "neutral",
          },
          { label: "Data role", value: `${u.role} configured`, source: "instance", tone: "warn" },
        ],
        next: `Remove the role if this actor is retired; the label stays with the id.`,
        subject: whoId(u.id),
      });
      continue;
    }
    out.push({
      id: itemId("IDENTITY", u.id),
      cls: "IDENTITY",
      title: `An id holding ${holds} has no name`,
      sub: `${shortId(u.id)} · not in Entra, no operator label`,
      facts: [
        { label: "Directory", value: "not in Entra", source: "directory", tone: "warn" },
        { label: "Operator label", value: "none", source: "operator", tone: "warn" },
        ...(u.role
          ? [
              {
                label: "Data role",
                value: `${u.role} configured`,
                source: "instance" as const,
                tone: "neutral" as const,
              },
            ]
          : []),
        ...(grants?.length
          ? [
              {
                label: "Named seismic reach",
                value: reachText(grants),
                source: "instance" as const,
                tone: "neutral" as const,
              },
            ]
          : []),
      ],
      next: "Label it in the inspector if you know what it is, or remove its access.",
      subject: whoId(u.id),
    });
  }
  // Seismic members the directory cannot name and that hold no instance role.
  for (const [id, grants] of Object.entries(i.seismic?.grants ?? {})) {
    if (seen.has(id) || i.seismic?.members[id]?.kind !== "unknown") continue;
    if (!i.directory.unresolved(id)) continue;
    out.push({
      id: itemId("IDENTITY", id),
      cls: "IDENTITY",
      title: "An id holding a seismic grant has no name",
      sub: `${shortId(id)} · ${reachText(grants)}`,
      facts: [
        { label: "Directory", value: "not in Entra", source: "directory", tone: "warn" },
        { label: "Operator label", value: "none", source: "operator", tone: "warn" },
        {
          label: "Named seismic reach",
          value: reachText(grants),
          source: "instance",
          tone: "neutral",
        },
      ],
      next: "Label it in the inspector if you know what it is, or revoke the grant.",
      subject: whoId(id),
    });
  }
  return out;
}

function grantItems(i: BriefInputs): Item[] {
  const s = i.seismic;
  if (!s) return [];
  const listed = new Map<string, Identity>();
  for (const x of [...(i.access?.model.people ?? []), ...(i.access?.model.apps ?? [])]) {
    listed.set(x.id, x);
  }
  const out: Item[] = [];
  for (const [id, grants] of Object.entries(s.grants)) {
    const m = s.members[id];
    if (!m || m.kind === "unknown" || m.kind === "group" || grants.length === 0) continue;
    const c: Configured = i.access ? configuredOf(listed.get(id)) : { state: "unmeasured" };
    if (c.state !== "none") continue;
    const subs = [...new Set(grants.map((g) => g.subproject))].sort();
    const first = subs[0] as string;
    out.push({
      id: itemId("GRANT", id),
      cls: "GRANT",
      title:
        subs.length === 1
          ? `${m.name} keeps a ${first} grant without instance access`
          : `${m.name} keeps ${subs.length} seismic grants without instance access`,
      sub: `${reachText(grants)}; no role group, no users@`,
      facts: [
        {
          label: "Directory account",
          value: m.kind === "app" ? "application" : "present",
          source: "directory",
          tone: "neutral",
        },
        { label: "users@ and role group", value: "none", source: "instance", tone: "bad" },
        {
          label: "Named seismic reach",
          value: reachText(grants),
          source: "instance",
          tone: "warn",
        },
      ],
      next: "Revoke the grant, or restore instance access if it is still needed. The grant cannot be used without users@.",
      subject: cellId(id, first),
    });
  }
  return out;
}

export interface TagInUse {
  name: string;
  invalid: boolean;
  daysLeft?: number;
  expires?: string;
  // Subprojects with members or default reach that name the tag.
  subprojects: string[];
  // Indexed records carrying the tag; null when search refused the count.
  records: number | null;
}

export interface UnusedTag {
  name: string;
  // Subprojects that name the tag but have no members.
  empty: string[];
}

// Tags that records or reachable subprojects use and that are invalid or expire within
// the window. An invalid tag nothing uses is lower priority and never a decision.
export function tagsNeedingCare(i: BriefInputs): { care: TagInUse[]; unused: UnusedTag[] } {
  const legal = i.legal;
  if (!legal) return { care: [], unused: [] };
  const counts = i.tagCounts ? new Map(i.tagCounts.map((b) => [b.key, b.count])) : undefined;
  const usedBy = new Map<string, string[]>();
  const emptyBy = new Map<string, string[]>();
  for (const sub of i.seismic?.subprojects ?? []) {
    if (!sub.legalTag) continue;
    const map = sub.empty ? emptyBy : usedBy;
    map.set(sub.legalTag, [...(map.get(sub.legalTag) ?? []), sub.name]);
  }
  const care: TagInUse[] = [];
  const unused: UnusedTag[] = [];
  const consider = (name: string, invalid: boolean, expires: string | undefined) => {
    const records = counts ? (counts.get(name) ?? 0) : null;
    const subprojects = usedBy.get(name) ?? [];
    const days = daysUntil(expires, i.now);
    const soon = days !== undefined && days <= EXPIRY_WINDOW_DAYS;
    if (!invalid && !soon) return;
    const used = subprojects.length > 0 || (records ?? 0) > 0;
    // Without counts an unused tag cannot be told apart, so it stays a decision.
    if (!used && records !== null) {
      if (invalid) unused.push({ name, empty: emptyBy.get(name) ?? [] });
      return;
    }
    care.push({
      name,
      invalid,
      ...(days !== undefined ? { daysLeft: days } : {}),
      ...(expires ? { expires } : {}),
      subprojects,
      records,
    });
  };
  for (const t of legal.valid) consider(t.name, false, t.expirationDate);
  for (const t of legal.invalid) consider(t.name, true, t.expirationDate);
  care.sort(
    (a, b) =>
      Number(b.invalid) - Number(a.invalid) ||
      (a.daysLeft ?? 0) - (b.daysLeft ?? 0) ||
      a.name.localeCompare(b.name),
  );
  return { care, unused: unused.sort((a, b) => a.name.localeCompare(b.name)) };
}

export function tagUseText(t: TagInUse): string {
  const parts = [...t.subprojects];
  if (t.records === null) parts.push("records not counted");
  else if (t.records > 0) parts.push(plural(t.records, "indexed record", "indexed records"));
  return parts.length > 0 ? `in use on ${listOf(parts, 6)}` : "in use";
}

function legalItems(i: BriefInputs): Item[] {
  return tagsNeedingCare(i).care.map((t): Item => {
    const title = t.invalid
      ? `${t.name} is invalid and still in use`
      : t.daysLeft !== undefined && t.daysLeft <= 0
        ? `${t.name} expires today`
        : `${t.name} expires in ${plural(t.daysLeft ?? 0, "day", "days")}`;
    return {
      id: itemId("LEGAL", t.name),
      cls: "LEGAL",
      title,
      sub: tagUseText(t),
      facts: [
        {
          label: "Expires",
          value: t.expires
            ? `${dayText(t.expires, i.now)}${t.daysLeft !== undefined ? ` · ${t.daysLeft} d` : ""}`
            : "no date",
          source: "instance",
          tone: t.invalid ? "bad" : "warn",
        },
        ...(t.subprojects.length > 0
          ? [
              {
                label: "Seismic subprojects",
                value: listOf(t.subprojects, 6),
                source: "instance" as const,
                tone: "neutral" as const,
              },
            ]
          : []),
        {
          label: "Indexed records",
          value: t.records === null ? "not counted" : `${fmt(t.records)}, visible to this sign-in`,
          source: "instance",
          tone: "neutral",
        },
      ],
      next: t.invalid
        ? "Records under an invalid tag cannot be read. Renew the tag or move the records; the rib does not edit legal tags."
        : "Extend the tag or plan to move these records; the rib does not edit legal tags.",
      subject: tagId(t.name),
      ...(t.expires ? { at: t.expires } : {}),
    };
  });
}

function readItems(i: BriefInputs): Item[] {
  const out: Item[] = [];
  for (const s of i.signals) {
    const trouble = readTrouble(s);
    if (!trouble || trouble === "unread") continue;
    const age = s.ageMs !== undefined ? ageText(s.ageMs) : undefined;
    const title =
      trouble === "failed"
        ? `${s.label} could not be read`
        : trouble === "incomplete"
          ? `${s.label} were not all read`
          : `${s.label} were read ${age} ago`;
    const sub =
      trouble === "failed"
        ? (s.error ?? "the last read failed")
        : trouble === "incomplete"
          ? (s.completeness?.text ?? "some parts were not read")
          : `limit is ${limitText(s.limitMs)}; views show that read`;
    out.push({
      id: itemId("READ", s.area),
      cls: "READ",
      title,
      sub,
      facts: readFacts(s, i.now),
      next: `Re-read ${s.label.toLowerCase()}, ${s.cost}.${s.at ? " Views keep the last good read until then." : ""}`,
      subject: readId(s.area),
      ...(s.at ? { at: s.at } : {}),
    });
  }
  return out;
}

export function readFacts(s: ReadSignal, now: Date): Fact[] {
  return [
    {
      label: "Service",
      value:
        s.available === "up"
          ? "responding"
          : s.available === "down"
            ? "not responding"
            : "not probed",
      source: "instance",
      tone: s.available === "down" ? "bad" : "neutral",
    },
    ...(s.completeness?.text
      ? [
          {
            label: "Completeness",
            value: s.completeness.text,
            source: "instance" as const,
            tone: s.completeness.complete ? ("neutral" as const) : ("warn" as const),
          },
        ]
      : []),
    {
      label: "Read at",
      value: s.at
        ? `${stampText(s.at, now)}${s.ageMs !== undefined ? ` · ${ageText(s.ageMs)} ago` : ""}`
        : "never",
      source: "instance",
      tone: s.stale ? "warn" : "neutral",
    },
    ...(s.failed
      ? [
          {
            label: "Last error",
            value: `${s.error ?? "failed"}${s.errorAt ? ` · ${stampText(s.errorAt, now)}` : ""}`,
            source: "instance" as const,
            tone: "bad" as const,
          },
        ]
      : []),
  ];
}

export function decisionItems(i: BriefInputs): Item[] {
  const items = [
    ...blockedItems(i),
    ...inconsistentItems(i),
    ...identityItems(i),
    ...grantItems(i),
    ...legalItems(i),
    ...readItems(i),
  ];
  return items.sort(
    (a, b) =>
      (CLASS_RANK.get(a.cls) ?? 0) - (CLASS_RANK.get(b.cls) ?? 0) ||
      (a.at ?? "~").localeCompare(b.at ?? "~"),
  );
}

const CLASS_PLURAL: Record<ItemClass, (n: number) => string> = {
  BLOCKED: (n) => `${opening(n, "person", "people")} cannot use the instance as configured.`,
  INCONSISTENT: (n) => `${opening(n, "identity is", "identities are")} listed inconsistently.`,
  IDENTITY: (n) => `${opening(n, "id", "ids")} holding access have no name.`,
  GRANT: (n) =>
    `${opening(n, "seismic grant is", "seismic grants are")} held without instance access.`,
  LEGAL: (n) => `${opening(n, "legal tag", "legal tags")} in use need care.`,
  READ: (n) => `${opening(n, "read needs", "reads need")} a refresh.`,
};

function headlineOf(items: readonly Item[]): string {
  const top = items[0];
  if (!top) return "Nobody is blocked.";
  const same = items.filter((x) => x.cls === top.cls);
  if (same.length === 1) {
    return top.cls === "BLOCKED" ? `${top.title} as configured.` : `${top.title}.`;
  }
  return CLASS_PLURAL[top.cls](same.length);
}

// The next one or two things after the headline, each named once.
function summaryOf(
  items: readonly Item[],
  onboarding: Onboarding | undefined,
  reads: ReadSignal[],
): string {
  const top = items[0];
  if (!top) {
    const parts: string[] = [];
    const oldest = onboarding?.people[0];
    if (oldest) {
      parts.push(
        `The oldest pending invitation is ${oldest.name}'s${oldest.days !== undefined ? `, ${daysText(oldest.days)}` : ""}.`,
      );
    }
    const late = reads.find((s) => s.configured && s.stale);
    if (late?.ageMs !== undefined)
      parts.push(`${late.label} were read ${ageText(late.ageMs)} ago.`);
    return parts.join(" ");
  }
  const same = items.filter((x) => x.cls === top.cls);
  const sentences: string[] = [];
  if (same.length > 1) {
    sentences.push(
      `${listOf(
        same.map((x) => x.title),
        3,
      )}.`,
    );
  } else {
    sentences.push(`${top.sub.charAt(0).toUpperCase()}${top.sub.slice(1)}.`);
  }
  const others = ITEM_CLASSES.filter((c) => c !== top.cls)
    .map((c) => items.find((x) => x.cls === c))
    .filter((x): x is Item => x !== undefined)
    .slice(0, sentences.length > 1 ? 1 : 2);
  for (const o of others) sentences.push(`${o.title}.`);
  return sentences.join(" ");
}

function onboardingOfAll(i: BriefInputs): Onboarding | undefined {
  const a = i.access;
  if (!a) return undefined;
  const invited = a.model.people
    .map((p) => ({ p, o: onboardingOf(p, i.now) }))
    .filter((x) => x.o.state === "invited")
    .map(({ p, o }) => ({
      id: p.id,
      name: p.name,
      ...(o.state === "invited" && o.days !== undefined ? { days: o.days } : {}),
    }))
    .sort((x, y) => (y.days ?? 0) - (x.days ?? 0) || x.name.localeCompare(y.name));
  if (invited.length === 0)
    return { count: 0, text: "No invitation is pending.", tone: "neutral", people: [] };
  const byDays = new Map<string, string[]>();
  for (const x of invited) {
    const k = x.days === undefined ? "on an unknown day" : daysText(x.days);
    const list = byDays.get(k) ?? [];
    list.push(x.name);
    byDays.set(k, list);
  }
  const groups = [...byDays.entries()].map(
    ([when, names]) => `${listOf(names, 3)} invited ${when}`,
  );
  const none = invited.length === 1 ? "Not accepted yet." : "None has accepted.";
  const oldest = invited[0]?.days ?? 0;
  return {
    count: invited.length,
    text: `${groups.join(", ")}. ${none}`,
    tone: oldest > INVITE_WARN_DAYS ? "warn" : "neutral",
    people: invited,
  };
}

function adoptionOf(i: BriefInputs): string | undefined {
  const a = i.access;
  if (!a) return undefined;
  if (a.activity.kind === "unset")
    return "Observed use is not measured: no audit log workspace is set.";
  if (a.activity.kind === "unread") {
    return `Observed use is not measured: ${a.activity.error ?? "the audit log is not read yet"}.`;
  }
  const n = (u: string) => a.model.people.filter((p) => a.usage.get(p.id) === u).length;
  const since = a.activity.model.since;
  return `Audit log: ${fmt(n("active"))} active in ${ACTIVE_DAYS} days, ${fmt(n("idle"))} idle, ${fmt(n("not-used"))} with no call${since ? ` since ${dayText(since, i.now)}` : " yet"}. No call yet does not mean access is broken.`;
}

function stampOf(i: BriefInputs): Brief["stamp"] {
  const swept = i.signals
    .filter((s) => s.area === "access")
    .map((s) => stampText(s.at, i.now))
    .find(Boolean);
  const notes: StampNote[] = [];
  if (i.health && (i.health.tone === "caution" || i.health.tone === "error")) {
    notes.push({ text: i.health.text, inspect: "connection" });
  }
  for (const s of i.signals) {
    const t = readTrouble(s);
    if (!t) continue;
    const text =
      t === "failed"
        ? `${s.label.toLowerCase()} unread`
        : t === "unread"
          ? `${s.label.toLowerCase()} not read yet`
          : t === "incomplete"
            ? `${s.label.toLowerCase()} incomplete`
            : `${s.label.toLowerCase()} ${ageText(s.ageMs ?? 0)} old`;
    notes.push({ text, inspect: readId(s.area) });
  }
  return { ...(swept ? { text: `read ${swept}` } : {}), notes };
}

export function buildBrief(i: BriefInputs): Brief {
  const reads = i.signals;
  const base = {
    ...(i.instance
      ? { instance: `${i.sample ? "Sample " : ""}${i.instance.name} · ${i.instance.partition}` }
      : {}),
    ...(i.operator
      ? { operator: [i.operator.name, i.operator.role].filter(Boolean).join(" · ") }
      : {}),
    reads,
  };
  if (i.phase === "firstrun" || i.phase === "profile-error") {
    return {
      ...base,
      state: "unconnected",
      headline: i.phase === "firstrun" ? "Connect to an ADME instance." : "Check the connection.",
      summary: "Finish the connect steps above. Nothing is read until the connection works.",
      items: [],
      stamp: { notes: [] },
    };
  }
  if (!i.access) {
    return {
      ...base,
      state: i.phase === "signin" ? "signin" : "unmeasured",
      headline:
        i.phase === "signin" ? "Sign in again to read the instance." : "Reading the instance.",
      summary:
        i.phase === "signin"
          ? "Run az login in a terminal, then Re-test the connection."
          : "The first read of access is running.",
      items: [],
      stamp: stampOf(i),
    };
  }
  const items = decisionItems(i);
  const onboarding = onboardingOfAll(i);
  const adoption = adoptionOf(i);
  const sweptAt = reads.find((s) => s.area === "access")?.at;
  return {
    ...base,
    state: i.phase === "signin" ? "signin" : "measured",
    ...(sweptAt ? { sweptAt } : {}),
    headline: headlineOf(items),
    summary: summaryOf(items, onboarding, reads),
    items,
    ...(onboarding ? { onboarding } : {}),
    ...(adoption ? { adoption } : {}),
    stamp: stampOf(i),
  };
}
