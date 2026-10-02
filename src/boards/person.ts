// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { CanvasActionItem, CanvasBoardView } from "@keelson/shared";
import type { AccessModel, Identity } from "../access/model.ts";
import {
  auditGroups,
  type GroupAudit,
  personError,
  personRead,
  selectedId,
} from "../access/person.ts";
import {
  ACCESS_AREA,
  type AccessRead,
  type DirectoryEntry,
  GROUP_NAMES,
  type GroupKey,
} from "../access/read.ts";
import { bindingOf } from "../plan/model.ts";
import { shortId } from "../profile.ts";
import { EMPTY_BOARD } from "../resting.ts";
import type { Runtime } from "../runtime.ts";
import { clock } from "../sweep.ts";
import { UNTRACKED } from "../tracker.ts";
import { day, measuredAccess, passText } from "./access.ts";
import {
  EXPLAIN_ACTION,
  PREVIEW_CLEANUP_ACTION,
  PREVIEW_FIX_ACTION,
  PREVIEW_REMOVE_ACTION,
} from "./change.ts";
import { SIGNIN_REASON } from "./connection.ts";

type Section = CanvasBoardView["sections"][number];
type Leaf = Exclude<Section, { kind: "columns" }>;
type Card = Extract<Section, { kind: "cards" }>["items"][number];
type Field = NonNullable<Card["fields"]>[number];
type Row = Extract<Section, { kind: "rows" }>["items"][number];
type Cell = Extract<Section, { kind: "grid" }>["cells"][number];
type Tone = NonNullable<Row["glyph"]>;

export const REFRESH_PERSON_ACTION = "refresh-person";
export const ACCEPT_EXTRAS_ACTION = "accept-extra-groups";

const PLAIN_LIMIT = 13;
const ROLE_KEYS = ["ops", "admins", "editors", "viewers"] as const;

export function findIdentity(model: AccessModel, id: string): Identity | undefined {
  return [...model.people, ...model.apps].find((i) => i.id === id);
}

export function inspectorTitle(who: Identity): string {
  return `${who.kind === "app" ? "Application" : "Person"} · ${who.name}`;
}

export function shortGroup(email: string): string {
  const name = email.split("@")[0] || email;
  const sdms = /^data\.sdms\.[^.]+\.([^.]+)\.[0-9a-f-]+\.([a-z]+)$/.exec(name);
  if (sdms) return `sdms.${sdms[1]}.${sdms[2]}`;
  return name.replace(/^users\.datalake\./, "").replace(/^service\./, "");
}

interface Check {
  verdict: "pass" | "warn" | "fail";
  text: string;
  trailing?: string;
  // The header status and card pill when this is the worst check.
  status?: string;
  pill?: string;
}

const VERDICT_TONE = { pass: "ok", warn: "warn", fail: "error" } as const;

function addresses(entry: DirectoryEntry | undefined): string[] {
  return [entry?.mail, entry?.upn, ...(entry?.otherMails ?? [])]
    .filter((a): a is string => Boolean(a))
    .map((a) => a.toLowerCase());
}

function listing(
  read: AccessRead,
  who: Identity,
  entry: DirectoryEntry | undefined,
  key: GroupKey,
): { text: string; both: boolean } {
  const members = read.groups[key];
  const mails = addresses(entry);
  const byId = members.find((m) => m.id === who.id);
  const byMail = members.find((m) => mails.includes(m.id));
  const role = (byId ?? byMail)?.owner ? "OWNER" : "MEMBER";
  const idForm = who.kind === "app" && who.appId === who.id ? "by app id" : "by object id";
  const how = byId && byMail ? `${idForm} and by email` : byMail ? "by email" : idForm;
  return { text: `${role}, ${how}`, both: Boolean(byId && byMail) };
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function groupsCheck(who: Identity, audit: GroupAudit | undefined): Check {
  if (!audit) {
    return {
      verdict: "warn",
      text: "Effective groups",
      trailing: "expected set not read",
      status: "groups not checked",
      pill: "?",
    };
  }
  const notes = [
    `${audit.held.length} of ${audit.expected.length} expected for ${who.role ?? "no role"}`,
    ...(audit.extras.length > 0 ? [`${audit.extras.length} extra`] : []),
    ...(audit.baseline.length > 0 ? [`${audit.baseline.length} baseline`] : []),
  ];
  const ok = audit.gaps.length === 0 && audit.extras.length === 0;
  return {
    verdict: ok ? "pass" : "warn",
    text: "Effective groups",
    trailing: notes.join(" · "),
    ...(audit.gaps.length > 0
      ? {
          status: `${plural(audit.gaps.length, "expected group", "expected groups")} missing`,
          pill: "gap",
        }
      : audit.extras.length > 0
        ? { status: plural(audit.extras.length, "extra group", "extra groups"), pill: "extra" }
        : {}),
  };
}

function checks(
  rt: Runtime,
  read: AccessRead,
  who: Identity,
  entry: DirectoryEntry | undefined,
  audit: GroupAudit | undefined,
): Check[] {
  const out: Check[] = [];
  if (who.kind === "app") {
    out.push({ verdict: "pass", text: "Application exists in Entra" });
  } else {
    out.push(
      entry
        ? { verdict: "pass", text: "Entra account exists" }
        : {
            verdict: "fail",
            text: "Entra account exists",
            trailing: "not found",
            status: "not in Entra",
          },
    );
  }
  if (who.kind === "person" && who.guest) {
    if (entry?.inviteState === "Accepted") {
      out.push({
        verdict: "pass",
        text: "Invitation accepted",
        trailing: day(who.acceptedAt) ?? "",
      });
    } else {
      out.push({
        verdict: "warn",
        text: "Invitation accepted",
        trailing: who.invitedAt ? `pending since ${day(who.invitedAt)}` : "state not read",
        status: "invitation pending",
        pill: "pending",
      });
    }
  }
  const rosterId = rt.profile?.rosterGroupId;
  if (who.kind === "person" && rosterId && who.inRoster !== undefined) {
    const text = `In roster group ${shortId(rosterId)}`;
    out.push(
      who.inRoster
        ? { verdict: "pass", text }
        : {
            verdict: "warn",
            text,
            trailing: "not a member",
            status: "not in the roster group",
            pill: "roster",
          },
    );
  }
  const domain = rt.profile?.entitlementsDomain;
  const users = `Member of users@${domain ?? "?"}`;
  out.push(
    who.memberships.users
      ? { verdict: "pass", text: users, trailing: listing(read, who, entry, "users").text }
      : {
          verdict: "fail",
          text: users,
          trailing: "not a member",
          status: "401 on every call",
          pill: "401",
        },
  );
  const roles = ROLE_KEYS.filter((k) => who.memberships[k]);
  for (const key of roles) {
    const l = listing(read, who, entry, key);
    out.push(
      l.both
        ? {
            verdict: "warn",
            text: `Member of ${GROUP_NAMES[key]}`,
            trailing: l.text,
            status: "duplicate member entry",
            pill: "duplicate",
          }
        : { verdict: "pass", text: `Member of ${GROUP_NAMES[key]}`, trailing: l.text },
    );
  }
  if (roles.length === 0) {
    out.push({
      verdict: "warn",
      text: "Member of a role group",
      trailing: "no role group",
      status: "no role group",
      pill: "no role",
    });
  }
  out.push(groupsCheck(who, audit));
  return out;
}

function worst(list: Check[]): Check | undefined {
  return list.find((c) => c.verdict === "fail") ?? list.find((c) => c.verdict === "warn");
}

function identityFields(rt: Runtime, who: Identity, entry: DirectoryEntry | undefined): Field[] {
  if (who.kind === "app") {
    return [
      { label: "App id", value: who.appId ?? who.id, copyable: true },
      { label: "Kind", value: who.root ? "application, root app" : "application" },
    ];
  }
  const mail = entry?.mail ?? entry?.upn;
  const others = (entry?.otherMails ?? []).filter((m) => m.toLowerCase() !== mail?.toLowerCase());
  const entra: Field = !who.guest
    ? { label: "Entra state", value: "member account" }
    : entry?.inviteState === "Accepted"
      ? { label: "Entra state", value: `Accepted ${day(who.acceptedAt) ?? "?"}`, tone: "ok" }
      : entry?.inviteState === "PendingAcceptance"
        ? {
            label: "Entra state",
            value: `Pending since ${day(who.invitedAt) ?? "?"}`,
            tone: "warn",
          }
        : { label: "Entra state", value: "?" };
  const rosterId = rt.profile?.rosterGroupId;
  const roster: Field = !rosterId
    ? { label: "Roster group", value: "not set" }
    : who.inRoster === undefined
      ? { label: "Roster group", value: "not read" }
      : who.inRoster
        ? { label: "Roster group", value: `in ${shortId(rosterId)}` }
        : { label: "Roster group", value: `not in ${shortId(rosterId)}`, tone: "warn" };
  const unreadable = rt.tracker.unreadable;
  const cohort = rt.tracker.cohorts.find((c) => c.name === who.cohort);
  return [
    { label: "Object id", value: who.id, copyable: true },
    ...(mail ? [{ label: "Mail", value: mail, copyable: true }] : []),
    ...(others.length > 0
      ? [{ label: "Other mails", value: others.join(", "), copyable: true }]
      : []),
    { label: "Kind", value: who.guest ? "guest" : "member" },
    entra,
    { label: "Created", value: day(entry?.createdAt) ?? "?" },
    roster,
    { label: "Cohort", value: unreadable ? "?" : (who.cohort ?? UNTRACKED) },
    { label: "Pass ends", value: unreadable || !cohort ? "?" : passText(cohort, rt.now()) },
  ];
}

const PLAIN_RANK = (g: string) => (g.startsWith("users@") ? 0 : g.startsWith("users.") ? 1 : 2);

function groupGrid(audit: GroupAudit): Leaf {
  const flagged = new Set([...audit.gaps, ...audit.extras, ...audit.baseline]);
  const plain = audit.held
    .filter((g) => !flagged.has(g))
    .sort((a, b) => PLAIN_RANK(a) - PLAIN_RANK(b) || a.localeCompare(b));
  const shown = plain.slice(0, PLAIN_LIMIT);
  const cells: Cell[] = [
    ...audit.gaps.map((g) => ({
      label: shortGroup(g),
      badge: { text: "gap", tone: "error" as const },
    })),
    ...audit.extras.map((g) => ({
      label: shortGroup(g),
      badge: { text: "extra", tone: "info" as const },
    })),
    ...audit.baseline.map((g) => ({
      label: shortGroup(g),
      badge: { text: "baseline", tone: "neutral" as const },
    })),
    ...shown.map((g) => ({ label: shortGroup(g) })),
    ...(plain.length > shown.length ? [{ label: `${plain.length - shown.length} more` }] : []),
  ];
  const computed = audit.source === "computed" ? " · computed from role groups" : "";
  return { kind: "grid", title: `Effective groups · ${audit.held.length}${computed}`, cells };
}

function history(rt: Runtime, who: Identity, entry: DirectoryEntry | undefined): Row[] {
  const items: { at: string; row: Row }[] = [];
  if (who.kind === "person" && entry?.createdAt) {
    const text = who.guest ? "Invited to the tenant" : "Account created";
    items.push({ at: entry.createdAt, row: { glyph: "neutral", text } });
  }
  if (who.acceptedAt) {
    items.push({ at: who.acceptedAt, row: { glyph: "ok", text: "Accepted the invitation" } });
  }
  for (const e of rt.tracker.eventsFor(who.id)) {
    items.push({ at: e.at, row: { glyph: "neutral", text: e.text } });
  }
  return items
    .sort((a, b) => a.at.localeCompare(b.at))
    .map(({ at, row }) => ({ ...row, trailing: day(at) ?? at }));
}

function plannedActions(rt: Runtime, who: Identity): CanvasActionItem[] {
  const profile = rt.profile;
  const binding = profile ? { ...bindingOf(profile) } : {};
  const gate = rt.status.phase === "connected" ? {} : { disabled: true, reason: SIGNIN_REASON };
  const preview = (type: string, label: string, extra: Partial<CanvasActionItem> = {}) => ({
    type,
    label,
    payload: { id: who.id },
    binding,
    pendingLabel: "Planning…",
    ...gate,
    ...extra,
  });
  const fix =
    who.cause === "missing-users"
      ? PREVIEW_FIX_ACTION
      : who.cause === "duplicate"
        ? PREVIEW_CLEANUP_ACTION
        : undefined;
  return [
    ...(fix
      ? [
          preview(fix, who.cause === "duplicate" ? "Plan the cleanup" : "Plan the fix", {
            tone: "brand",
          }),
        ]
      : []),
    ...(who.kind === "person"
      ? [
          {
            type: "grant-seismic",
            label: "Grant seismic…",
            disabled: true,
            reason: "arrives with the ADME Seismic tab",
          },
        ]
      : []),
    ...(who.kind === "person"
      ? [{ type: EXPLAIN_ACTION, label: "Why 401/403", payload: { id: who.id }, binding }]
      : []),
    who.kind === "person"
      ? preview(PREVIEW_REMOVE_ACTION, "Remove person…")
      : {
          type: "remove-application",
          label: "Remove application…",
          disabled: true,
          reason: "removing an application is not planned yet",
        },
  ];
}

function groupActions(
  rt: Runtime,
  who: Identity,
  audit: GroupAudit | undefined,
): CanvasActionItem[] {
  const signin = rt.status.phase === "signin";
  const items: CanvasActionItem[] = [
    {
      type: REFRESH_PERSON_ACTION,
      label: "Re-read groups",
      payload: { id: who.id },
      ...(signin ? { disabled: true, reason: SIGNIN_REASON } : {}),
    },
  ];
  if (audit && audit.extras.length > 0) {
    items.push({
      type: ACCEPT_EXTRAS_ACTION,
      label: `Accept ${plural(audit.extras.length, "extra group", "extra groups")} as baseline`,
      hint: "Records them for this person only, so they stop counting as an access gap.",
      payload: { id: who.id },
      ...(rt.tracker.unreadable
        ? { disabled: true, reason: "the tracker in the data directory could not be read" }
        : {}),
    });
  }
  return items;
}

export function personAudit(rt: Runtime, who: Identity): GroupAudit | undefined {
  const closures = rt.cache.get<AccessRead>(ACCESS_AREA).data?.closures;
  if (!closures) return undefined;
  return auditGroups(who, closures, personRead(rt, who.id)?.groups, rt.tracker.baselineOf(who.id));
}

function freshness(rt: Runtime, id: string): string | undefined {
  const at = clock(personRead(rt, id)?.at);
  if (!at) return rt.freshness(ACCESS_AREA);
  return rt.status.phase === "connected" ? `measured ${at}` : `cached from ${at}`;
}

export function composePerson(rt: Runtime): CanvasBoardView {
  const measured = measuredAccess(rt);
  const read = rt.cache.get<AccessRead>(ACCESS_AREA).data;
  if (!measured || !read) return EMPTY_BOARD;
  const id = selectedId(rt);
  const who = id ? findIdentity(measured.model, id) : undefined;
  if (!who) {
    const text = id
      ? "This identity is not in the last read of entitlements."
      : "Pick a person on the ADME Access tab.";
    return { view: "board", sections: [{ kind: "rows", items: [{ glyph: "neutral", text }] }] };
  }
  const entry = read.directory[who.id];
  const audit = personAudit(rt, who);
  const list = checks(rt, read, who, entry, audit);
  const bad = worst(list);
  const tone: Tone | undefined = bad ? VERDICT_TONE[bad.verdict] : undefined;

  const left: Leaf[] = [
    {
      kind: "cards",
      title: "Identity",
      items: [
        {
          title: who.you ? `${who.name} (you)` : who.name,
          ...(tone
            ? { edge: tone, ...(bad?.pill ? { pill: { label: bad.pill, tone } } : {}) }
            : {}),
          stacked: true,
          fields: identityFields(rt, who, entry),
        },
      ],
    },
  ];
  const mail = (entry?.mail ?? entry?.upn)?.toLowerCase();
  const others = (entry?.otherMails ?? []).filter((m) => m.toLowerCase() !== mail);
  if (others.length > 0) {
    left.push({
      kind: "rows",
      title: "Same home identity",
      items: others.map((m) => ({
        chip: { label: "otherMails", tone: "info" as const },
        text: `${m} resolves to this account`,
      })),
    });
  }
  left.push({ kind: "actions", items: plannedActions(rt, who) });

  const right: Leaf[] = [
    {
      kind: "rows",
      title: "Access checks",
      items: list.map((c) => ({
        chip: { label: c.verdict, tone: VERDICT_TONE[c.verdict] },
        text: c.text,
        ...(c.trailing ? { trailing: c.trailing } : {}),
      })),
    },
  ];
  const failure = personError(rt, who.id);
  if (failure) {
    right.push({
      kind: "rows",
      items: [
        {
          glyph: "warn",
          text: `The per-person read failed at ${clock(failure.at)}: ${failure.message}`,
          trailing: personRead(rt, who.id) ? "showing the last read" : "showing role groups",
        },
      ],
    });
  }
  if (audit) right.push(groupGrid(audit));
  right.push({ kind: "actions", wrap: true, items: groupActions(rt, who, audit) });
  const past = history(rt, who, entry);
  if (past.length > 0) right.push({ kind: "rows", title: "History", items: past });

  const signin = rt.status.phase === "signin";
  return {
    view: "board",
    header: {
      status: signin
        ? { label: "sign-in needed", tone: "error" }
        : bad && tone
          ? { label: bad.status ?? bad.text, tone }
          : { label: "ok", tone: "ok" },
      chip: [entry?.mail ?? entry?.upn ?? who.appId ?? who.id, freshness(rt, who.id)]
        .filter(Boolean)
        .join(" · "),
    },
    sections: [
      {
        kind: "columns",
        columns: [
          { weight: 1, sections: left },
          { weight: 2, sections: right },
        ],
      },
    ],
  };
}
