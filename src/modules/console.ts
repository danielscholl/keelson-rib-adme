// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { CanvasActionItem, CanvasBoardView, RibActionResult } from "@keelson/shared";
import { measuredAccess } from "../access/measured.ts";
import { SIGNIN_REASON } from "../boards/connection.ts";
import {
  COHORTS_ID,
  CONNECTION_ID,
  CONSOLE_MAX_BYTES,
  consoleHtml,
  PANE_LIMIT,
} from "../boards/console.ts";
import { dataTab, FIND_ID } from "../boards/console-data.ts";
import { seismicTab } from "../boards/console-seismic.ts";
import { EXPLAIN_ACTION } from "../boards/explain.ts";
import {
  ANNOTATE_ACTION,
  annotateForm,
  type CellView,
  composeCell,
  composeIdentity,
  composeItem,
  composeRead,
  composeTag,
  type ItemVerbs,
  openAction,
  REREAD_ACTION,
  rereadAction,
} from "../boards/inspect.ts";
import { unresolvedUsers } from "../boards/record.ts";
import {
  composeSeismicSelected,
  PREVIEW_SEIS_GRANT_ACTION,
  PREVIEW_SEIS_REVOKE_ACTION,
  seismicState,
  selectedFlow,
} from "../boards/seismic.ts";
import { dataBrief, familiesOf } from "../brief/data.ts";
import { type Brief, type BriefInputs, buildBrief, type Fact, type Item } from "../brief/index.ts";
import { briefInputs } from "../brief/inputs.ts";
import { peopleRows } from "../brief/people.ts";
import { SHARED, seismicMatrix } from "../brief/seismic.ts";
import { annotationInputSchema } from "../directory/annotations.ts";
import { COHORTS_KEY, CONNECTION_KEY, INSPECT_KEY } from "../keys.ts";
import { bindingOf, sameBinding } from "../plan/model.ts";
import { coverage } from "../plan/seismic.ts";
import type { ActionHandler, RegionModule } from "../region.ts";
import { EMPTY_BOARD } from "../resting.ts";
import type { Runtime } from "../runtime.ts";
import { isDefaultGroup } from "../seismic/read.ts";
import { configuredOf, READ_AREAS, type ReadArea } from "../status/index.ts";
import { INSPECT_ACTION } from "../surfaces.ts";
import { selectPersonAction } from "./access.ts";
import { loadSearch, openRecords } from "./records.ts";
import { measureSeismic } from "./seismic.ts";

interface InspectState {
  selected?: string;
}

const states = new WeakMap<Runtime, InspectState>();

export function inspectState(rt: Runtime): InspectState {
  let s = states.get(rt);
  if (!s) {
    s = {};
    states.set(rt, s);
  }
  return s;
}

type Payload = Record<string, unknown>;

function asPayload(payload: unknown): Payload {
  return payload && typeof payload === "object" ? (payload as Payload) : {};
}

function str(p: Payload, key: string): string | undefined {
  const v = p[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

// A large directory gives up inline profile panes before the frame passes its limit.
export function composeConsole(rt: Runtime): string {
  const inputs = briefInputs(rt);
  const brief = buildBrief(inputs);
  const matrix = seismicMatrix(inputs);
  const data = dataTab(dataBrief(inputs, brief.stewardship ?? []));
  const base = { brief, people: peopleRows(inputs), cohorts: rt.tracker.cohorts.length };
  const steps = [
    { panes: PANE_LIMIT, compact: false },
    { panes: 20, compact: false },
    { panes: 0, compact: false },
    { panes: 0, compact: true },
  ];
  let html = "";
  for (const { panes, compact } of steps) {
    html = consoleHtml({
      ...base,
      panes,
      tabs: [
        { id: "seismic", label: "Seismic", html: seismicTab(matrix, compact) },
        { id: "data", label: "Data", html: data },
      ],
    });
    if (new TextEncoder().encode(html).byteLength <= CONSOLE_MAX_BYTES) break;
  }
  return html;
}

export const BROWSE_FAMILY_ACTION = "browse-family";

function composeFamily(i: BriefInputs, key: string): CanvasBoardView | undefined {
  const f = familiesOf(i).find((x) => x.key === key);
  if (!f) return undefined;
  return {
    view: "board",
    header: {
      status: { label: `${f.count.toLocaleString("en-US")} records`, tone: "neutral" },
      chip: f.pattern,
    },
    sections: [
      {
        kind: "rows",
        title: `Kinds · ${f.kinds.length} · indexed, visible to this sign-in`,
        items: f.kinds.map((k) => ({
          glyph: "neutral" as const,
          text: k.kind,
          trailing: k.count.toLocaleString("en-US"),
        })),
      },
      {
        kind: "rows",
        items: [
          {
            text: `${f.versions} ${f.versions === 1 ? "version" : "versions"} from ${f.authorities.join(", ")}. A family is a kind's entity name, so versions and authorities add together.`,
          },
        ],
      },
      {
        kind: "actions",
        items: [
          {
            type: BROWSE_FAMILY_ACTION,
            label: "Browse records",
            payload: { family: f.key },
            pendingLabel: "Searching…",
          },
        ],
      },
    ],
  };
}

function binding(rt: Runtime) {
  return rt.profile ? bindingOf(rt.profile) : undefined;
}

function itemVerbs(rt: Runtime, i: BriefInputs, item: Item): ItemVerbs {
  const signedOut = rt.status.phase !== "connected";
  const gate = signedOut ? { disabled: true, reason: SIGNIN_REASON } : {};
  const bound = binding(rt);
  const id = item.subject?.startsWith("who:")
    ? item.subject.slice(4)
    : item.subject?.startsWith("cell:")
      ? (item.subject.split(":")[1] as string)
      : undefined;
  switch (item.cls) {
    case "BLOCKED":
    case "INCONSISTENT":
      return id && i.access?.model.people.some((p) => p.id === id)
        ? {
            verbs: [
              {
                type: EXPLAIN_ACTION,
                label: "Why 401/403",
                payload: { id },
                ...(bound ? { binding: { ...bound } } : {}),
              },
            ],
          }
        : { verbs: [] };
    case "IDENTITY": {
      if (!id) return { verbs: [] };
      const key = i.directory.keyFor(id);
      return {
        verbs: [],
        form: annotateForm(id, rt.annotations.get(key), bound, { labelFirst: true }),
      };
    }
    case "GRANT": {
      const grants = id ? (i.seismic?.grants[id] ?? []) : [];
      return {
        verbs: grants.map(
          (g): CanvasActionItem => ({
            type: PREVIEW_SEIS_REVOKE_ACTION,
            label: `Preview revoke · ${g.role} on ${g.subproject}`,
            payload: { id, subproject: g.subproject, role: g.role },
            ...(bound ? { binding: { ...bound } } : {}),
            pendingLabel: "Planning…",
            ...gate,
          }),
        ),
      };
    }
    case "READ": {
      const area = item.subject?.slice(5) as ReadArea | undefined;
      const s = i.signals.find((x) => x.area === area);
      return area && s
        ? { verbs: [rereadAction(area, `Re-read ${s.label.toLowerCase()}`, s.cost, signedOut)] }
        : { verbs: [] };
    }
    default:
      return { verbs: [] };
  }
}

function cellView(rt: Runtime, i: BriefInputs, id: string, sub: string): CellView | undefined {
  const model = i.seismic;
  const member = model?.members[id];
  const listed = i.access?.model;
  const p = listed ? [...listed.people, ...listed.apps].find((x) => x.id === id) : undefined;
  const name = member?.name ?? p?.name;
  if (!model || !name) return undefined;
  const bound = binding(rt);
  const signedOut = rt.status.phase !== "connected";
  const gate = signedOut ? { disabled: true, reason: SIGNIN_REASON } : {};
  const who: Fact = { label: "Identity", value: name, source: "directory", tone: "neutral" };
  if (sub === SHARED) {
    const shared = model.subprojects.filter((s) => s.acl === "default");
    const groups = [
      ...new Set(
        shared.flatMap((s) => [...s.adminGroups, ...s.viewerGroups]).filter(isDefaultGroup),
      ),
    ];
    return {
      title: `${name} → ${shared.map((s) => s.name).join(", ")}`,
      status: p?.role
        ? { label: "default", tone: "ok" }
        : { label: "no data role", tone: "neutral" },
      facts: [
        who,
        { label: "Data role", value: p?.role ?? "none", source: "instance", tone: "neutral" },
        {
          label: "Default groups",
          value: groups.join(", ") || "none",
          source: "instance",
          tone: "neutral",
        },
      ],
      backs: shared.map((s) => s.name),
      text: "Reach to these subprojects comes with the data role through the partition's data.default groups. Changing a default group would change every default-ACL subproject at once, so the rib does not plan it.",
      verbs: [openAction(`who:${id}`, "Open identity")],
    };
  }
  const s = model.subprojects.find((x) => x.name === sub);
  if (!s || s.acl === "default") return undefined;
  const held = (model.grants[id] ?? []).filter((g) => g.subproject === sub).map((g) => g.role);
  const unread = s.admins.kind === "unread" || s.viewers.kind === "unread";
  const c = i.access ? configuredOf(p) : undefined;
  const usable = c?.state === "ready" || c?.state === "inconsistent";
  const groups = [...s.adminGroups, ...s.viewerGroups].filter((g) => !isDefaultGroup(g));
  const cover = coverage(model);
  const backs = [...new Set(groups.flatMap((g) => cover.get(g) ?? []))];
  const facts: Fact[] = [
    who,
    {
      label: "Grant",
      value:
        held.length > 0
          ? held.map((r) => (r === "admin" ? "Admin" : "Viewer")).join(" and ")
          : unread && held.length === 0
            ? "not measured"
            : "none",
      source: "instance",
      tone: held.length > 0 ? (usable ? "ok" : "warn") : unread ? "warn" : "neutral",
    },
    ...s.adminGroups.map((g) => ({
      label: "Admin group",
      value: g,
      source: "instance" as const,
      tone: "neutral" as const,
    })),
    ...s.viewerGroups.map((g) => ({
      label: "Viewer group",
      value: g,
      source: "instance" as const,
      tone: "neutral" as const,
    })),
    {
      label: "Instance access",
      value: !c
        ? "not measured"
        : usable
          ? `${p?.role} with users@`
          : c.state === "blocked"
            ? "missing users@"
            : "no users@ or role",
      source: "instance",
      tone: usable ? "ok" : "warn",
    },
  ];
  const preview = (
    type: string,
    role: "admin" | "viewer",
    label: string,
    refused?: string,
  ): CanvasActionItem => ({
    type,
    label,
    payload: { id, subproject: sub, role },
    ...(bound ? { binding: { ...bound } } : {}),
    pendingLabel: "Planning…",
    ...gate,
    ...(refused && !signedOut ? { disabled: true, reason: refused } : {}),
  });
  const noAccess =
    c && !usable
      ? `${name} holds no usable instance access, so a grant could not be used`
      : undefined;
  const verbs: CanvasActionItem[] = [
    ...held.map((r) => preview(PREVIEW_SEIS_REVOKE_ACTION, r, `Preview revoke · ${r} on ${sub}`)),
    ...(["viewer", "admin"] as const)
      .filter((r) => !held.includes(r))
      .map((r) =>
        preview(PREVIEW_SEIS_GRANT_ACTION, r, `Preview grant · ${r} on ${sub}`, noAccess),
      ),
    ...(unread
      ? [rereadAction("seismic", "Re-read seismic members", "one call per group", signedOut)]
      : []),
    openAction(`who:${id}`, "Open identity"),
    openAction(`sub:${sub}`, `Open ${sub}`),
  ];
  const status: CellView["status"] =
    held.length > 0
      ? usable || !c
        ? { label: "configured", tone: "ok" }
        : { label: "configured, unusable", tone: "warn" }
      : unread
        ? { label: "not measured", tone: "warn" }
        : { label: "no configured grant", tone: "neutral" };
  return {
    title: `${name} → ${sub}`,
    status,
    facts,
    backs,
    text:
      backs.length > 1
        ? `These groups back ${backs.join(", ")}, so a change reaches all of them. Cells change only when the next read sees the new membership.`
        : "Cells change only when the next read sees the new membership.",
    verbs,
  };
}

function gone(text: string): CanvasBoardView {
  return { view: "board", sections: [{ kind: "rows", items: [{ glyph: "neutral", text }] }] };
}

function tagUse(i: BriefInputs, name: string) {
  const subs = (i.seismic?.subprojects ?? []).filter((s) => s.legalTag === name);
  const counts = i.tagCounts;
  return {
    subprojects: subs.filter((s) => !s.empty).map((s) => s.name),
    empty: subs.filter((s) => s.empty).map((s) => s.name),
    records: counts ? (counts.find((b) => b.key === name)?.count ?? 0) : null,
  };
}

export function composeInspect(rt: Runtime): CanvasBoardView {
  const sel = inspectState(rt).selected;
  if (!sel) return EMPTY_BOARD;
  const inputs = briefInputs(rt);
  const brief: Brief = buildBrief(inputs);
  const now = rt.now();
  if (sel.startsWith("item:")) {
    const item = [...brief.items, ...(brief.stewardship ?? [])].find((x) => x.id === sel);
    if (!item)
      return gone("This item has cleared since it was opened. The console shows what is left.");
    return composeItem(item, itemVerbs(rt, inputs, item));
  }
  if (sel.startsWith("read:")) {
    return (
      composeRead(brief, sel.slice(5) as ReadArea, now, rt.status.phase !== "connected") ??
      gone("That read is not part of this rib.")
    );
  }
  if (sel.startsWith("tag:")) {
    const name = sel.slice(4);
    return (
      composeTag(brief, inputs.legal, name, tagUse(inputs, name), now) ??
      gone("That legal tag is no longer listed.")
    );
  }
  if (sel.startsWith("fam:")) {
    return composeFamily(inputs, sel.slice(4)) ?? gone("That record family is no longer counted.");
  }
  if (sel.startsWith("cell:")) {
    const [, id, sub] = sel.split(":");
    const v = id && sub ? cellView(rt, inputs, id, sub) : undefined;
    return v ? composeCell(v) : gone("That cell is no longer in the matrix.");
  }
  if (sel.startsWith("sub:")) {
    const selected = composeSeismicSelected(rt);
    if (selected.view !== "board" || selected.sections.length === 0) {
      return gone("That subproject is no longer listed.");
    }
    const flow = selectedFlow(rt);
    return { ...selected, sections: [...selected.sections, ...(flow ? [flow] : [])] };
  }
  if (sel.startsWith("who:")) {
    const id = sel.slice(4);
    const row = peopleRows(inputs).find((r) => r.id === id);
    if (!row) return gone("That identity is not in the last read.");
    const key = inputs.directory.keyFor(id);
    return composeIdentity(row, rt.annotations.get(key), binding(rt), []);
  }
  return gone("Nothing is selected.");
}

function open(key: string, title: string): RibActionResult {
  return { ok: true, data: { effect: "open-canvas", key, title, placement: "side" } };
}

// Every id the rib could name: listed by entitlements or a seismic group, in the
// directory, or a creator of the record open in the drawer.
function knownId(rt: Runtime, i: BriefInputs, id: string): boolean {
  if (unresolvedUsers(rt).includes(id)) return true;
  const a = i.access?.model;
  if (a && [...a.people, ...a.apps, ...a.unknown].some((p) => p.id === id)) return true;
  if (i.seismic?.members[id]) return true;
  return i.directory.entry(id) !== undefined;
}

const inspectAction: ActionHandler = async (rt, payload) => {
  const id = str(asPayload(payload), "id");
  if (!id) return { ok: false, error: "inspect payload must be { id: string }" };
  if (id === CONNECTION_ID) return open(CONNECTION_KEY, "Connection");
  if (id === COHORTS_ID) return open(COHORTS_KEY, "Cohorts");
  if (id === FIND_ID) return openRecords();
  const inputs = briefInputs(rt);
  if (id.startsWith("who:")) {
    const target = id.slice(4).toLowerCase();
    const listed = measuredAccess(rt)?.model;
    if (listed && [...listed.people, ...listed.apps].some((p) => p.id === target)) {
      return selectPersonAction(rt, { id: target });
    }
    const row = peopleRows(inputs).find((r) => r.id === target);
    if (!row)
      return { ok: false, error: "That identity is not in the last read. Refresh and pick again." };
    inspectState(rt).selected = `who:${target}`;
    await rt.recomposeNow(INSPECT_KEY);
    return open(INSPECT_KEY, `Identity · ${row.name}`);
  }
  const brief = buildBrief(inputs);
  let title: string | undefined;
  if (id.startsWith("fam:")) {
    const f = familiesOf(inputs).find((x) => x.key === id.slice(4));
    title = f ? `Family · ${f.label}` : undefined;
  } else if (id.startsWith("cell:")) {
    const [, who, sub] = id.split(":");
    title = who && sub ? cellView(rt, inputs, who, sub)?.title : undefined;
  } else if (id.startsWith("sub:")) {
    const name = id.slice(4);
    if (inputs.seismic?.subprojects.some((s) => s.name === name)) {
      seismicState(rt).selected = name;
      title = `Subproject · ${name}`;
    }
  } else if (id.startsWith("item:"))
    title = [...brief.items, ...(brief.stewardship ?? [])].find((x) => x.id === id)?.title;
  else if (id.startsWith("read:")) title = brief.reads.find((r) => `read:${r.area}` === id)?.label;
  else if (id.startsWith("tag:")) {
    const name = id.slice(4);
    const legal = inputs.legal;
    if (legal && [...legal.valid, ...legal.invalid].some((t) => t.name === name))
      title = `Legal tag · ${name}`;
  }
  if (!title) return { ok: false, error: `${id} has moved; the console redraws` };
  inspectState(rt).selected = id;
  // The drawer opens on this snapshot, so it must hold the selection just made.
  await rt.recomposeNow(INSPECT_KEY);
  return open(INSPECT_KEY, title);
};

const annotateAction: ActionHandler = async (rt, payload) => {
  const p = asPayload(payload);
  const profile = rt.profile;
  if (!profile) return { ok: false, error: "Not connected." };
  const drawn = {
    host: str(p, "host") ?? "",
    partition: str(p, "partition") ?? "",
    tenantId: str(p, "tenantId") ?? "",
  };
  if (!sameBinding(drawn, bindingOf(profile))) {
    return { ok: false, error: "This form was drawn for another instance. Refresh and try again." };
  }
  const id = str(p, "id")?.toLowerCase();
  const inputs = briefInputs(rt);
  if (!id || !knownId(rt, inputs, id))
    return { ok: false, error: "That identity is not in the last read." };
  const parsed = annotationInputSchema.safeParse({
    label: p.label,
    kind: p.kind,
    organization: p.organization,
    formerAddresses: p.formerAddresses,
    responsibility: p.responsibility,
    note: p.note,
  });
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues.map((x) => x.message).join("; ") };
  const res = rt.annotations.set(inputs.directory.keyFor(id), parsed.data, rt.now());
  if (!res.ok) return res;
  rt.recomposeAll();
  return { ok: true, data: { message: "Saved to the annotations file" } };
};

const rereadAreaAction: ActionHandler = async (rt, payload) => {
  const area = str(asPayload(payload), "area");
  if (!area || !(READ_AREAS as readonly string[]).includes(area)) {
    return { ok: false, error: "Pick a read to refresh." };
  }
  if (rt.status.phase === "signin") return { ok: false, error: SIGNIN_REASON };
  if (rt.status.phase !== "connected") return { ok: false, error: "Not connected." };
  if (area === "seismic") {
    const res = await measureSeismic(rt);
    rt.recompose([INSPECT_KEY]);
    return res.ok ? { ok: true, data: { message: "Read seismic members" } } : res;
  }
  if (!rt.hasArea(area)) return { ok: false, error: "That read is not part of this rib." };
  await rt.sweep({ only: [area] });
  rt.recompose([INSPECT_KEY]);
  return { ok: true, data: { message: `Read ${area}` } };
};

const browseFamilyAction: ActionHandler = async (rt, payload) => {
  const key = str(asPayload(payload), "family");
  const f = key ? familiesOf(briefInputs(rt)).find((x) => x.key === key) : undefined;
  if (!f) return { ok: false, error: "That record family is no longer counted." };
  const res = await loadSearch(rt, { mode: "kind", kind: f.pattern, subject: f.pattern }, 0);
  return res.ok ? openRecords() : res;
};

export const consoleModule: RegionModule = {
  composers: { [INSPECT_KEY]: composeInspect },
  actions: {
    [BROWSE_FAMILY_ACTION]: browseFamilyAction,
    [INSPECT_ACTION]: inspectAction,
    [ANNOTATE_ACTION]: annotateAction,
    [REREAD_ACTION]: rereadAreaAction,
  },
};
