// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { CanvasBoardView } from "@keelson/shared";
import { ACCESS_AREA, type AccessRead } from "../access/read.ts";
import { SERVICES_AREA, type ServiceProbe } from "../data/areas.ts";
import { bindingOf } from "../plan/model.ts";
import { instanceName } from "../profile.ts";
import { EMPTY_BOARD } from "../resting.ts";
import type { Runtime } from "../runtime.ts";
import {
  buildSeismic,
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
import { phasePill, SIGNIN_REASON, signinCard } from "./connection.ts";

type Section = CanvasBoardView["sections"][number];
type Stat = Extract<Section, { kind: "stats" }>["items"][number];
type Card = Extract<Section, { kind: "cards" }>["items"][number];
type Field = NonNullable<Card["fields"]>[number];
type Person = NonNullable<Field["people"]>[number];
type Tone = NonNullable<Person["tone"]>;
type Row = Extract<Section, { kind: "rows" }>["items"][number];

export const SEIS_READ_ACTION = "seis-read";
export const SEIS_REFRESH_ACTION = "seis-refresh";
export const SEIS_SELECT_ACTION = "seis-select";
export const SEIS_REACH_ACTION = "seis-reach";
export const PREVIEW_SEIS_GRANT_ACTION = "preview-seismic-grant";
export const PREVIEW_SEIS_REVOKE_ACTION = "preview-seismic-revoke";
export const PREVIEW_SEIS_COPY_ACTION = "preview-seismic-copy";
export const PREVIEW_SEIS_SELF_ACTION = "preview-seismic-add-self";

export const SEIS_ROLE_OPTIONS = [
  { value: "viewer", label: "Viewer" },
  { value: "admin", label: "Admin" },
];

interface SeismicState {
  selected?: string;
  // The person "What a partner can reach" shows.
  reach?: string;
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
  const model = buildSeismic(read, {
    directory: rt.cache.get<AccessRead>(ACCESS_AREA).data?.directory,
    signedInAs: rt.status.test?.signedInAs,
    admeAppId: rt.profile?.admeAppId,
  });
  return { model, counts: countSeismic(model) };
}

// Own-ACL subprojects a person can be granted on, for a select; empty before the store is read.
export function grantableSubprojects(rt: Runtime): { value: string; label: string }[] {
  const measured = measuredSeismic(rt);
  if (!measured) return [];
  return displayOrder(measured.model)
    .filter((s) => s.acl === "own")
    .map((s) => ({ value: s.name, label: s.name }));
}

export function selectedSubproject(rt: Runtime, model: SeismicModel): SubprojectView | undefined {
  const order = displayOrder(model);
  const name = seismicState(rt).selected;
  return order.find((s) => s.name === name) ?? order[0];
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function unmeasured(label: string, sub = "not measured"): Stat {
  return { label, value: null, sub };
}

const UNMEASURED_TILES = ["Subprojects", "People with grants", "On default ACL", "No members"];

function serviceText(rt: Runtime): { text: string; ok: boolean } {
  const probes = rt.cache.get<ServiceProbe[]>(SERVICES_AREA).data;
  const seismic = probes?.find((p) => p.service === "seismic");
  if (!seismic || seismic.state === "unprobed") return { text: "service ?", ok: true };
  if (seismic.state === "ok") return { text: "service ok", ok: true };
  return { text: `service ${seismic.status ?? "error"}`, ok: false };
}

function chip(rt: Runtime): string | undefined {
  const partition = rt.profile?.partition;
  if (!partition) return undefined;
  return `sd://${partition} · ${rt.freshness(SEISMIC_AREA) ?? "not measured yet"}`;
}

function names(list: readonly string[]): string {
  if (list.length === 0) return "none";
  return list.length <= 3
    ? list.join(", ")
    : `${list.slice(0, 2).join(", ")} and ${list.length - 2} more`;
}

function tiles(rt: Runtime, m: MeasuredSeismic): Section {
  const { counts, model } = m;
  const people = measuredAccess(rt)?.counts.people;
  const items: Stat[] = [
    {
      label: "Subprojects",
      value: counts.subprojects,
      sub: `${counts.own} own ACL, ${counts.defaults.length} default`,
    },
    {
      label: "People with grants",
      value: counts.peopleWithGrants,
      sub: [
        people === undefined ? "people not measured" : `of ${people} people`,
        ...(model.partial ? ["at least, partial read"] : []),
      ].join(" · "),
    },
    { label: "On default ACL", value: counts.defaults.length, sub: names(counts.defaults) },
    {
      label: "No members",
      value: counts.empty.length,
      sub: names(counts.empty),
      ...(counts.empty.length > 0 ? { tone: "caution" as const } : {}),
    },
  ];
  return { kind: "stats", items };
}

function partialRow(model: SeismicModel): Row | undefined {
  if (model.source === "own-groups") {
    return {
      glyph: "warn",
      text: "Listing subprojects was refused, so these come from your own data.sdms groups and may be incomplete.",
    };
  }
  if (model.unreadGroups > 0) {
    return {
      glyph: "warn",
      text: `Members of ${plural(model.unreadGroups, "role", "roles")} could not be read; those show as ?.`,
    };
  }
  return undefined;
}

export function composeSeismicPulse(rt: Runtime): CanvasBoardView {
  const phase = rt.status.phase;
  if (phase === "firstrun" || phase === "profile-error") {
    return {
      view: "board",
      header: {
        status: {
          label: "not connected, finish the steps on the ADME Access tab",
          tone: "neutral",
        },
      },
      sections: [{ kind: "stats", items: UNMEASURED_TILES.map((l) => unmeasured(l)) }],
    };
  }
  const c = chip(rt);
  const measured = measuredSeismic(rt);
  const error = rt.cache.get(SEISMIC_AREA).error;
  const sections: Section[] = [];
  if (phase === "signin") sections.push(signinCard(rt.status));
  if (!measured) {
    sections.push({ kind: "stats", items: UNMEASURED_TILES.map((l) => unmeasured(l)) });
    if (phase === "connected") {
      sections.push({
        kind: "rows",
        items: [
          error
            ? { glyph: "error", text: `Subprojects could not be read: ${error}` }
            : {
                glyph: "neutral",
                text: "This tab reads seismic subprojects and their members on first use, not on every sweep.",
              },
        ],
      });
      sections.push({
        kind: "actions",
        items: [
          {
            type: SEIS_READ_ACTION,
            label: error ? "Try again" : "Read subprojects",
            tone: "brand",
            pendingLabel: "Reading…",
          },
        ],
      });
    }
    return {
      view: "board",
      header: {
        status:
          phase === "signin"
            ? phasePill(rt.status)
            : { label: "not measured yet", tone: "neutral" },
        ...(c ? { chip: c } : {}),
      },
      sections,
    };
  }
  const service = serviceText(rt);
  const { model, counts } = measured;
  sections.push(tiles(rt, measured));
  const notes: Row[] = [];
  const partial = partialRow(model);
  if (partial) notes.push(partial);
  if (error) notes.push({ glyph: "error", text: `The last read failed: ${error}` });
  if (notes.length > 0) sections.push({ kind: "rows", items: notes });
  const status =
    phase === "signin"
      ? phasePill(rt.status)
      : {
          label: `${plural(counts.subprojects, "subproject", "subprojects")} · ${service.text}`,
          tone: service.ok && !model.partial ? ("ok" as const) : ("caution" as const),
        };
  return { view: "board", header: { status, ...(c ? { chip: c } : {}) }, sections };
}

// ---- Subproject cards ----

const ID_TONES: readonly Tone[] = ["id-blue", "id-rose", "id-teal", "id-amber", "id-olive"];

function toneOf(m: Member): Tone {
  if (m.kind !== "person") return "neutral";
  let h = 0;
  for (const ch of m.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return ID_TONES[h % ID_TONES.length] as Tone;
}

function shortName(m: Member, prefix: string | undefined): string {
  if (m.kind === "person") return (m.name.split(/\s+/)[0] ?? m.name).toLowerCase();
  if (m.kind === "app" && prefix && m.name.startsWith(`${prefix}-`)) {
    return m.name.slice(prefix.length + 1);
  }
  return m.name;
}

const ROLE_WORD: Record<SeisRole, [string, string]> = {
  admin: ["admin", "admins"],
  viewer: ["viewer", "viewers"],
};

function roleField(role: SeisRole, s: RoleState, prefix: string | undefined): Field {
  const [one, many] = ROLE_WORD[role];
  if (s.kind === "default") return { label: many, value: `through ${s.group}` };
  if (s.kind === "unread") return { label: many, value: s.you ? "? (you are one)" : null };
  const n = s.members.length;
  const label = plural(n, one, many);
  if (n === 0) return { label, value: "none" };
  const shown = n <= 3 ? s.members : s.members.slice(0, 2);
  const people: Person[] = shown.map((m) => ({ name: shortName(m, prefix), tone: toneOf(m) }));
  if (n > 3) people.push({ name: `${n - 2} more`, tone: "neutral" });
  return { label, people };
}

function aclPill(s: SubprojectView): NonNullable<Card["pill"]> {
  if (s.acl === "default") return { label: "default ACL", tone: "info" };
  if (s.empty) return { label: "empty", tone: "caution" };
  if (s.admins.kind === "unread" || s.viewers.kind === "unread") {
    return { label: "partial", tone: "warn" };
  }
  return { label: "own ACL", tone: "neutral" };
}

function legalValue(s: SubprojectView, model: SeismicModel): string | null {
  return s.legalTag ?? (model.source === "list" ? "none" : null);
}

function subprojectCard(
  s: SubprojectView,
  model: SeismicModel,
  people: number | undefined,
  prefix: string | undefined,
  selected: boolean,
): Card {
  const fields: Field[] = [];
  if (s.acl === "default" && s.admins.kind === "default" && s.viewers.kind === "default") {
    fields.push({
      label: "Members",
      value: people === undefined ? "everyone with a data role" : `all ${people} people`,
    });
    fields.push({ label: "ACL", value: s.viewers.group });
  } else {
    fields.push(roleField("admin", s.admins, prefix), roleField("viewer", s.viewers, prefix));
  }
  fields.push(
    { label: "Legal tag", value: legalValue(s, model) },
    { label: "Datasets", value: null },
  );
  return {
    title: s.name,
    mono: true,
    stacked: true,
    pill: aclPill(s),
    ...(s.empty
      ? {
          edge: "caution" as const,
          reason: { label: "Why flagged", text: "no members; looks abandoned." },
        }
      : {}),
    fields,
    action: { type: SEIS_SELECT_ACTION, payload: { subproject: s.name } },
    selected,
  };
}

function prefixOf(rt: Runtime): string | undefined {
  return rt.profile ? instanceName(rt.profile) : undefined;
}

export function composeSeismicSubprojects(rt: Runtime): CanvasBoardView {
  const measured = measuredSeismic(rt);
  if (!measured) return EMPTY_BOARD;
  const { model } = measured;
  const order = displayOrder(model);
  if (order.length === 0) {
    return {
      view: "board",
      header: { status: { label: "0 subprojects", tone: "neutral" } },
      sections: [
        { kind: "rows", items: [{ glyph: "neutral", text: "No subprojects in this tenant." }] },
      ],
    };
  }
  const selected = selectedSubproject(rt, model);
  const people = measuredAccess(rt)?.counts.people;
  const prefix = prefixOf(rt);
  return {
    view: "board",
    header: {
      status: { label: `${order.length} of ${order.length}`, tone: "neutral" },
      ...(selected ? { chip: `selected: ${selected.name}` } : {}),
    },
    sections: [
      {
        kind: "cards",
        grid: true,
        columns: 4,
        items: order.map((s) =>
          subprojectCard(s, model, people, prefix, s.name === selected?.name),
        ),
      },
    ],
  };
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
