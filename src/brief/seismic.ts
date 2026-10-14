// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { Identity } from "../access/model.ts";
import { shortSeismicGroup } from "../plan/steps.ts";
import type { Member, RoleState, SeismicModel, SubprojectView } from "../seismic/model.ts";
import { isDefaultGroup } from "../seismic/read.ts";
import { type Configured, configuredOf, readTrouble } from "../status/index.ts";
import { type BriefInputs, cellId, readId, type Tone, whoId } from "./index.ts";
import { ageText, limitText, listOf, opening, plural, stampText } from "./words.ts";

export const SHARED = "shared";
export const NO_GRANT = "neither group lists them";

export type Mark = "A" | "V" | "AV" | "A!" | "V!" | "AV!" | "D" | "D*" | "?" | "·";

export interface MatrixColumn {
  name: string;
  inspect: string;
  unread: boolean;
}

export interface MatrixCell {
  id: string;
  column: string;
  mark: Mark;
}

export interface MatrixRow {
  id: string;
  name: string;
  sub: string;
  inspect: string;
  group: "people" | "apps";
  cells: MatrixCell[];
}

export interface CellDetail {
  id: string;
  eyebrow: string;
  title: string;
  state: string;
  tone: Tone;
  path: string[];
  text: string;
  group?: string;
}

export interface Signal {
  text: string;
  tone: Tone;
  inspect?: string;
}

export interface Matrix {
  headline: string;
  signals: Signal[];
  columns: MatrixColumn[];
  shared: string[];
  rows: MatrixRow[];
  details: CellDetail[];
  notes: string[];
  readAt?: string;
}

function members(state: RoleState): Member[] | undefined {
  return state.kind === "members" ? state.members : undefined;
}

// Own-ACL subprojects that hold anyone besides one admin, or that could not be read.
function columnsOf(model: SeismicModel): { columns: SubprojectView[]; folded: SubprojectView[] } {
  const columns: SubprojectView[] = [];
  const folded: SubprojectView[] = [];
  for (const s of model.subprojects) {
    if (s.acl === "default" || s.empty) continue;
    const unread = s.admins.kind === "unread" || s.viewers.kind === "unread";
    const admins = members(s.admins) ?? [];
    const viewers = members(s.viewers) ?? [];
    if (!unread && viewers.length === 0 && admins.length <= 1) folded.push(s);
    else columns.push(s);
  }
  return { columns, folded };
}

function usable(c: Configured): boolean {
  return c.state === "ready" || c.state === "inconsistent";
}

function markOf(s: SubprojectView, id: string, c: Configured): Mark {
  const admin = members(s.admins)?.some((m) => m.id === id) ?? false;
  const viewer = members(s.viewers)?.some((m) => m.id === id) ?? false;
  if (!admin && !viewer) {
    return s.admins.kind === "unread" || s.viewers.kind === "unread" ? "?" : "·";
  }
  const base = admin && viewer ? "AV" : admin ? "A" : "V";
  return usable(c) || c.state === "unmeasured" ? base : (`${base}!` as Mark);
}

function sharedMark(p: Identity | undefined): Mark {
  if (!p?.role) return "·";
  const c = configuredOf(p);
  return usable(c) && p.state !== "pending" ? "D" : "D*";
}

function rowSub(p: Identity | undefined, m: Member, c: Configured): string {
  if (!p) return m.kind === "app" ? "application · no role group" : "no instance access";
  const parts = [p.role ?? "no role"];
  if (p.you) parts.push("you");
  if (c.state === "blocked") parts.push("missing users@");
  if (c.state === "inconsistent" && c.reason === "duplicate") parts.push("listed twice");
  if (p.state === "pending") parts.push("invited");
  return parts.join(" · ");
}

function roleWord(mark: Mark): string {
  const r = mark.replace("!", "");
  return r === "AV" ? "Admin and Viewer" : r === "A" ? "Admin" : "Viewer";
}

function backs(model: SeismicModel, groups: readonly string[], except: string): string {
  const names = model.subprojects
    .filter((s) => [...s.adminGroups, ...s.viewerGroups].some((g) => groups.includes(g)))
    .map((s) => s.name);
  const others = names.filter((n) => n !== except);
  return others.length === 0
    ? `This group backs ${except} only.`
    : `This group also backs ${listOf(others)}, so a change to it reaches further than ${except}.`;
}

function detailOf(
  _i: BriefInputs,
  model: SeismicModel,
  s: SubprojectView,
  name: string,
  id: string,
  mark: Mark,
  readAt: string | undefined,
): CellDetail {
  const cell = cellId(id, s.name);
  const title = `${name} → ${s.name}`;
  const read = readAt ? ` · read ${readAt}` : "";
  if (mark === "?") {
    const unread = [s.admins, s.viewers].find((r) => r.kind === "unread");
    const reason = unread?.kind === "unread" ? unread.reason : "not read";
    return {
      id: cell,
      eyebrow: "not measured",
      title,
      state: "group not read",
      tone: "warn",
      path: [name, `${s.name} groups`, s.name],
      text: `A ${s.name} group could not be read (${reason}), so this cell is unmeasured, not empty. Re-read seismic members from the stamp.`,
    };
  }
  if (mark === "·") {
    return {
      id: cell,
      eyebrow: "no configured grant",
      title,
      state: NO_GRANT,
      tone: "neutral",
      path: [name, s.name],
      text: `Neither ${s.name} group lists ${name}. Grant from the inspector if they need it.`,
    };
  }
  const roleGroups = mark.startsWith("A") ? s.adminGroups : s.viewerGroups;
  const groupLabel = `${s.name} ${mark.startsWith("A") ? "admin" : "viewer"} group`;
  const unusableMark = mark.endsWith("!");
  return {
    id: cell,
    eyebrow: unusableMark ? "configured, unusable" : "configured",
    title,
    state: unusableMark
      ? `${roleWord(mark)} without instance access`
      : `explicit ${roleWord(mark)}`,
    tone: unusableMark ? "warn" : "ok",
    path: [name, groupLabel, s.name],
    text: unusableMark
      ? `The grant is in place, but ${name} holds no users@ or role group, so every call is refused before the subproject is checked.`
      : backs(model, roleGroups, s.name),
    group: `${roleGroups.map(shortSeismicGroup).join(", ")}${read}`,
  };
}

function sharedDetail(
  model: SeismicModel,
  shared: string[],
  p: Identity | undefined,
  name: string,
  id: string,
): CellDetail {
  const mark = sharedMark(p);
  const groups = [
    ...new Set(
      model.subprojects
        .filter((s) => s.acl === "default")
        .flatMap((s) => [...s.adminGroups, ...s.viewerGroups])
        .filter(isDefaultGroup)
        .map((g) => g.split("@")[0] as string),
    ),
  ];
  const title = `${name} → ${listOf(shared)}`;
  if (mark === "·") {
    return {
      id: cellId(id, SHARED),
      eyebrow: "no configured reach",
      title,
      state: "no data role",
      tone: "neutral",
      path: [name, listOf(shared)],
      text: "Only a data role reaches the shared subprojects, and this identity holds none.",
    };
  }
  return {
    id: cellId(id, SHARED),
    eyebrow: mark === "D" ? "default" : "default, not usable yet",
    title,
    state: mark === "D" ? "default data group" : "would reach once instance access works",
    tone: mark === "D" ? "ok" : "warn",
    path: [name, `${p?.role} role`, groups.join(", ") || "data.default", listOf(shared)],
    text:
      mark === "D"
        ? "No explicit grant; reach comes with the data role."
        : "The invitation is pending or users@ is missing, so this reach does not work yet.",
  };
}

function signals(i: BriefInputs): Signal[] {
  const s = i.signals.find((x) => x.area === "seismic");
  if (!s) return [];
  const out: Signal[] = [
    {
      text:
        s.available === "up"
          ? "Seismic Store responding"
          : s.available === "down"
            ? "Seismic Store not responding"
            : "Seismic Store not probed",
      tone: s.available === "down" ? "bad" : "neutral",
    },
  ];
  if (s.completeness?.text) {
    out.push({
      text: `Members ${s.completeness.text}`,
      tone: s.completeness.complete ? "neutral" : "warn",
      inspect: readId("seismic"),
    });
  }
  const trouble = readTrouble(s);
  out.push({
    text: s.at
      ? `Read ${stampText(s.at, i.now)}${s.ageMs !== undefined ? ` · ${ageText(s.ageMs)} ago` : ""}, limit ${limitText(s.limitMs)}`
      : "Not read yet",
    tone: trouble === "stale" || trouble === "failed" ? "warn" : "neutral",
    inspect: readId("seismic"),
  });
  if (s.failed)
    out.push({
      text: `Last read failed: ${s.error ?? "error"}`,
      tone: "bad",
      inspect: readId("seismic"),
    });
  return out;
}

// Person by subproject, from group membership. Rows are identities with an explicit
// grant; columns are own-ACL subprojects, the default-ACL ones folded into Shared.
export function seismicMatrix(i: BriefInputs): Matrix | undefined {
  const model = i.seismic;
  if (!model) return undefined;
  const listed = new Map<string, Identity>();
  for (const p of [...(i.access?.model.people ?? []), ...(i.access?.model.apps ?? [])]) {
    listed.set(p.id, p);
  }
  const { columns, folded } = columnsOf(model);
  const shared = model.subprojects.filter((s) => s.acl === "default").map((s) => s.name);
  const empty = model.subprojects.filter((s) => s.empty).map((s) => s.name);
  const readAt = stampText(i.signals.find((x) => x.area === "seismic")?.at, i.now);
  const rows: MatrixRow[] = [];
  const details: CellDetail[] = [];
  const holders = Object.entries(model.grants)
    .map(([id, grants]) => ({ id, grants, m: model.members[id] }))
    .filter((x): x is { id: string; grants: typeof x.grants; m: Member } =>
      Boolean(x.m && x.grants.length > 0 && x.m.kind !== "group"),
    );
  for (const { id, m } of holders) {
    const p = listed.get(id);
    const c: Configured = i.access ? configuredOf(p) : { state: "unmeasured" };
    const name = m.you ? `${m.name} (you)` : m.name;
    const cells: MatrixCell[] = [];
    if (shared.length > 0) {
      cells.push({ id: cellId(id, SHARED), column: SHARED, mark: sharedMark(p) });
      details.push(sharedDetail(model, shared, p, m.name, id));
    }
    for (const s of columns) {
      const mark = markOf(s, id, c);
      cells.push({ id: cellId(id, s.name), column: s.name, mark });
      details.push(detailOf(i, model, s, m.name, id, mark, readAt));
    }
    rows.push({
      id,
      name,
      sub: rowSub(p, m, c),
      inspect: whoId(id),
      group: m.kind === "app" ? "apps" : "people",
      cells,
    });
  }
  const rank = (r: MatrixRow) => (r.group === "apps" ? 1 : 0);
  rows.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  const notes: string[] = [
    "Cells show configured access from group membership. The audit log shows calls but not which subproject they touched.",
  ];
  if (shared.length > 0) {
    const reach = (i.access?.model.people ?? []).filter(
      (p) => p.role && !model.grants[p.id]?.length,
    ).length;
    notes.push(
      `Shared is ${listOf(shared)}, on the partition's data.default groups. ${opening(reach, "person", "people")} with a data role and no explicit grant reach only those.`,
    );
  }
  for (const s of folded) {
    const admins = members(s.admins) ?? [];
    notes.push(
      admins.length === 1
        ? `${s.name}: ${admins[0]?.name} admin only.`
        : `${s.name}: no viewers and no admin besides the instance.`,
    );
  }
  if (empty.length > 0) notes.push(`${listOf(empty)}: no members.`);
  const people = rows.filter((r) => r.group === "people").length;
  const apps = rows.length - people;
  if (apps > 0)
    notes.push(
      `${plural(apps, "application holds", "applications hold")} grants; they show with Applications.`,
    );
  const partial = model.partial ? "at least " : "";
  const headline =
    rows.length === 0
      ? "Nobody holds an explicit seismic grant."
      : `${capitalized(partial)}${plural(people, "person holds", "people hold")} explicit grants across ${plural(columns.length, "subproject", "subprojects")}.`;
  return {
    headline,
    signals: signals(i),
    columns: columns.map((s) => ({
      name: s.name,
      inspect: `sub:${s.name}`,
      unread: s.admins.kind === "unread" || s.viewers.kind === "unread",
    })),
    shared,
    rows,
    details,
    notes,
    ...(readAt ? { readAt } : {}),
  };
}

function capitalized(s: string): string {
  return s ? `${s[0]?.toUpperCase()}${s.slice(1)}` : s;
}

export const MARK_LEGEND: readonly [Mark, string][] = [
  ["A", "explicit Admin"],
  ["V", "explicit Viewer"],
  ["D", "default data group"],
  ["·", "no configured grant"],
  ["?", "group not read"],
  ["V!", "grant without instance access"],
  ["D*", "default reach, not usable yet"],
];
