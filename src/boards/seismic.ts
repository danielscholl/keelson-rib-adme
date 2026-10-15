// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { CanvasBoardView } from "@keelson/shared";
import { seismicModelOf } from "../brief/inputs.ts";
import { bindingOf } from "../plan/model.ts";
import { EMPTY_BOARD } from "../resting.ts";
import type { Runtime } from "../runtime.ts";
import {
  countSeismic,
  displayOrder,
  type Member,
  type RoleState,
  type SeismicCounts,
  type SeismicModel,
  type SeisRole,
  type SubprojectView,
} from "../seismic/model.ts";
import { SEISMIC_AREA, type SeismicRead } from "../seismic/read.ts";
import { measuredAccess, SELECT_PERSON_ACTION } from "./access.ts";
import { SIGNIN_REASON } from "./connection.ts";
import { fold } from "./map.ts";

type Section = CanvasBoardView["sections"][number];
type Card = Extract<Section, { kind: "cards" }>["items"][number];
type Field = NonNullable<Card["fields"]>[number];
type Person = NonNullable<Field["people"]>[number];
type Tone = NonNullable<Person["tone"]>;
type Row = Extract<Section, { kind: "rows" }>["items"][number];
type Leaf = Extract<Section, { kind: "columns" }>["columns"][number]["sections"][number];
type FlowNode = Extract<Leaf, { kind: "flow" }>["nodes"][number];

export const SEIS_READ_ACTION = "seis-read";
export const SEIS_SELECT_ACTION = "seis-select";
export const PREVIEW_SEIS_GRANT_ACTION = "preview-seismic-grant";
export const PREVIEW_SEIS_REVOKE_ACTION = "preview-seismic-revoke";
export const PREVIEW_SEIS_SELF_ACTION = "preview-seismic-add-self";

export const SEIS_ROLE_OPTIONS = [
  { value: "viewer", label: "Viewer" },
  { value: "admin", label: "Admin" },
];

interface SeismicState {
  selected?: string;
}

const state = new WeakMap<Runtime, SeismicState>();

export function seismicState(rt: Runtime): SeismicState {
  let s = state.get(rt);
  if (!s) {
    s = {};
    state.set(rt, s);
  }
  return s;
}

export interface MeasuredSeismic {
  model: SeismicModel;
  counts: SeismicCounts;
}

export function measuredSeismic(rt: Runtime): MeasuredSeismic | undefined {
  const read = rt.cache.get<SeismicRead>(SEISMIC_AREA).data;
  if (!read || rt.status.phase === "firstrun" || rt.status.phase === "profile-error") {
    return undefined;
  }
  const model = seismicModelOf(rt);
  return model ? { model, counts: countSeismic(model) } : undefined;
}

export function selectedSubproject(rt: Runtime, model: SeismicModel): SubprojectView | undefined {
  const order = displayOrder(model);
  const name = seismicState(rt).selected;
  return order.find((s) => s.name === name) ?? order[0];
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// ---- Subproject cards ----

const ID_TONES: readonly Tone[] = ["id-blue", "id-rose", "id-teal", "id-amber", "id-olive"];

function toneOf(m: Member): Tone {
  if (m.kind !== "person") return "neutral";
  let h = 0;
  for (const ch of m.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return ID_TONES[h % ID_TONES.length] as Tone;
}

const ROLE_WORD: Record<SeisRole, [string, string]> = {
  admin: ["admin", "admins"],
  viewer: ["viewer", "viewers"],
};

function aclPill(s: SubprojectView): NonNullable<Card["pill"]> {
  if (s.acl === "default") return { label: "default ACL", tone: "info" };
  if (s.empty) return { label: "empty", tone: "caution" };
  if (s.admins.kind === "unread" || s.viewers.kind === "unread") {
    return { label: "partial", tone: "warn" };
  }
  return { label: "own ACL", tone: "neutral" };
}

// Who a subproject's groups name; an unread role makes its count "?".
interface Reached {
  members: Member[];
  // The default-ACL group a role comes through, which every data role reaches.
  through?: string;
  unread: boolean;
}

function reachedOf(s: SubprojectView): Reached {
  const members = new Map<string, Member>();
  let through: string | undefined;
  let unread = false;
  // Viewer first, so a default ACL is named by the group that grants reading.
  for (const role of ["viewer", "admin"] as const) {
    const st = role === "admin" ? s.admins : s.viewers;
    if (st.kind === "default") through ??= st.group;
    else if (st.kind === "unread") unread = true;
    else {
      for (const m of st.members) members.set(m.id, m);
    }
  }
  return { members: [...members.values()], ...(through ? { through } : {}), unread };
}

// People who reach a subproject: everyone with a data role through the default ACL.
function reachCount(r: Reached, people: number | undefined): number | null {
  if (r.unread) return null;
  if (r.through) return people ?? null;
  return r.members.length;
}

function reachText(n: number | null): string {
  return n === null ? "? reach it" : n === 1 ? "1 reaches it" : `${n} reach it`;
}

// The flow draws at most six left nodes; fold keeps one more when only one would fold.
export const FLOW_SUBPROJECTS = 5;
export const FLOW_WHO = 8;
const MORE_SUBS = "s:more";
const MORE_WHO = "w:more";

function kindWord(m: Member): string {
  return m.kind === "app" ? "application" : m.kind === "group" ? "group" : "person";
}

function whoFlow(
  ranked: { s: SubprojectView; r: Reached; n: number | null }[],
  people: number | undefined,
  selected: SubprojectView | undefined,
): Leaf | undefined {
  const links: { l: string; r: string; n: number }[] = [];
  const who = new Map<string, { label: string; sub: string }>();
  for (const { s, r } of ranked) {
    // Without a people count the width is unknown, so the default link is left out.
    if (r.through && people !== undefined) {
      const id = `d:${r.through}`;
      who.set(id, { label: "everyone with a data role", sub: `via ${r.through}` });
      links.push({ l: s.name, r: id, n: people });
    }
    for (const m of r.members) {
      who.set(`m:${m.id}`, { label: m.you ? `${m.name} (you)` : m.name, sub: kindWord(m) });
      links.push({ l: s.name, r: `m:${m.id}`, n: 1 });
    }
  }
  if (links.length === 0) return undefined;
  const sum = (side: "l" | "r") => {
    // Every subproject is a candidate, so a selected one with no links still draws and lights.
    const totals = new Map<string, number>(side === "l" ? ranked.map((x) => [x.s.name, 0]) : []);
    for (const link of links) totals.set(link[side], (totals.get(link[side]) ?? 0) + link.n);
    return totals;
  };
  const sel = selected ? ranked.find((x) => x.s.name === selected.name) : undefined;
  const selWho = new Set(
    sel
      ? [...(sel.r.through ? [`d:${sel.r.through}`] : []), ...sel.r.members.map((m) => `m:${m.id}`)]
      : [],
  );
  const left = fold(sum("l"), FLOW_SUBPROJECTS, new Set(sel ? [sel.s.name] : []));
  const defaults = [...who.keys()].filter((k) => k.startsWith("d:"));
  const keepWho = new Set([...defaults, ...selWho]);
  // The right side has no node limit, so it grows to keep every selected member lit.
  const right = fold(sum("r"), Math.max(FLOW_WHO, keepWho.size), keepWho);
  const subs = new Map(ranked.map((x) => [x.s.name, x]));
  const drawn = sum("l");
  const reaches = sum("r");
  const nodes: FlowNode[] = [
    ...left.kept.map((k): FlowNode => {
      const x = subs.get(k);
      const sub = x?.r.through ? "default ACL" : reachText(x?.n ?? null);
      return {
        id: `s:${k}`,
        side: "left",
        label: k,
        sublabel: sub,
        ...(k === sel?.s.name ? { selected: true } : {}),
      };
    }),
    ...(left.folded.length > 0
      ? [
          {
            id: MORE_SUBS,
            side: "left" as const,
            label: `${left.folded.length} more subprojects`,
            folded: left.folded.map((k) => ({ label: k, n: drawn.get(k) ?? 0 })),
          },
        ]
      : []),
    ...right.kept.map((k): FlowNode => {
      const w = who.get(k);
      const n = reaches.get(k) ?? 0;
      return {
        id: k,
        side: "right",
        label: w?.label ?? k,
        sublabel: k.startsWith("d:")
          ? (w?.sub ?? "")
          : `${w?.sub ?? ""} · ${plural(n, "subproject", "subprojects")}`,
        ...(selWho.has(k) ? { selected: true } : {}),
      };
    }),
    ...(right.folded.length > 0
      ? [
          {
            id: MORE_WHO,
            side: "right" as const,
            label: `${right.folded.length} more`,
            folded: right.folded.map((k) => ({
              label: who.get(k)?.label ?? k,
              n: reaches.get(k) ?? 0,
            })),
          },
        ]
      : []),
  ];
  const lSet = new Set(left.kept);
  const rSet = new Set(right.kept);
  const merged = new Map<string, { source: string; target: string; n: number }>();
  for (const link of links) {
    const source = lSet.has(link.l) ? `s:${link.l}` : MORE_SUBS;
    const target = rSet.has(link.r) ? link.r : MORE_WHO;
    const key = `${source}\u0000${target}`;
    const at = merged.get(key);
    if (at) at.n += link.n;
    else merged.set(key, { source, target, n: link.n });
  }
  return {
    kind: "flow",
    title: "Who reaches seismic · subproject to people and applications",
    left: "Subproject",
    right: "Who",
    nodes,
    links: [...merged.values()].sort((a, b) => b.n - a.n),
  };
}

// The flow from the selected subproject to who reaches it, for its inspector.
export function selectedFlow(rt: Runtime): Leaf | undefined {
  const measured = measuredSeismic(rt);
  if (!measured) return undefined;
  const selected = selectedSubproject(rt, measured.model);
  const people = measuredAccess(rt)?.counts.people;
  const ranked = displayOrder(measured.model)
    .map((s, i) => {
      const r = reachedOf(s);
      return { s, r, n: reachCount(r, people), i };
    })
    .sort((a, b) => (b.n ?? -1) - (a.n ?? -1) || a.i - b.i);
  return whoFlow(ranked, people, selected);
}

// ---- The selected subproject ----

function domainOf(m: Member): string | undefined {
  return m.email?.split("@")[1];
}

function memberRow(m: Member): Row {
  const trailing =
    m.kind === "app" ? "application" : m.kind === "group" ? "group" : (domainOf(m) ?? m.id);
  return {
    glyph: toneOf(m),
    text: m.you ? `${m.name} (you)` : m.name,
    trailing,
    ...(m.kind === "person" || m.kind === "app"
      ? { action: { type: SELECT_PERSON_ACTION, payload: { id: m.id } } }
      : {}),
  };
}

function roleRows(
  role: SeisRole,
  s: RoleState,
  people: number | undefined,
): Extract<Section, { kind: "rows" }> {
  const [, many] = ROLE_WORD[role];
  const title = many[0]?.toUpperCase() + many.slice(1);
  if (s.kind === "default") {
    const who =
      role === "viewer"
        ? people === undefined
          ? "everyone with a data role"
          : `all ${people} people with a data role`
        : "data admins";
    return {
      kind: "rows",
      title,
      items: [{ glyph: "info", text: who, trailing: `via ${s.group}` }],
    };
  }
  if (s.kind === "unread") {
    return {
      kind: "rows",
      title: `${title} · ?`,
      items: [
        { glyph: "warn", text: `Not read: ${s.reason}` },
        ...(s.you
          ? [{ glyph: "info" as const, text: "You are a member (from your own groups)" }]
          : []),
      ],
    };
  }
  return {
    kind: "rows",
    title: `${title} · ${s.members.length}`,
    items: s.members.length > 0 ? s.members.map(memberRow) : [{ glyph: "neutral", text: "none" }],
  };
}

function roleCount(role: SeisRole, s: RoleState): string {
  const [one, many] = ROLE_WORD[role];
  if (s.kind === "members") return plural(s.members.length, one, many);
  if (s.kind === "default") return `${many} via ${s.group}`;
  return `${many} ?`;
}

function isAdmin(s: RoleState): boolean {
  if (s.kind === "members") return s.members.some((m) => m.you);
  return s.kind === "unread" && s.you;
}

function selectedActions(rt: Runtime, s: SubprojectView): Section | undefined {
  const profile = rt.profile;
  const access = measuredAccess(rt);
  if (!profile || !access) return undefined;
  const binding = { ...bindingOf(profile), subproject: s.name };
  const signedOut = rt.status.phase !== "connected";
  const people = access.model.people.map((p) => ({ value: p.id, label: p.name }));
  const you = access.model.people.find((p) => p.you);
  const grantReason = signedOut
    ? SIGNIN_REASON
    : s.admins.kind === "default" && s.viewers.kind === "default"
      ? "this subproject is on the default ACL"
      : people.length === 0
        ? "nobody has entitlements"
        : undefined;
  const selfReason = signedOut
    ? SIGNIN_REASON
    : s.admins.kind === "default"
      ? `admins come through ${s.admins.group}`
      : isAdmin(s.admins)
        ? "you are already an admin"
        : !you
          ? "you are not in the last sweep"
          : undefined;
  return {
    kind: "actions",
    wrap: true,
    items: [
      {
        type: PREVIEW_SEIS_GRANT_ACTION,
        label: "Grant access…",
        submitLabel: "Preview plan",
        submitTone: "brand",
        pendingLabel: "Planning…",
        binding,
        fields: [
          people.length > 0
            ? { name: "id", label: "Person", options: people, required: true }
            : { name: "id", label: "Person", placeholder: "nobody has entitlements" },
          {
            name: "role",
            label: "Role",
            options: SEIS_ROLE_OPTIONS,
            segmented: true,
            required: true,
            defaultValue: "viewer",
          },
        ],
        ...(grantReason ? { disabled: true, reason: grantReason } : {}),
      },
      {
        type: PREVIEW_SEIS_SELF_ACTION,
        label: "Add myself as admin",
        pendingLabel: "Planning…",
        binding,
        ...(selfReason ? { disabled: true, reason: selfReason } : {}),
      },
    ],
  };
}

export function composeSeismicSelected(rt: Runtime): CanvasBoardView {
  const measured = measuredSeismic(rt);
  if (!measured) return EMPTY_BOARD;
  const s = selectedSubproject(rt, measured.model);
  if (!s) return EMPTY_BOARD;
  const people = measuredAccess(rt)?.counts.people;
  const fields: Field[] = [{ label: "sd path", value: s.path, copyable: true }];
  for (const g of s.adminGroups) fields.push({ label: "admin group", value: g, copyable: true });
  for (const g of s.viewerGroups) fields.push({ label: "viewer group", value: g, copyable: true });
  if (s.legalTag) fields.push({ label: "legal tag", value: s.legalTag, copyable: true });
  if (s.accessPolicy) fields.push({ label: "access policy", value: s.accessPolicy });
  const actions = selectedActions(rt, s);
  return {
    view: "board",
    title: s.name,
    header: {
      status: {
        label: `${roleCount("admin", s.admins)} · ${roleCount("viewer", s.viewers)}`,
        tone: "neutral",
      },
      chip: s.path,
    },
    sections: [
      {
        kind: "columns",
        columns: [
          {
            weight: 1,
            sections: [
              {
                kind: "cards",
                title: "Identifiers",
                boxed: true,
                items: [{ title: s.name, mono: true, pill: aclPill(s), fields }],
              },
            ],
          },
          {
            weight: 1,
            sections: [roleRows("admin", s.admins, people), roleRows("viewer", s.viewers, people)],
          },
        ],
      },
      ...(actions ? [actions] : []),
    ],
  };
}
