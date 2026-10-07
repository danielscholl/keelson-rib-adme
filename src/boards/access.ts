// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { CanvasBoardView } from "@keelson/shared";
import {
  type ActivityState,
  activityState,
  callsIn,
  grantedAt,
  recentDays,
  USAGE_LABEL,
  USAGE_TONE,
  type Usage,
  usageOf,
} from "../access/activity.ts";
import {
  type AccessCounts,
  type AccessModel,
  buildAccess,
  countAccess,
  type Identity,
  ROLES,
} from "../access/model.ts";
import { groupByOrg, orgOf } from "../access/orgs.ts";
import { selectedId } from "../access/person.ts";
import { ACCESS_AREA, type AccessRead, GROUP_NAMES } from "../access/read.ts";
import { instanceName, shortId } from "../profile.ts";
import { composeRestingHeader, EMPTY_BOARD } from "../resting.ts";
import type { Runtime } from "../runtime.ts";
import { clock } from "../sweep.ts";
import { type Cohort, csvCell, daysUntil, UNTRACKED } from "../tracker.ts";
import { signinCard } from "./connection.ts";

type Section = CanvasBoardView["sections"][number];
type Card = Extract<Section, { kind: "cards" }>["items"][number];
type Row = Extract<Section, { kind: "rows" }>["items"][number];
type Stat = Extract<Section, { kind: "stats" }>["items"][number];

export const IMPORT_COHORTS_ACTION = "import-cohorts";
export const EXPORT_ROSTER_ACTION = "export-roster";
export const SELECT_PERSON_ACTION = "select-person";

export function inCohort(people: Identity[], name: string): Identity[] {
  return people.filter((p) => (p.cohort ?? UNTRACKED) === name);
}

// Tracked cohorts in the order they were created, then Untracked when anyone is.
export function cohortNames(rt: Runtime, people: Identity[]): string[] {
  const names = rt.tracker.cohorts.map((c) => c.name);
  return people.some((p) => !p.cohort) ? [...names, UNTRACKED] : names;
}

export function passText(cohort: Cohort | undefined, now: Date): string {
  if (!cohort?.passEnds) return "none";
  const days = daysUntil(cohort.passEnds, now);
  return days < 0 ? `ended ${-days} d ago · ${cohort.passEnds}` : `${days} d · ${cohort.passEnds}`;
}

function nextPass(rt: Runtime, people: Identity[]): Stat {
  const label = "Next pass ends";
  if (rt.tracker.unreadable) return { label, value: null, sub: "the tracker could not be read" };
  if (rt.tracker.cohorts.length === 0)
    return { label, value: null, sub: "no cohort is tracked yet" };
  const dated = rt.tracker.cohorts
    .filter((c) => c.passEnds && inCohort(people, c.name).length > 0)
    .sort((a, b) => (a.passEnds as string).localeCompare(b.passEnds as string))[0];
  if (!dated?.passEnds) return { label, value: "none", sub: "no cohort has a pass end" };
  const days = daysUntil(dated.passEnds, rt.now());
  return {
    label,
    value: days < 0 ? "ended" : `${days} d`,
    sub: `${dated.name} · ${dated.passEnds}`,
    ...(days < 0 ? { tone: "error" as const } : {}),
  };
}

export const ROLE_TONE = {
  Ops: "info",
  Admin: "brand",
  Editor: "accent",
  Viewer: "neutral",
} as const;
const DAY_MS = 86_400_000;
const INVITED_LIMIT = 12;
const NOT_USED_LIMIT = 8;

export interface Measured {
  model: AccessModel;
  counts: AccessCounts;
  activity: ActivityState;
  // Each person's usage; undefined while the audit log is not measured.
  usage: Map<string, Usage | undefined>;
}

export function measuredAccess(rt: Runtime): Measured | undefined {
  const read = rt.cache.get<AccessRead>(ACCESS_AREA).data;
  if (!read || rt.status.phase === "firstrun" || rt.status.phase === "profile-error") {
    return undefined;
  }
  const model = buildAccess(read, {
    signedInAs: rt.status.test?.signedInAs,
    admeAppId: rt.profile?.admeAppId,
    cohortOf: (email) => rt.tracker.cohortOf(email),
  });
  const activity = activityState(rt, model);
  const known = activity.kind === "measured" ? activity.model : undefined;
  const now = rt.now();
  const usage = new Map(model.people.map((p) => [p.id, usageOf(p, known, now)] as const));
  return { model, counts: countAccess(model), activity, usage };
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function day(iso: string | undefined): string | undefined {
  return iso?.slice(0, 10);
}

export function daysAgo(iso: string, now: Date): string {
  const days = Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / DAY_MS));
  return days === 0 ? "today" : days === 1 ? "yesterday" : `${days} d ago`;
}

export function usageCount(m: Measured, u: Usage): number | null {
  if (u !== "invited" && m.activity.kind !== "measured") return null;
  return m.model.people.filter((p) => m.usage.get(p.id) === u).length;
}

// Who to chase: anyone who cannot use their access, has not accepted, or never called.
export function followUpCount(m: Measured): number {
  const unused = m.model.people.filter(
    (p) => p.state !== "broken" && m.usage.get(p.id) === "not-used",
  ).length;
  return m.counts.broken + m.counts.pending + unused + m.counts.unknown;
}

export function activityReason(state: ActivityState): string {
  if (state.kind === "unset") return "set the audit log workspace in Connection";
  if (state.kind === "unread") return state.error ?? "the audit log is not read yet";
  return "";
}

export function adoptionSegments(m: Measured) {
  const invited = usageCount(m, "invited") ?? 0;
  if (m.activity.kind !== "measured") {
    return [
      { label: "Invited", n: invited, tone: USAGE_TONE.invited },
      { label: "Accepted", n: m.model.people.length - invited, tone: "neutral" as const },
      { label: "In use: not measured", n: null },
    ];
  }
  return (["invited", "not-used", "idle", "active"] as const).map((u) => ({
    label: USAGE_LABEL[u],
    n: usageCount(m, u),
    tone: USAGE_TONE[u],
  }));
}

function stateLine(m: Measured, orgs: number): string {
  const { counts } = m;
  const head = `${plural(counts.people, "person", "people")} from ${plural(orgs, "organization", "organizations")}.`;
  const gaps =
    counts.broken > 0 ? ` ${plural(counts.broken, "person cannot", "people cannot")} use it.` : "";
  const active = usageCount(m, "active");
  const notUsed = usageCount(m, "not-used");
  if (active === null || notUsed === null) {
    return `${head} ${counts.pending} not accepted yet.${gaps} Who uses it is not measured: ${activityReason(m.activity)}.`;
  }
  return `${head} ${active} used it this week; ${counts.pending} not accepted yet and ${notUsed} accepted but never made a call.${gaps}`;
}

// People present on each of the last 14 days, by when their access began.
function joinedSpark(people: Identity[], days: readonly string[]): number[] | undefined {
  const dated = people.map(grantedAt).filter((d): d is string => Boolean(d));
  if (dated.length === 0) return undefined;
  const undated = people.length - dated.length;
  return days.map((d) => undated + dated.filter((g) => g.slice(0, 10) <= d).length);
}

function activeIn(m: Measured, days: readonly string[]): number {
  if (m.activity.kind !== "measured") return 0;
  const a = m.activity.model;
  return m.model.people.filter((p) => callsIn(a.byId.get(p.id), days) > 0).length;
}

function delta(n: number, unit: string) {
  return n === 0
    ? { text: `no change ${unit}`, direction: "flat" as const, tone: "neutral" as const }
    : {
        text: `${n > 0 ? "+" : ""}${n} ${unit}`,
        direction: n > 0 ? ("up" as const) : ("down" as const),
        tone: n > 0 ? ("ok" as const) : ("warn" as const),
      };
}

function oldest(people: Identity[], at: (p: Identity) => string | undefined): string | undefined {
  return people
    .map(at)
    .filter((d): d is string => Boolean(d))
    .sort()[0];
}

function pulseStats(rt: Runtime, m: Measured, orgs: number): Stat[] {
  const { counts, model } = m;
  const now = rt.now();
  const days = recentDays(now);
  const week = days.slice(-7);
  const prior = days.slice(0, 7);
  const mix = ROLES.filter((r) => counts.roles[r] > 0)
    .map((r) => `${counts.roles[r]} ${r}`)
    .join(", ");
  const joined = model.people.filter((p) => {
    const g = grantedAt(p);
    return g !== undefined && g.slice(0, 10) >= (week[0] as string);
  }).length;
  const people: Stat = {
    label: "People",
    value: counts.people,
    sub:
      rt.tracker.cohorts.length > 0
        ? cohortNames(rt, model.people)
            .map((name) => `${inCohort(model.people, name).length} ${name}`)
            .join(" · ")
        : [plural(orgs, "organization", "organizations"), mix].filter(Boolean).join(" · "),
    ...(joined > 0 ? { delta: delta(joined, "this week") } : {}),
  };
  const spark = joinedSpark(model.people, days);
  if (spark?.some((n) => n !== spark[0])) people.spark = spark;

  const measured = m.activity.kind === "measured";
  const active = usageCount(m, "active");
  const activeTile: Stat = {
    label: "Active this week",
    value: active,
    sub: measured ? "made a data call in 7 days" : activityReason(m.activity),
  };
  if (measured) {
    activeTile.spark = days.map((d) => activeIn(m, [d]));
    activeTile.delta = delta(activeIn(m, week) - activeIn(m, prior), "vs last week");
  }

  const pendingPeople = model.people.filter((p) => p.state === "pending");
  const oldestInvite = oldest(pendingPeople, (p) => p.invitedAt);
  const notUsed = usageCount(m, "not-used");
  const oldestGrant = oldest(
    model.people.filter((p) => m.usage.get(p.id) === "not-used"),
    grantedAt,
  );
  const gaps = [
    counts.missingUsers > 0 ? `${counts.missingUsers} missing users@` : "",
    counts.duplicates > 0 ? plural(counts.duplicates, "duplicate entry", "duplicate entries") : "",
  ].filter(Boolean);
  return [
    people,
    activeTile,
    {
      label: "Not accepted",
      value: counts.pending,
      sub: oldestInvite ? `oldest invited ${daysAgo(oldestInvite, now)}` : "none waiting",
      ...(counts.pending > 0 ? { tone: "warn" as const } : {}),
    },
    {
      label: "Accepted, never used",
      value: notUsed,
      sub:
        notUsed === null
          ? "needs the audit log"
          : oldestGrant
            ? `oldest granted ${daysAgo(oldestGrant, now)}`
            : "everyone has made a call",
      ...(notUsed ? { tone: "warn" as const } : {}),
    },
    {
      label: "Access gaps",
      value: counts.broken,
      sub: gaps.join(" · ") || "none found",
      ...(counts.broken > 0 ? { tone: "error" as const } : {}),
    },
    ...(rt.tracker.cohorts.length > 0 || rt.tracker.unreadable ? [nextPass(rt, model.people)] : []),
  ];
}

function followPill(m: Measured) {
  const n = followUpCount(m);
  return n > 0
    ? { label: `${n} to follow up`, tone: "caution" as const }
    : { label: "all in use", tone: "ok" as const };
}

export function composeAccessPulse(rt: Runtime): CanvasBoardView {
  const signedInAs = rt.status.test?.signedInAs;
  const resting = () =>
    composeRestingHeader(rt.status, {
      firstRunHere: true,
      discovery: rt.discovery,
      connectedText: `Connected${signedInAs ? ` as ${signedInAs}` : ""}.`,
    });
  const measured = measuredAccess(rt);
  const profile = rt.profile;
  if (!profile) return resting();
  if (!measured) {
    const view = resting();
    const error = rt.cache.get(ACCESS_AREA).error;
    if (rt.status.phase !== "connected") return view;
    return {
      ...view,
      sections: [
        ...view.sections,
        {
          kind: "rows",
          items: [
            error
              ? { glyph: "error", text: `People and applications could not be read: ${error}` }
              : { glyph: "neutral", text: "People and applications are not measured yet." },
          ],
        },
      ],
    };
  }
  const orgs = groupByOrg(measured.model.people).length;
  const sections: Section[] = [];
  if (rt.status.phase === "signin") sections.push(signinCard(rt.status));
  sections.push({ kind: "rows", items: [{ text: stateLine(measured, orgs) }] });
  sections.push({ kind: "stats", items: pulseStats(rt, measured, orgs) });
  const fresh = rt.freshness(ACCESS_AREA);
  const last = rt.cache.get(ACCESS_AREA);
  if (last.error) {
    sections.push({
      kind: "rows",
      items: [
        {
          glyph: "warn",
          text: `Last read failed${last.errorAt ? ` at ${clock(last.errorAt)}` : ""}: ${last.error}`,
          trailing: `showing ${clock(last.at)}`,
        },
      ],
    });
  }
  return {
    view: "board",
    header: {
      status:
        rt.status.phase === "signin"
          ? { label: "sign-in needed", tone: "error" }
          : followPill(measured),
      chip: [instanceName(profile), profile.partition, fresh].filter(Boolean).join(" · "),
      segments: adoptionSegments(measured),
    },
    sections,
  };
}

// Clicking a person or application opens the inspector in the drawer.
export function openAction(who: Identity, selected: string | undefined) {
  return {
    action: { type: SELECT_PERSON_ACTION, payload: { id: who.id } },
    ...(who.id === selected ? { selected: true } : {}),
  };
}

function capped(rows: Row[], limit: number, rest: (n: number) => string): Row[] {
  if (rows.length <= limit) return rows;
  return [...rows.slice(0, limit), { glyph: "neutral", text: rest(rows.length - limit) }];
}

function followRows(m: Measured, now: Date, selected: string | undefined): Section[] {
  const people = m.model.people;
  const org = (p: Identity) => orgOf(p).name;
  const sections: Section[] = [];
  const cannot = people.filter((p) => p.state === "broken");
  if (cannot.length > 0) {
    sections.push({
      kind: "rows",
      title: `Cannot use it · ${cannot.length}`,
      items: cannot.map((p) =>
        p.cause === "missing-users"
          ? {
              glyph: "error" as const,
              chip: { label: "401", tone: "error" as const },
              text: p.name,
              trailing: `${org(p)} · not in users@, every call returns 401`,
              ...openAction(p, selected),
            }
          : {
              glyph: "warn" as const,
              chip: { label: "duplicate", tone: "warn" as const },
              text: p.name,
              trailing: `${org(p)} · listed twice in ${GROUP_NAMES[p.duplicateIn ?? roleGroup(p)]}`,
              ...openAction(p, selected),
            },
      ),
    });
  }
  const byOldest = (at: (p: Identity) => string | undefined) => (a: Identity, b: Identity) =>
    (at(a) ?? "").localeCompare(at(b) ?? "");
  const invited = people.filter((p) => p.state === "pending").sort(byOldest((p) => p.invitedAt));
  if (invited.length > 0) {
    sections.push({
      kind: "rows",
      title: `Has not accepted the invitation · ${invited.length}`,
      items: capped(
        invited.map((p) => ({
          glyph: USAGE_TONE.invited,
          text: p.name,
          trailing: `${org(p)} · invited ${p.invitedAt ? daysAgo(p.invitedAt, now) : "?"}`,
          ...openAction(p, selected),
        })),
        INVITED_LIMIT,
        (n) => `… ${n} more, all listed in People under Invited`,
      ),
    });
  }
  if (m.activity.kind === "measured") {
    const unused = people
      .filter((p) => p.state !== "broken" && m.usage.get(p.id) === "not-used")
      .sort(byOldest(grantedAt));
    if (unused.length > 0) {
      sections.push({
        kind: "rows",
        title: `Accepted, never made a call · ${unused.length}`,
        items: capped(
          unused.map((p) => {
            const g = grantedAt(p);
            return {
              glyph: USAGE_TONE["not-used"],
              text: p.name,
              trailing: `${org(p)} · access granted ${g ? daysAgo(g, now) : "?"}`,
              ...openAction(p, selected),
            };
          }),
          NOT_USED_LIMIT,
          (n) => `… ${n} more, all listed in People under Not used`,
        ),
      });
    }
  } else {
    sections.push({
      kind: "rows",
      items: [
        {
          glyph: "neutral",
          text: `Who accepted but never made a call is not measured: ${activityReason(m.activity)}.`,
        },
      ],
    });
  }
  return sections;
}

// The roster group is tracking only: ADME never reads it, so drift is a note, not a gap.
function rosterDrift(model: AccessModel): Row[] {
  const outside = model.people
    .filter((p) => p.inRoster === false)
    .map((p) => ({
      glyph: "warn" as const,
      text: p.name,
      trailing: `${p.email ?? shortId(p.id)} · has entitlements, not in the roster group`,
    }));
  const extra = (model.rosterOnly ?? []).map((m) => ({
    glyph: "neutral" as const,
    text: m.name ?? shortId(m.id),
    trailing: `${m.mail ?? shortId(m.id)} · in the roster group, no entitlements`,
  }));
  return [...outside, ...extra];
}

function roleGroup(p: Identity): "ops" | "admins" | "editors" | "viewers" {
  for (const key of ["ops", "admins", "editors", "viewers"] as const) {
    if (p.memberships[key]) return key;
  }
  return "viewers";
}

export function composeAttention(rt: Runtime): CanvasBoardView {
  const measured = measuredAccess(rt);
  if (!measured) return EMPTY_BOARD;
  const { model, counts } = measured;
  const sections = followRows(measured, rt.now(), selectedId(rt));
  const deleted = model.unknown.filter((u) => u.deleted);
  const unknown = model.unknown.filter((u) => !u.deleted);
  if (deleted.length > 0) {
    sections.push({
      kind: "rows",
      title: `Deleted in Entra, still in entitlements · ${deleted.length}`,
      items: deleted.map((u) => ({
        glyph: "warn" as const,
        text: shortId(u.id),
        trailing: `${u.role ?? "no role"} · restorable for 30 days after deletion`,
      })),
    });
  }
  if (unknown.length > 0) {
    sections.push({
      kind: "rows",
      title: `Unknown principals · ${unknown.length}`,
      items: unknown.map((u) => ({
        glyph: "warn" as const,
        text: u.name,
        trailing: `${u.role ?? "no role"} · ${u.id.includes("@") ? "listed by email, not resolved" : "not found in Entra"}`,
      })),
    });
  }
  const drift = rosterDrift(model);
  if (drift.length > 0) {
    sections.push({ kind: "rows", title: `Roster drift · ${drift.length}`, items: drift });
  }
  const clean = (found: boolean, text: string) =>
    found ? [] : [{ glyph: "ok" as const, text, trailing: "0 found" }];
  sections.push({
    kind: "rows",
    title: "Checks that found nothing",
    items: [
      ...(counts.rosterDrift === undefined
        ? []
        : clean(drift.length > 0, "Roster drift (Entra roster vs entitlements)")),
      ...clean(deleted.length > 0, "Deleted in Entra, still in entitlements"),
      ...clean(unknown.length > 0, "Unknown principals"),
      ...clean(counts.missingUsers > 0, "Role without users@"),
      ...clean(counts.duplicates > 0, "Duplicate member entries"),
    ],
  });
  const checks = sections.at(-1);
  if (checks?.kind === "rows" && checks.items.length === 0) sections.pop();
  return {
    view: "board",
    header: { status: followPill(measured), chip: "oldest first" },
    sections,
  };
}

export function composePrincipals(rt: Runtime): CanvasBoardView {
  const measured = measuredAccess(rt);
  if (!measured) return EMPTY_BOARD;
  const { model, counts } = measured;
  const selected = selectedId(rt);
  if (model.apps.length === 0) {
    return {
      view: "board",
      sections: [
        { kind: "rows", items: [{ glyph: "neutral", text: "No applications have entitlements." }] },
      ],
    };
  }
  return {
    view: "board",
    header:
      counts.rootApps > 0
        ? { status: { label: `${counts.rootApps} legacy`, tone: "caution" } }
        : {},
    sections: [
      {
        kind: "cards",
        items: model.apps.map((a) => ({
          title: a.name,
          mono: true,
          ...(a.root
            ? { edge: "caution" as const, pill: { label: "legacy", tone: "caution" as const } }
            : {}),
          fields: [
            { label: "appId", value: a.appId ?? a.id, copyable: true },
            { label: "Role", value: a.root ? "root app, keyed by appId" : (a.role ?? "none") },
          ],
          ...(a.root
            ? { footnote: "The app the instance runs as. Shared, so its calls name no person." }
            : {}),
          ...openAction(a, selected),
        })),
      },
    ],
  };
}

function rosterCsv(people: Identity[], cohort: Cohort | undefined, name: string): string {
  const rows = people.map((p) =>
    [p.name, p.email ?? "", p.role ?? "", p.state, name, cohort?.passEnds ?? ""]
      .map(csvCell)
      .join(","),
  );
  return `${["name,email,role,state,cohort,pass_end", ...rows].join("\n")}\n`;
}

// The roster of one cohort as CSV, or undefined when nobody is in it.
export function exportRoster(rt: Runtime, name: string): string | undefined {
  const measured = measuredAccess(rt);
  if (!measured) return undefined;
  const people = inCohort(measured.model.people, name);
  if (people.length === 0) return undefined;
  return rosterCsv(
    people,
    rt.tracker.cohorts.find((c) => c.name === name),
    name,
  );
}

function cohortCard(rt: Runtime, name: string, people: Identity[]): Card {
  const cohort = rt.tracker.cohorts.find((c) => c.name === name);
  const n = (state: Identity["state"]) => people.filter((p) => p.state === state).length;
  const segments = [
    { label: "broken", n: n("broken"), tone: "error" as const },
    { label: "pending", n: n("pending"), tone: "warn" as const },
    { label: "healthy", n: n("healthy"), tone: "ok" as const },
  ].filter((s) => s.n > 0);
  return {
    title: name,
    pill: { label: plural(people.length, "person", "people") },
    ...(segments.length > 0 ? { bar: { segments } } : {}),
    fields: [
      { label: "Pass ends", value: name === UNTRACKED ? "?" : passText(cohort, rt.now()) },
      ...(cohort ? [{ label: "Created", value: cohort.created }] : []),
    ],
    ...(people.length > 0
      ? {
          actions: [
            { type: EXPORT_ROSTER_ACTION, label: "Export roster", payload: { cohort: name } },
          ],
        }
      : {}),
    ...(name === UNTRACKED ? { footnote: "In entitlements, in no tracked cohort." } : {}),
  };
}

export function composeCohorts(rt: Runtime): CanvasBoardView {
  const measured = measuredAccess(rt);
  if (!measured) return EMPTY_BOARD;
  const people = measured.model.people;
  const tracked = rt.tracker.cohorts.length;
  const names = cohortNames(rt, people);
  const untracked = people.filter((p) => !p.cohort).length;
  const sections: Section[] = [];
  if (rt.tracker.unreadable) {
    sections.push({
      kind: "rows",
      items: [
        {
          glyph: "error",
          text: "The cohort tracker in the data directory could not be read, so cohorts are not shown. Fix or remove the file, then restart.",
        },
      ],
    });
  } else if (tracked === 0) {
    sections.push({
      kind: "rows",
      items: [
        {
          glyph: "neutral",
          text: "No cohort is tracked. Import a list to group people and track when each pass ends.",
        },
      ],
    });
  }
  if (names.length > 0) {
    sections.push({
      kind: "cards",
      grid: true,
      items: names.map((name) => cohortCard(rt, name, inCohort(people, name))),
    });
  }
  sections.push({
    kind: "actions",
    items: [
      {
        type: IMPORT_COHORTS_ACTION,
        label: "Import cohorts",
        submitLabel: "Import",
        fields: [
          {
            name: "csv",
            label: "One person per line: email, cohort, pass end (optional)",
            placeholder: "kofi.mensah@volta-subsurface.example, Pilot, 2026-10-28",
            multiline: true,
            required: true,
          },
        ],
      },
    ],
  });
  return {
    view: "board",
    header: {
      chip: [
        plural(people.length, "person", "people"),
        plural(tracked, "cohort", "cohorts"),
        ...(untracked > 0 ? [`${untracked} untracked`] : []),
      ].join(" · "),
    },
    sections,
  };
}
