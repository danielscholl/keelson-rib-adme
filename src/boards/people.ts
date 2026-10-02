// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { CanvasActionItem, CanvasBoardView } from "@keelson/shared";
import type { GroupCount, Identity } from "../access/model.ts";
import type { GroupKey } from "../access/read.ts";
import { EMPTY_BOARD } from "../resting.ts";
import type { Runtime } from "../runtime.ts";
import { UNTRACKED } from "../tracker.ts";
import { cohortNames, day, inCohort, measuredAccess } from "./access.ts";

type Section = CanvasBoardView["sections"][number];
type Row = Extract<Section, { kind: "rows" }>["items"][number];
type Table = Extract<Section, { kind: "table" }>;
type Cell = Table["rows"][number][string];

export const PEOPLE_VIEW_ACTION = "people-view";
export const PEOPLE_FILTER_ACTION = "people-filter";

export type PeopleView = "roster" | "matrix";
const VIEWS: readonly { id: PeopleView; label: string }[] = [
  { id: "roster", label: "Roster" },
  { id: "matrix", label: "Roles matrix" },
];

// "all", "apps", "pending", "gaps", or "cohort:<name>".
export type PeopleFilter = string;

export interface PeopleState {
  view: PeopleView;
  filter: PeopleFilter;
}

const state = new WeakMap<Runtime, PeopleState>();

export function peopleState(rt: Runtime): PeopleState {
  let s = state.get(rt);
  if (!s) {
    s = { view: "roster", filter: "all" };
    state.set(rt, s);
  }
  return s;
}

export function isPeopleView(v: unknown): v is PeopleView {
  return VIEWS.some((x) => x.id === v);
}

const ROSTER_LIMIT = 25;
const MATRIX_CHUNK = 15;
const ROLE_RANK: Record<string, number> = { Ops: 0, Admin: 1, Editor: 2, Viewer: 3 };

function byRole(a: Identity, b: Identity): number {
  return (ROLE_RANK[a.role ?? ""] ?? 4) - (ROLE_RANK[b.role ?? ""] ?? 4);
}

export function groupsText(g: GroupCount | undefined): string | undefined {
  return g ? `${g.held} of ${g.expected}` : undefined;
}

function isGap(p: Identity): boolean {
  return p.state === "broken";
}

interface Filtered {
  label: string;
  people: Identity[];
  apps: Identity[];
}

function applyFilter(filter: PeopleFilter, people: Identity[], apps: Identity[]): Filtered {
  if (filter === "apps") return { label: "applications", people: [], apps };
  if (filter === "pending")
    return { label: "pending", people: people.filter((p) => p.state === "pending"), apps: [] };
  if (filter === "gaps") return { label: "gaps", people: people.filter(isGap), apps: [] };
  if (filter.startsWith("cohort:")) {
    const name = filter.slice("cohort:".length);
    return { label: name, people: inCohort(people, name), apps: [] };
  }
  return { label: "all", people, apps: [] };
}

function chips(rt: Runtime, s: PeopleState, people: Identity[], apps: Identity[]): Section[] {
  const view: CanvasActionItem[] = VIEWS.map((v) => ({
    type: PEOPLE_VIEW_ACTION,
    label: v.label,
    payload: { view: v.id },
    selected: s.view === v.id,
  }));
  view.push({
    type: PEOPLE_VIEW_ACTION,
    label: "Seismic grants",
    payload: { view: "grants" },
    disabled: true,
    reason: "arrives with the ADME Seismic tab",
  });
  const filter = (id: PeopleFilter, label: string): CanvasActionItem => ({
    type: PEOPLE_FILTER_ACTION,
    label,
    payload: { filter: id },
    selected: s.filter === id,
  });
  const filters = [filter("all", "All")];
  if (rt.tracker.cohorts.length > 0) {
    for (const name of cohortNames(rt, people)) {
      filters.push(filter(`cohort:${name}`, `${name} ${inCohort(people, name).length}`));
    }
  }
  filters.push(filter("apps", `Applications ${apps.length}`));
  const pending = people.filter((p) => p.state === "pending").length;
  const gaps = people.filter(isGap).length;
  if (pending > 0) filters.push(filter("pending", `Pending ${pending}`));
  if (gaps > 0) filters.push(filter("gaps", `Gaps ${gaps}`));
  return [
    { kind: "actions", wrap: true, items: view },
    { kind: "actions", wrap: true, items: filters },
  ];
}

function rosterRow(p: Identity): Row {
  const tone = p.state === "broken" ? "error" : p.state === "pending" ? "warn" : "ok";
  const when = p.acceptedAt
    ? `accepted ${day(p.acceptedAt)}`
    : p.invitedAt
      ? `invited ${day(p.invitedAt)}`
      : p.guest
        ? ""
        : "member";
  return {
    glyph: tone,
    chip: { label: p.role ?? "No role" },
    text: p.you ? `${p.name} (you)` : p.name,
    trailing: [p.email, groupsText(p.groups), when].filter(Boolean).join(" · "),
  };
}

function appRow(a: Identity): Row {
  return {
    glyph: "neutral",
    chip: { label: a.role ?? "No role" },
    text: a.name,
    trailing: [a.appId ?? a.id, groupsText(a.groups), a.root ? "root app" : "application"]
      .filter(Boolean)
      .join(" · "),
  };
}

// Attention first, then each cohort (or one healthy group when none is tracked).
function groupsOf(rt: Runtime, people: Identity[]): [string, Identity[]][] {
  const attention = people.filter((p) => p.state !== "healthy");
  const healthy = people.filter((p) => p.state === "healthy").sort(byRole);
  const out: [string, Identity[]][] = [];
  if (attention.length > 0) out.push(["Needs attention", attention]);
  if (rt.tracker.cohorts.length === 0) out.push(["Healthy", healthy]);
  else for (const name of cohortNames(rt, healthy)) out.push([name, inCohort(healthy, name)]);
  return out.filter(([, list]) => list.length > 0);
}

function rosterSections(rt: Runtime, f: Filtered, filter: PeopleFilter): Section[] {
  if (f.apps.length > 0) {
    return [{ kind: "rows", title: `Applications · ${f.apps.length}`, items: f.apps.map(appRow) }];
  }
  return groupsOf(rt, f.people).map(([title, list]) => {
    const capped = filter === "all" && title !== "Needs attention";
    const shown = capped ? list.slice(0, ROSTER_LIMIT) : list;
    const rest = list.length - shown.length;
    const more = `… ${rest} more · all healthy${title === UNTRACKED || title === "Healthy" ? "" : ` · filter ${title} to list them`}`;
    return {
      kind: "rows",
      title: `${title} · ${list.length}`,
      items: [
        ...shown.map(rosterRow),
        ...(rest > 0 ? [{ glyph: "neutral" as const, text: more }] : []),
      ],
    };
  });
}

const ROLE_COLUMNS: readonly [Exclude<GroupKey, "users">, string][] = [
  ["viewers", "Viewers"],
  ["editors", "Editors"],
  ["admins", "Admins"],
  ["ops", "Ops"],
];

function membershipCell(p: Identity, key: GroupKey): Cell {
  const held = p.memberships[key];
  const badges = [
    ...(held ? [{ text: held, tone: (held === "O" ? "brand" : "info") as "brand" | "info" }] : []),
    ...(p.duplicateIn === key ? [{ text: "duplicate", tone: "warn" as const }] : []),
  ];
  return badges.length > 0 ? { badges } : null;
}

function matrixRow(rt: Runtime, p: Identity): Table["rows"][number] {
  const entra =
    p.kind === "app"
      ? null
      : p.state === "pending"
        ? { value: "Pending", tone: "warn" as const }
        : p.guest
          ? { value: "Accepted", tone: "ok" as const }
          : "member";
  const users: Cell = p.memberships.users
    ? { value: "✓", tone: "ok" }
    : p.role
      ? { value: "✕ missing", tone: "error" }
      : null;
  const roster: Cell =
    p.inRoster === undefined ? null : p.inRoster ? "in" : { value: "✕ not in", tone: "warn" };
  const groups: Cell = p.groups
    ? {
        value: `${p.groups.held}/${p.groups.expected}`,
        ...(p.groups.held !== p.groups.expected ? { tone: "warn" as const } : {}),
      }
    : null;
  const pass = rt.tracker.cohorts.find((c) => c.name === p.cohort)?.passEnds ?? null;
  const row: Table["rows"][number] = {
    person: p.you ? `${p.name} (you)` : p.name,
    kind: p.kind === "app" ? "app" : p.guest ? "guest" : "member",
    entra,
    roster: p.kind === "app" ? null : roster,
    users,
    groups,
    pass: p.kind === "app" ? null : pass,
  };
  for (const [key] of ROLE_COLUMNS) row[key] = membershipCell(p, key);
  return row;
}

const MATRIX_COLUMNS: Table["columns"] = [
  { key: "person", label: "Person" },
  { key: "kind", label: "Kind" },
  { key: "entra", label: "Entra" },
  { key: "roster", label: "Roster group" },
  { key: "users", label: "users@" },
  ...ROLE_COLUMNS.map(([key, label]) => ({ key, label })),
  { key: "groups", label: "Groups" },
  { key: "pass", label: "Pass" },
];

function matrixSections(rt: Runtime, f: Filtered, filter: PeopleFilter, total: number): Section[] {
  const groups: [string, Identity[]][] =
    f.apps.length > 0 ? [["Applications", f.apps]] : groupsOf(rt, f.people);
  const sections: Table[] = [];
  let shown = 0;
  for (const [title, list] of groups) {
    // With no filter each group shows its first chunk; a filter lists everyone.
    const limit = filter === "all" ? MATRIX_CHUNK : list.length;
    for (let i = 0; i < Math.min(list.length, limit); i += MATRIX_CHUNK) {
      const chunk = list.slice(i, Math.min(i + MATRIX_CHUNK, limit));
      shown += chunk.length;
      const range =
        list.length <= MATRIX_CHUNK
          ? `${list.length}`
          : `${i + 1} to ${i + chunk.length} of ${list.length}`;
      sections.push({
        kind: "table",
        title: `${title} · ${range}`,
        columns: MATRIX_COLUMNS,
        rows: chunk.map((p) => matrixRow(rt, p)),
      });
    }
  }
  const last = sections.at(-1);
  if (last) {
    const hint = shown < total ? " Filter by cohort to list everyone." : "";
    last.caption = `Showing ${shown} of ${total} · filter: ${f.label}. M is member, O is owner.${hint}`;
  }
  return sections;
}

export function composePeople(rt: Runtime): CanvasBoardView {
  const measured = measuredAccess(rt);
  if (!measured) return EMPTY_BOARD;
  const { model, counts } = measured;
  const s = peopleState(rt);
  const f = applyFilter(s.filter, model.people, model.apps);
  const total = f.apps.length > 0 ? f.apps.length : f.people.length;
  const body =
    s.view === "matrix" ? matrixSections(rt, f, s.filter, total) : rosterSections(rt, f, s.filter);
  if (body.length === 0) {
    body.push({
      kind: "rows",
      items: [
        {
          glyph: "neutral",
          text:
            model.people.length === 0
              ? "No people have entitlements."
              : "Nobody matches this filter.",
        },
      ],
    });
  }
  return {
    view: "board",
    header: {
      chip: `${total} of ${s.filter === "apps" ? counts.apps : counts.people} · ${f.label}`,
    },
    sections: [...chips(rt, s, model.people, model.apps), ...body],
  };
}
