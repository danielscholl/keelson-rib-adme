// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { SIGNIN_REASON } from "../boards/connection.ts";
import {
  composeMap,
  lensEntries,
  MAP_BROWSE_ACTION,
  MAP_GROUP_ACTION,
  MAP_LENS_ACTION,
  MAP_SELECT_ACTION,
} from "../boards/map.ts";
import { isGroupBy, setGroupBy } from "../data/inventory.ts";
import { FACETS_AREA, isLens, mapState, readFacets, readSlice } from "../data/map.ts";
import { buildQuery } from "../data/records.ts";
import { DATA_PULSE_KEY, MAP_KEY, RECORDS_KEY } from "../keys.ts";
import type { RegionModule } from "../region.ts";
import { focusRegion } from "../section.ts";
import { loadSearch } from "./records.ts";

export const mapModule: RegionModule = {
  areas: [{ name: FACETS_AREA, keys: [MAP_KEY, DATA_PULSE_KEY], read: readFacets }],
  composers: { [MAP_KEY]: composeMap },
  actions: {
    [MAP_LENS_ACTION]: async (rt, payload) => {
      const lens = (payload as { lens?: unknown } | undefined)?.lens;
      if (!isLens(lens)) return { ok: false, error: "Pick legal tags, readers, owners or kinds." };
      mapState(rt).lens = lens;
      rt.recompose([MAP_KEY]);
      return { ok: true };
    },
    [MAP_GROUP_ACTION]: async (rt, payload) => {
      const by = (payload as { by?: unknown } | undefined)?.by;
      if (!isGroupBy(by))
        return { ok: false, error: "Pick family, authority, namespace or version." };
      setGroupBy(rt, by);
      const state = mapState(rt);
      if (state.selection?.lens === "kinds") {
        delete state.selection;
        delete state.slice;
      }
      rt.recompose([MAP_KEY]);
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
      const selection = { lens: p.lens, key: entry.key, label: entry.label };
      state.selection = selection;
      delete state.slice;
      rt.recompose([MAP_KEY]);
      const res = await rt.run((b) => readSlice(b, selection));
      if (state.selection !== selection) return { ok: true };
      const at = rt.now().toISOString();
      state.slice = res.ok ? { at, data: res.data } : { at, error: res.failure.message };
      rt.recompose([MAP_KEY]);
      return { ok: true };
    },
    [MAP_BROWSE_ACTION]: async (rt) => {
      const sel = mapState(rt).selection;
      if (!sel) return { ok: false, error: "Select a row first." };
      const built =
        sel.lens === "tags"
          ? buildQuery("legal", { tag: sel.key })
          : sel.lens === "kinds"
            ? buildQuery("kind", { kind: sel.key })
            : buildQuery("acl", { group: sel.key });
      if (!built.ok) return { ok: false, error: built.error };
      const res = await loadSearch(rt, built.query, 0);
      return res.ok ? focusRegion(rt, "data", RECORDS_KEY) : res;
    },
  },
};
