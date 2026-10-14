// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { Identity } from "../access/model.ts";
import { groupCount } from "../access/model.ts";
import { ANNOTATION_KIND_LABEL } from "../directory/annotations.ts";
import { type Resolved, searchText } from "../directory/index.ts";
import { shortId } from "../profile.ts";
import { configuredOf, observedOf, onboardingOf } from "../status/index.ts";
import { type BriefInputs, type Fact, observedFact, reachText, type Tone, whoId } from "./index.ts";
import { dayText, listOf } from "./words.ts";

export type PersonGroup = "people" | "apps" | "actors";

export interface Chip {
  text: string;
  tone: Tone;
}

export interface PersonRow {
  id: string;
  inspect: string;
  group: PersonGroup;
  name: string;
  keys: string;
  note?: string;
  chips: Chip[];
  org: string;
  search: string;
  heading: string;
  question: string;
  ladder: Fact[];
  known: Fact[];
  groups?: string;
}

function noteOf(r: Resolved, now: Date): string | undefined {
  const a = r.annotation;
  if (!a) return undefined;
  const parts: string[] = [];
  if (a.kind && r.nameSource === "label") parts.push(ANNOTATION_KIND_LABEL[a.kind]);
  if (a.responsibility) parts.push(a.responsibility);
  if (r.former.length > 0) parts.push(`formerly ${r.former[0]}`);
  if (a.note) parts.push(a.note);
  if (parts.length === 0 && a.organization) parts.push(a.organization);
  const source = `${a.source.from === "handbook" ? "handbook" : "operator note"} ${dayText(a.source.at, now)}`;
  return parts.length > 0 ? `${parts.join(" · ")} · ${source}` : undefined;
}

function keysOf(p: Identity, r: Resolved): string {
  if (p.kind === "app")
    return `app ${shortId(p.appId ?? p.id)}${p.root ? " · the instance's own app" : ""}`;
  if (p.kind === "unknown")
    return `${shortId(p.id)} · ${p.deleted ? "deleted in Entra" : "not in Entra"}`;
  return [r.email ?? p.email, shortId(p.id)].filter(Boolean).join(" · ");
}

function chipsOf(i: BriefInputs, p: Identity, r: Resolved): Chip[] {
  const out: Chip[] = [];
  const c = configuredOf(p);
  const o = onboardingOf(p, i.now);
  if (p.kind === "unknown") {
    out.push(
      r.nameSource === "label"
        ? { text: "labelled", tone: r.historical && p.role ? "warn" : "neutral" }
        : { text: "unresolved", tone: p.role ? "warn" : "neutral" },
    );
  } else if (c.state === "none") {
    out.push({
      text: "no instance access",
      tone: i.seismic?.grants[p.id]?.length ? "warn" : "neutral",
    });
  } else if (c.state === "blocked") {
    out.push({ text: "blocked", tone: "bad" });
  } else if (c.state === "inconsistent") {
    out.push({ text: c.reason === "duplicate" ? "listed twice" : "no role", tone: "warn" });
  } else if (o.state === "invited") {
    out.push({ text: o.days !== undefined ? `invited ${o.days} d` : "invited", tone: "neutral" });
  } else if (p.root) {
    out.push({ text: "legacy", tone: "neutral" });
  } else {
    out.push({ text: "ready", tone: "ok" });
  }
  out.push({ text: p.role ?? "no role", tone: "neutral" });
  return out;
}

function sharedSubprojects(i: BriefInputs): string[] {
  return (i.seismic?.subprojects ?? []).filter((s) => s.acl === "default").map((s) => s.name);
}

function ladderOf(i: BriefInputs, p: Identity): Fact[] {
  const out: Fact[] = [];
  const o = onboardingOf(p, i.now);
  const c = configuredOf(p);
  if (p.kind === "person") {
    out.push(
      o.state === "invited"
        ? {
            label: "Invitation",
            value: o.since ? `pending since ${dayText(o.since, i.now)}` : "pending",
            source: "directory",
            tone: "warn",
          }
        : o.state === "accepted"
          ? {
              label: "Invitation",
              value: o.at ? `accepted ${dayText(o.at, i.now)}` : "accepted",
              source: "directory",
              tone: "ok",
            }
          : {
              label: "Directory account",
              value: "member account",
              source: "directory",
              tone: "ok",
            },
    );
  } else if (p.kind === "unknown") {
    out.push({
      label: "Directory account",
      value: p.deleted ? "deleted" : "not in Entra",
      source: "directory",
      tone: p.role ? "warn" : "neutral",
    });
  } else {
    out.push({ label: "Application", value: "in Entra", source: "directory", tone: "ok" });
  }
  out.push({
    label: "Instance membership",
    value: p.memberships.users ? "users@" : "missing users@",
    source: "instance",
    tone: p.memberships.users ? "ok" : p.role ? "bad" : "neutral",
  });
  out.push({
    label: "Data role",
    value:
      c.state === "inconsistent" && c.reason === "duplicate"
        ? `${p.role}, listed twice`
        : (p.role ?? "none"),
    source: "instance",
    tone: p.role ? (c.state === "inconsistent" ? "warn" : "ok") : "warn",
  });
  if (i.seismic) {
    const grants = i.seismic.grants[p.id];
    out.push({
      label: "Named seismic reach",
      value: reachText(grants),
      source: "instance",
      tone: "neutral",
    });
    const shared = sharedSubprojects(i);
    if (p.role && shared.length > 0) {
      out.push({
        label: "Shared subprojects",
        value: `${listOf(shared)} by default`,
        source: "instance",
        tone: "neutral",
      });
    }
  } else {
    out.push({
      label: "Named seismic reach",
      value: "not read yet",
      source: "instance",
      tone: "neutral",
    });
  }
  if (p.kind === "person") {
    const a = i.access;
    const activity = a?.activity.kind === "measured" ? a.activity.model : undefined;
    out.push(observedFact(observedOf(p, activity, a?.usage.get(p.id), "not measured"), i.now));
  }
  return out;
}

function knownOf(i: BriefInputs, p: Identity, r: Resolved): Fact[] {
  const out: Fact[] = [];
  const add = (label: string, value: string | undefined, source: Fact["source"]) => {
    if (value) out.push({ label, value, source, tone: "neutral" });
  };
  if (p.kind === "app") add("App id", p.appId ?? p.id, "instance");
  else add("Object id", p.id, p.kind === "unknown" ? "instance" : "directory");
  add("Mail", r.email, "directory");
  const others = r.addresses.filter((x) => x !== r.email?.toLowerCase() && !x.includes("#ext#"));
  if (others.length > 0) add("Other mails", others.join(", "), "directory");
  if (r.former.length > 0) add("Former address", r.former.join(", "), "operator");
  if (r.nameSource === "label") add("Label", r.name, "operator");
  if (r.annotation?.kind) add("Kind", ANNOTATION_KIND_LABEL[r.annotation.kind], "operator");
  add(
    "Organization",
    r.org.name && r.org.from !== "none" ? r.org.name : undefined,
    r.org.from === "annotation" ? "operator" : "directory",
  );
  add("Responsibility", r.annotation?.responsibility, "operator");
  add("Note", r.annotation?.note, "operator");
  if (p.cohort && i.access) add("Cohort", p.cohort, "operator");
  return out;
}

function groupsLine(i: BriefInputs, p: Identity): string | undefined {
  const closures = i.accessRead?.closures;
  const count = groupCount(p.memberships, closures);
  if (!count) return undefined;
  const role = p.role ?? "no role";
  return count.held === count.expected
    ? `${count.held} effective groups, as expected for ${role}`
    : `${count.held} of ${count.expected} expected groups for ${role}`;
}

function rowOf(i: BriefInputs, p: Identity): PersonRow {
  const r = i.directory.resolve(p.id);
  const group: PersonGroup = p.kind === "app" ? "apps" : p.kind === "unknown" ? "actors" : "people";
  const org = r.org.from !== "none" ? r.org.name : "";
  const kindWord = p.kind === "app" ? "Application" : p.kind === "unknown" ? "Identity" : "Person";
  const note = noteOf(r, i.now);
  const groups = groupsLine(i, p);
  return {
    id: p.id,
    inspect: whoId(p.id),
    group,
    name: p.you ? `${p.name} (you)` : p.name,
    keys: keysOf(p, r),
    ...(note ? { note } : {}),
    chips: chipsOf(i, p, r),
    org,
    search: searchText(r),
    heading: org ? `${kindWord} · ${org}` : kindWord,
    question:
      p.kind === "app"
        ? "Can this application call?"
        : p.kind === "unknown"
          ? "What can this id reach?"
          : "Can this person get started?",
    ladder: ladderOf(i, p),
    known: knownOf(i, p, r),
    ...(groups ? { groups } : {}),
  };
}

// Someone a seismic group lists who holds no entitlements group at all.
function outsider(i: BriefInputs, id: string, kind: "person" | "app", name: string): Identity {
  const entry = i.directory.entry(id);
  const email = entry?.mail ?? entry?.upn;
  return {
    id,
    kind,
    name,
    ...(email ? { email } : {}),
    memberships: {},
    state: entry?.inviteState === "PendingAcceptance" ? "pending" : "healthy",
    guest: entry?.guest ?? false,
    ...(entry?.inviteState === "Accepted" && entry.inviteChangedAt
      ? { acceptedAt: entry.inviteChangedAt }
      : {}),
    ...(entry?.inviteState === "PendingAcceptance" && entry.inviteChangedAt
      ? { invitedAt: entry.inviteChangedAt }
      : {}),
    you: false,
    root: false,
  };
}

const GROUP_RANK: Record<PersonGroup, number> = { people: 0, apps: 1, actors: 2 };

// Every identity the instance lists, people first, then applications, then ids
// Entra cannot name; each with its keys, its axis chips and its profile.
export function peopleRows(i: BriefInputs): PersonRow[] {
  const a = i.access;
  if (!a) return [];
  const all = [...a.model.people, ...a.model.apps, ...a.model.unknown];
  const listed = new Set(all.map((p) => p.id));
  for (const [id, grants] of Object.entries(i.seismic?.grants ?? {})) {
    const m = i.seismic?.members[id];
    if (listed.has(id) || !m || grants.length === 0) continue;
    if (m.kind === "group" || m.kind === "unknown") continue;
    all.push(outsider(i, id, m.kind, m.name));
  }
  return all
    .map((p) => rowOf(i, p))
    .sort((x, y) => GROUP_RANK[x.group] - GROUP_RANK[y.group] || x.name.localeCompare(y.name));
}
