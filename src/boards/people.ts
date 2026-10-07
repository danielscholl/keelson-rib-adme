// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { CanvasActionItem, CanvasBoardView } from "@keelson/shared";
import { grantedAt, USAGE_LABEL, USAGE_TONE, type Usage } from "../access/activity.ts";
import type { GroupCount, Identity } from "../access/model.ts";
import { groupByOrg, ORG_FILTER, orgOf } from "../access/orgs.ts";
import { selectedId } from "../access/person.ts";
import type { GroupKey } from "../access/read.ts";
import { EMPTY_BOARD } from "../resting.ts";
import type { Runtime } from "../runtime.ts";
import type { Grant, SeismicModel, SubprojectView } from "../seismic/model.ts";
import { SEISMIC_AREA } from "../seismic/read.ts";
import { UNTRACKED } from "../tracker.ts";
import {
  cohortNames,
  day,
  daysAgo,
  inCohort,
  type Measured,
  measuredAccess,
  openAction,
  ROLE_TONE,
  SELECT_PERSON_ACTION,
} from "./access.ts";
import { SIGNIN_REASON } from "./connection.ts";
import { measuredSeismic, SEIS_READ_ACTION } from "./seismic.ts";

type Section = CanvasBoardView["sections"][number];
type Row = Extract<Section, { kind: "rows" }>["items"][number];
type Table = Extract<Section, { kind: "table" }>;
type Cell = Table["rows"][number][string];

export const PEOPLE_VIEW_ACTION = "people-view";
export const PEOPLE_FILTER_ACTION = "people-filter";
export const EXPORT_GUIDE_ACTION = "export-access-guide";

export type PeopleView = "roster" | "matrix" | "grants";
const VIEWS: readonly { id: PeopleView; label: string }[] = [
  { id: "roster", label: "Roster" },
  { id: "matrix", label: "Roles matrix" },
  { id: "grants", label: "Seismic grants" },
];

// "all", "apps", "pending", "gaps", "cohort:<name>" or "org:<domain>".
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
const UNCAPPED = new Set(["Needs attention", "Cannot use it", "Invited", "Not used"]);
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
  if (filter.startsWith(ORG_FILTER)) {
    const domain = filter.slice(ORG_FILTER.length);
    const list = people.filter((p) => orgOf(p).domain === domain);
    return { label: list[0] ? orgOf(list[0]).name : domain, people: list, apps: [] };
  }
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
  if (pending > 0) filters.push(filter("pending", `Invited ${pending}`));
  if (gaps > 0) filters.push(filter("gaps", `Gaps ${gaps}`));
  if (s.filter.startsWith(ORG_FILTER)) {
    const org = groupByOrg(people).find((g) => `${ORG_FILTER}${g.org.domain}` === s.filter);
    if (org) filters.push(filter(s.filter, `${org.org.name} ${org.people.length}`));
  }
  return [
    { kind: "actions", wrap: true, items: view },
    { kind: "actions", wrap: true, items: filters },
  ];
}

function usageText(m: Measured | undefined, p: Identity, now: Date): string {
  const u = m?.usage.get(p.id);
  const since = (iso: string | undefined) => (iso ? daysAgo(iso, now) : "?");
  if (u === "invited") return `invited ${since(p.invitedAt)}`;
  if (u === "not-used") return `not used · granted ${since(grantedAt(p))}`;
  if (u === "active" || u === "idle") {
    const last =
      m?.activity.kind === "measured" ? m.activity.model.byId.get(p.id)?.last : undefined;
    return `${u === "idle" ? "idle · " : ""}last call ${since(last)}`;
  }
  if (p.acceptedAt) return `accepted ${day(p.acceptedAt)}`;
  if (p.invitedAt) return `invited ${day(p.invitedAt)}`;
  return p.guest ? "" : "member";
}

function groupsOff(g: GroupCount | undefined): string | undefined {
  return g && g.held !== g.expected ? `${g.held} of ${g.expected}` : undefined;
}

function rosterRow(
  m: Measured | undefined,
  p: Identity,
  selected: string | undefined,
  now: Date,
): Row {
  const u = m?.usage.get(p.id);
  const tone =
    p.state === "broken"
      ? "error"
      : u
        ? USAGE_TONE[u]
        : p.state === "pending"
          ? USAGE_TONE.invited
          : "ok";
  return {
    glyph: tone,
    chip: { label: p.role ?? "No role", ...(p.role ? { tone: ROLE_TONE[p.role] } : {}) },
    text: p.you ? `${p.name} (you)` : p.name,
    trailing: [p.email ?? orgOf(p).name, groupsOff(p.groups), usageText(m, p, now)]
      .filter(Boolean)
      .join(" · "),
    ...openAction(p, selected),
  };
}

function appRow(a: Identity, selected: string | undefined): Row {
  return {
    glyph: "neutral",
    chip: { label: a.role ?? "No role" },
    text: a.name,
    trailing: [a.appId ?? a.id, groupsText(a.groups), a.root ? "root app" : "application"]
      .filter(Boolean)
      .join(" · "),
    ...openAction(a, selected),
  };
}

const USAGE_GROUPS: readonly Usage[] = ["active", "idle", "not-used", "invited"];

// Gaps first; then by usage when the audit log is read, else each cohort.
function groupsOf(rt: Runtime, people: Identity[]): [string, Identity[]][] {
  const m = measuredAccess(rt);
  const out: [string, Identity[]][] = [];
  if (m?.activity.kind === "measured") {
    out.push(["Cannot use it", people.filter((p) => p.state === "broken")]);
    const rest = people.filter((p) => p.state !== "broken");
    for (const u of USAGE_GROUPS) {
      out.push([USAGE_LABEL[u], rest.filter((p) => m.usage.get(p.id) === u).sort(byRole)]);
    }
    return out.filter(([, list]) => list.length > 0);
  }
  const attention = people.filter((p) => p.state !== "healthy");
  const healthy = people.filter((p) => p.state === "healthy").sort(byRole);
  if (attention.length > 0) out.push(["Needs attention", attention]);
  if (rt.tracker.cohorts.length === 0) out.push(["Healthy", healthy]);
  else for (const name of cohortNames(rt, healthy)) out.push([name, inCohort(healthy, name)]);
  return out.filter(([, list]) => list.length > 0);
}

function rosterSections(rt: Runtime, f: Filtered, filter: PeopleFilter): Section[] {
  const selected = selectedId(rt);
  if (f.apps.length > 0) {
    return [
      {
        kind: "rows",
        title: `Applications · ${f.apps.length}`,
        items: f.apps.map((a) => appRow(a, selected)),
      },
    ];
  }
  const m = measuredAccess(rt);
  const now = rt.now();
  return groupsOf(rt, f.people).map(([title, list]) => {
    const capped = filter === "all" && !UNCAPPED.has(title);
    const shown = capped ? list.slice(0, ROSTER_LIMIT) : list;
    const rest = list.length - shown.length;
    const cohort = rt.tracker.cohorts.some((c) => c.name === title);
    const healthy = cohort || title === "Healthy" || title === UNTRACKED;
    const more = `… ${rest} more${healthy ? " · all healthy" : ""}${cohort ? ` · filter ${title} to list them` : ""}`;
    return {
      kind: "rows",
      title: `${title} · ${list.length}`,
      items: [
        ...shown.map((p) => rosterRow(m, p, selected, now)),
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
  const open = openForm(f.apps.length > 0 ? f.apps : f.people, selectedId(rt));
  return open ? [...sections, open] : sections;
}

// Table rows cannot be clicked, so the matrix opens a person from a picker.
function openForm(list: Identity[], selected: string | undefined): Section | undefined {
  if (list.length === 0) return undefined;
  const apps = list.every((i) => i.kind === "app");
  return {
    kind: "actions",
    items: [
      {
        type: SELECT_PERSON_ACTION,
        label: apps ? "Open application" : "Open person",
        submitLabel: "Open",
        fields: [
          {
            name: "id",
            label: apps ? "Application" : "Person",
            required: true,
            ...(selected && list.some((i) => i.id === selected) ? { defaultValue: selected } : {}),
            options: list.map((i) => ({
              value: i.id,
              label: i.name,
              ...(i.email || i.appId ? { hint: i.email ?? i.appId } : {}),
            })),
          },
        ],
      },
    ],
  };
}

const GRANT_ROWS = 25;
const GRANT_COLUMNS = 12;
const SEIS_BADGE = {
  admin: { text: "A", tone: "brand" },
  viewer: { text: "V", tone: "info" },
} as const;

function listed(names: readonly string[]): string {
  if (names.length <= 3) return names.join(", ");
  return `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
}

function andList(names: readonly string[]): string {
  if (names.length > 3 || names.length < 2) return listed(names);
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

function sentence(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}`;
}

function isTenantAdmin(i: Identity): boolean {
  return Boolean(i.memberships.admins || i.memberships.ops);
}

function hasDataRole(i: Identity): boolean {
  return Boolean(
    i.memberships.viewers || i.memberships.editors || i.memberships.admins || i.memberships.ops,
  );
}

function grantsOf(model: SeismicModel, i: Identity): Grant[] {
  const ids = new Set([i.id.toLowerCase(), ...(i.appId ? [i.appId.toLowerCase()] : [])]);
  return [...ids].flatMap((id) => model.grants[id] ?? []);
}

function unread(s: SubprojectView): boolean {
  return s.admins.kind === "unread" || s.viewers.kind === "unread";
}

function grantCell(held: Grant[], s: SubprojectView): Cell {
  const roles = (["admin", "viewer"] as const).filter((r) =>
    held.some((g) => g.subproject === s.name && g.role === r),
  );
  if (roles.length > 0) return { badges: roles.map((r) => ({ ...SEIS_BADGE[r] })) };
  return unread(s) ? "?" : null;
}

function defaultCell(i: Identity, held: Grant[], defaults: SubprojectView[]): Cell {
  const names = new Set(defaults.map((s) => s.name));
  const admin = held.some((g) => names.has(g.subproject) && g.role === "admin");
  if (admin) return { badges: [{ ...SEIS_BADGE.admin }] };
  return hasDataRole(i) ? { badges: [{ ...SEIS_BADGE.viewer }] } : null;
}

function seismicNotRead(rt: Runtime): Section[] {
  const error = rt.cache.get(SEISMIC_AREA).error;
  const gate = rt.status.phase === "connected" ? {} : { disabled: true, reason: SIGNIN_REASON };
  return [
    {
      kind: "rows",
      items: [
        error
          ? { glyph: "error", text: `Seismic subprojects could not be read: ${error}` }
          : {
              glyph: "neutral",
              text: "Seismic grants are not measured yet. Subprojects are read on first use, not on every sweep.",
            },
      ],
    },
    {
      kind: "actions",
      items: [
        {
          type: SEIS_READ_ACTION,
          label: error ? "Try again" : "Read subprojects",
          tone: "brand",
          pendingLabel: "Reading…",
          ...gate,
        },
      ],
    },
  ];
}

function grantsSections(rt: Runtime, f: Filtered, filter: PeopleFilter): Section[] {
  const seismic = measuredSeismic(rt);
  if (!seismic) return seismicNotRead(rt);
  const { model } = seismic;
  const apps = f.apps.length > 0;
  const list = apps ? f.apps : f.people;
  const noun = (n: number) =>
    apps ? (n === 1 ? "application" : "applications") : n === 1 ? "person" : "people";
  const holders = list
    .map((i) => ({ i, held: grantsOf(model, i) }))
    .filter((h) => h.held.length > 0)
    .sort((a, b) => Number(isTenantAdmin(a.i)) - Number(isTenantAdmin(b.i)));
  const limit = filter === "all" ? GRANT_ROWS : holders.length;
  const shown = holders.slice(0, limit);
  const defaults = model.subprojects.filter((s) => s.acl === "default");
  const own = model.subprojects.filter((s) => s.acl === "own" && !s.empty);
  const granted = (s: SubprojectView) =>
    unread(s) || shown.some((h) => h.held.some((g) => g.subproject === s.name));
  const columns = own.length > GRANT_COLUMNS ? own.filter(granted).slice(0, GRANT_COLUMNS) : own;
  const dropped = own.filter((s) => !columns.includes(s)).map((s) => s.name);
  const empty = model.subprojects.filter((s) => s.empty).map((s) => s.name);

  const rows: Table["rows"] = shown.map(({ i, held }) => {
    const name = i.you ? `${i.name} (you)` : i.name;
    const row: Table["rows"][number] = {
      person: isTenantAdmin(i)
        ? { value: name, badges: [{ text: "tenant admin", tone: "accent" }] }
        : name,
    };
    if (defaults.length > 0) row.default = defaultCell(i, held, defaults);
    for (const s of columns) row[`sp:${s.name}`] = grantCell(held, s);
    return row;
  });
  const sentences = [
    `${holders.length} of ${list.length} ${noun(list.length)} hold a subproject grant.`,
    ...(defaults.length > 0 && !apps
      ? [`Editors reach ${andList(defaults.map((s) => s.name))} through data.default.`]
      : []),
    "A is admin, V is viewer.",
  ];
  const sections: Section[] = [];
  if (rows.length === 0) {
    sections.push({
      kind: "rows",
      items: [{ glyph: "neutral", text: `No ${noun(2)} here hold a subproject grant.` }],
    });
  } else {
    sections.push({
      kind: "table",
      title: `Subproject grants · ${shown.length} of ${holders.length} ${noun(holders.length)}`,
      columns: [
        { key: "person", label: apps ? "Application" : "Person" },
        ...(defaults.length > 0
          ? [{ key: "default", label: `default (${listed(defaults.map((s) => s.name))})` }]
          : []),
        ...columns.map((s) => ({ key: `sp:${s.name}`, label: s.name })),
      ],
      rows,
      caption: sentences.join(" "),
    });
  }
  const notes: Row[] = [];
  if (shown.some((h) => isTenantAdmin(h.i))) {
    notes.push({
      glyph: "info",
      text: "Tenant admins",
      trailing: "can list and manage every subproject; reading one still needs its ACL group",
    });
  }
  if (model.partial) {
    notes.push({
      glyph: "warn",
      text: "Partial read",
      trailing: "some ACL groups could not be read; those cells show ?",
    });
  }
  const more = holders.length - shown.length;
  const hidden = [
    ...(more > 0 ? [`${more} more ${noun(more)} with a grant`] : []),
    ...(dropped.length > 0 ? [`${dropped.length} more subprojects (${listed(dropped)})`] : []),
    ...(empty.length > 0 ? [`${listed(empty)} (no members)`] : []),
  ];
  if (hidden.length > 0) {
    notes.push({ glyph: "neutral", text: "Not shown", trailing: sentence(hidden) });
  }
  if (notes.length > 0) sections.push({ kind: "rows", items: notes });
  const open = openForm(
    holders.map((h) => h.i),
    selectedId(rt),
  );
  return open ? [...sections, open] : sections;
}

export function composePeople(rt: Runtime): CanvasBoardView {
  const measured = measuredAccess(rt);
  if (!measured) return EMPTY_BOARD;
  const { model, counts } = measured;
  const s = peopleState(rt);
  const f = applyFilter(s.filter, model.people, model.apps);
  const total = f.apps.length > 0 ? f.apps.length : f.people.length;
  const body =
    s.view === "matrix"
      ? matrixSections(rt, f, s.filter, total)
      : s.view === "grants"
        ? grantsSections(rt, f, s.filter)
        : rosterSections(rt, f, s.filter);
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

function guideDate(iso: string | undefined): string {
  if (!iso) return "–";
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

const mdCell = (s: string) =>
  s
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/[\r\n]+/g, " ");

// The "Who has access" table of the access guide, in the guide's own words.
export function accessGuideMarkdown(m: Measured): string {
  const measured = m.activity.kind === "measured" ? m.activity.model : undefined;
  const rows = [...m.model.people]
    .sort(
      (a, b) =>
        (grantedAt(a) ?? "").localeCompare(grantedAt(b) ?? "") || a.name.localeCompare(b.name),
    )
    .map((p) => {
      const u = m.usage.get(p.id);
      const status = u ? USAGE_LABEL[u] : p.state === "pending" ? "Invited" : "Accepted";
      const role = p.role === "Admin" || p.role === "Ops" ? ` (${p.role.toLowerCase()})` : "";
      const last = measured?.byId.get(p.id)?.last;
      return `| ${[
        `${p.name}${role}`,
        p.email ?? "",
        status,
        guideDate(grantedAt(p)),
        measured ? guideDate(last) : "?",
      ]
        .map(mdCell)
        .join(" | ")} |`;
    });
  return `${["| Name | Email | Status | Granted | Last active |", "|---|---|---|---|---|", ...rows].join("\n")}\n`;
}
