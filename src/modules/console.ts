// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { CanvasActionItem, CanvasBoardView, RibActionResult } from "@keelson/shared";
import { measuredAccess } from "../access/measured.ts";
import { EXPLAIN_ACTION } from "../boards/change.ts";
import { SIGNIN_REASON } from "../boards/connection.ts";
import { CONNECTION_ID, consoleHtml } from "../boards/console.ts";
import {
  ANNOTATE_ACTION,
  annotateForm,
  composeIdentity,
  composeItem,
  composeRead,
  composeTag,
  type ItemVerbs,
  REREAD_ACTION,
  rereadAction,
} from "../boards/inspect.ts";
import { PREVIEW_SEIS_REVOKE_ACTION } from "../boards/seismic.ts";
import { type Brief, type BriefInputs, buildBrief, type Item } from "../brief/index.ts";
import { briefInputs } from "../brief/inputs.ts";
import { peopleRows } from "../brief/people.ts";
import { annotationInputSchema } from "../directory/annotations.ts";
import { CONNECTION_KEY, INSPECT_KEY } from "../keys.ts";
import { bindingOf, sameBinding } from "../plan/model.ts";
import type { ActionHandler, RegionModule } from "../region.ts";
import { EMPTY_BOARD } from "../resting.ts";
import type { Runtime } from "../runtime.ts";
import { READ_AREAS, type ReadArea } from "../status/index.ts";
import { INSPECT_ACTION } from "../surfaces.ts";
import { selectPersonAction } from "./access.ts";
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

export function composeConsole(rt: Runtime): string {
  const inputs = briefInputs(rt);
  return consoleHtml({ brief: buildBrief(inputs), people: peopleRows(inputs) });
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
    const item = brief.items.find((x) => x.id === sel);
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

// Every id the rib could name: listed by entitlements, by a seismic group, or annotated.
function knownId(i: BriefInputs, id: string): boolean {
  const a = i.access?.model;
  if (a && [...a.people, ...a.apps, ...a.unknown].some((p) => p.id === id)) return true;
  if (i.seismic?.members[id]) return true;
  return i.directory.entry(id) !== undefined;
}

const inspectAction: ActionHandler = async (rt, payload) => {
  const id = str(asPayload(payload), "id");
  if (!id) return { ok: false, error: "inspect payload must be { id: string }" };
  if (id === CONNECTION_ID) return open(CONNECTION_KEY, "Connection");
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
  if (id.startsWith("item:")) title = brief.items.find((x) => x.id === id)?.title;
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
  if (!id || !knownId(inputs, id))
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

export const consoleModule: RegionModule = {
  composers: { [INSPECT_KEY]: composeInspect },
  actions: {
    [INSPECT_ACTION]: inspectAction,
    [ANNOTATE_ACTION]: annotateAction,
    [REREAD_ACTION]: rereadAreaAction,
  },
};
