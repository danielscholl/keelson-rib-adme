// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { SIGNIN_REASON } from "../boards/connection.ts";
import {
  CLEANUP_SETS,
  cleanupNames,
  composeMap,
  focusOf,
  lensEntries,
  MAP_BROWSE_ACTION,
  MAP_COPY_ACTION,
  MAP_GROUP_ACTION,
  MAP_LENS_ACTION,
  MAP_SELECT_ACTION,
} from "../boards/map.ts";
import { LEGAL_AREA, type LegalTags } from "../data/areas.ts";
import { isGroupBy, setGroupBy } from "../data/inventory.ts";
import { tagUsage } from "../data/legal.ts";
import {
  FACETS_AREA,
  type Facets,
  FLOW_PARTS,
  type Flow,
  isLens,
  type Lens,
  mapState,
  readFacets,
  readFlow,
  readSlice,
  type Selection,
} from "../data/map.ts";
import { buildQuery } from "../data/records.ts";
import { DATA_PULSE_KEY, MAP_KEY, RECORDS_KEY } from "../keys.ts";
import type { RegionModule } from "../region.ts";
import type { Runtime } from "../runtime.ts";
import { focusRegion } from "../section.ts";
import { loadSearch } from "./records.ts";

// A refresh of the same row keeps the old slice on screen until the new one lands.
async function loadSlice(rt: Runtime, selection: Selection): Promise<void> {
  const state = mapState(rt);
  const same = state.selection?.lens === selection.lens && state.selection.key === selection.key;
  state.selection = selection;
  if (!same) {
    delete state.slice;
    rt.recompose([MAP_KEY]);
  }
  const res = await rt.run((b) => readSlice(b, selection));
  if (state.selection !== selection) return;
  const at = rt.now().toISOString();
  state.slice = res.ok ? { at, data: res.data } : { at, error: res.failure.message };
  rt.recompose([MAP_KEY]);
}

// The other side of the flow: the largest groups, or for kinds the largest tags in use.
function flowKeys(rt: Runtime, lens: Flow["lens"]): { keys: string[]; of: number } | undefined {
  const facets = rt.cache.get<Facets>(FACETS_AREA).data;
  if (lens === "kinds") {
    const legal = rt.cache.get<LegalTags>(LEGAL_AREA).data;
    const counts = facets?.tags;
    if (!counts) return undefined;
    const names = legal
      ? tagUsage(legal, counts, rt.now()).inUse.map((u) => u.tag.name)
      : counts.map((b) => b.key);
    return { keys: names.slice(0, FLOW_PARTS.tags), of: names.length };
  }
  const buckets = facets?.[lens === "owners" ? "owners" : "viewers"];
  if (!buckets) return undefined;
  return { keys: buckets.slice(0, FLOW_PARTS.groups).map((b) => b.key), of: buckets.length };
}

async function loadFlow(rt: Runtime, lens: Flow["lens"]): Promise<void> {
  const scope = flowKeys(rt, lens);
  if (!scope || scope.keys.length === 0) return;
  const res = await rt.run((b) => readFlow(b, lens, scope.keys, scope.of));
  const state = mapState(rt);
  if (state.lens !== lens) return;
  const at = rt.now().toISOString();
  state.flow = res.ok ? { at, data: res.data } : { at, error: res.failure.message };
  rt.recompose([MAP_KEY]);
}

// Keeps the profile on the focused row and the flow on the lens, re-reading
// both when a sweep brings new facets.
export async function focus(rt: Runtime): Promise<void> {
  if (rt.status.phase !== "connected") return;
  const state = mapState(rt);
  const at = rt.cache.get(FACETS_AREA).at;
  const stale = state.readAt !== at;
  if (at) state.readAt = at;
  const jobs: Promise<void>[] = [];
  const sel = focusOf(rt, state.lens);
  const cur = state.selection;
  if (sel && (stale || cur?.lens !== sel.lens || cur.key !== sel.key)) {
    jobs.push(loadSlice(rt, sel));
  }
  const lens = state.lens;
  if (lens !== "cleanup" && (stale || !state.flow)) jobs.push(loadFlow(rt, lens));
  await Promise.all(jobs);
}

const browseQuery = (lens: Lens, key: string) =>
  lens === "tags" || lens === "cleanup"
    ? buildQuery("legal", { tag: key })
    : lens === "kinds"
      ? buildQuery("kind", { kind: key })
      : buildQuery("acl", { group: key });

export const mapModule: RegionModule = {
  areas: [{ name: FACETS_AREA, keys: [MAP_KEY, DATA_PULSE_KEY], read: readFacets }],
  composers: { [MAP_KEY]: composeMap },
  actions: {
    [MAP_LENS_ACTION]: async (rt, payload) => {
      const lens = (payload as { lens?: unknown } | undefined)?.lens;
      if (!isLens(lens)) {
        return { ok: false, error: "Pick tags in use, readers, owners, kinds or cleanup." };
      }
      const state = mapState(rt);
      if (state.lens !== lens) delete state.flow;
      state.lens = lens;
      rt.recompose([MAP_KEY]);
      await focus(rt);
      return { ok: true };
    },
    [MAP_GROUP_ACTION]: async (rt, payload) => {
      const by = (payload as { by?: unknown } | undefined)?.by;
      if (!isGroupBy(by))
        return { ok: false, error: "Pick family, authority, namespace or version." };
      setGroupBy(rt, by);
      const state = mapState(rt);
      if (state.picks) delete state.picks.kinds;
      if (state.selection?.lens === "kinds") {
        delete state.selection;
        delete state.slice;
      }
      rt.recompose([MAP_KEY]);
      await focus(rt);
      return { ok: true };
    },
    // Only a row the lens draws can be selected, so the slice query is never free text.
    [MAP_SELECT_ACTION]: async (rt, payload) => {
      const p = (payload ?? {}) as { lens?: unknown; key?: unknown };
      if (!isLens(p.lens) || typeof p.key !== "string") return { ok: false, error: "Pick a row." };
      const entry = lensEntries(rt, p.lens).find((e) => !e.summary && e.key === p.key);
      if (!entry) return { ok: false, error: "That row is no longer in the list. Refresh." };
      if (rt.status.phase === "signin") return { ok: false, error: SIGNIN_REASON };
      if (rt.status.phase !== "connected") return { ok: false, error: "Not connected." };
      const state = mapState(rt);
      state.picks = { ...state.picks, [p.lens]: entry.key };
      await loadSlice(rt, { lens: p.lens, key: entry.key, label: entry.label });
      return { ok: true };
    },
    [MAP_BROWSE_ACTION]: async (rt) => {
      const sel = focusOf(rt, mapState(rt).lens);
      if (!sel) return { ok: false, error: "Nothing to browse yet." };
      const built = browseQuery(sel.lens, sel.key);
      if (!built.ok) return { ok: false, error: built.error };
      const res = await loadSearch(rt, built.query, 0);
      return res.ok ? focusRegion(rt, "data", RECORDS_KEY) : res;
    },
    [MAP_COPY_ACTION]: async (rt, payload) => {
      const set = (payload as { set?: unknown } | undefined)?.set;
      const known = CLEANUP_SETS.find((s) => s === set);
      if (!known) return { ok: false, error: "Pick a list to copy." };
      const names = cleanupNames(rt, known);
      if (!names || names.length === 0) return { ok: false, error: "That list is empty now." };
      return { ok: true, data: names.join("\n") };
    },
  },
  settle: (rt) => {
    focus(rt).catch(() => undefined);
  },
};
