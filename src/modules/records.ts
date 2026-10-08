// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { RibActionResult } from "@keelson/shared";
import { SIGNIN_REASON } from "../boards/connection.ts";
import {
  CLEAR_ACTION,
  composeRecords,
  NEXT_ACTION,
  PREV_ACTION,
  SEARCH_ACTIONS,
} from "../boards/records.ts";
import type { CallFailure } from "../client.ts";
import { KINDS_AREA, type KindCounts } from "../data/areas.ts";
import {
  activeSearch,
  buildQuery,
  clearSearch,
  FIND_MODES,
  instanceOf,
  pageInfo,
  type RecordQuery,
  searchRecords,
  setSearch,
} from "../data/records.ts";
import { RECORDS_KEY } from "../keys.ts";
import type { ActionHandler, RegionModule } from "../region.ts";
import type { Runtime } from "../runtime.ts";

const NOT_CONNECTED = "not connected: finish the connect steps in the header";

function readable(f: CallFailure): string {
  switch (f.kind) {
    case "forbidden":
      return `search refused this sign-in (403): ${f.message}`;
    case "client":
      return `search rejected the query: ${f.message}`;
    default:
      return f.kind === "signin" && f.status === null
        ? SIGNIN_REASON
        : `search failed: ${f.message}`;
  }
}

export async function loadSearch(
  rt: Runtime,
  query: RecordQuery,
  page: number,
): Promise<RibActionResult> {
  if (rt.status.phase === "signin") return { ok: false, error: SIGNIN_REASON };
  if (rt.status.phase !== "connected") return { ok: false, error: NOT_CONNECTED };
  const res = await rt.run((batch) => searchRecords(batch, query, page));
  if (!res.ok) return { ok: false, error: readable(res.failure) };
  setSearch(rt, {
    instance: instanceOf(rt.profile),
    query,
    page,
    result: res.data,
    at: rt.now().toISOString(),
  });
  rt.recompose([RECORDS_KEY]);
  return { ok: true };
}

const searches = Object.fromEntries(
  FIND_MODES.map((mode): [string, ActionHandler] => [
    SEARCH_ACTIONS[mode],
    async (rt, payload) => {
      const input =
        payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
      const built = buildQuery(mode, input);
      if (!built.ok) return { ok: false, error: built.error };
      return loadSearch(rt, built.query, 0);
    },
  ]),
);

export const recordsModule: RegionModule = {
  composers: {
    [RECORDS_KEY]: (rt) => {
      const kinds = rt.cache.get<KindCounts>(KINDS_AREA).data;
      const search = activeSearch(rt);
      return composeRecords({
        status: rt.status,
        ...(kinds ? { kinds } : {}),
        ...(search ? { search } : {}),
      });
    },
  },
  actions: {
    ...searches,
    [NEXT_ACTION]: async (rt) => {
      const s = activeSearch(rt);
      if (!s) return { ok: false, error: "run a search first" };
      const next = pageInfo(s.result.total, s.page).next;
      if (!next.ok) return { ok: false, error: next.reason };
      return loadSearch(rt, s.query, s.page + 1);
    },
    [PREV_ACTION]: async (rt) => {
      const s = activeSearch(rt);
      if (!s) return { ok: false, error: "run a search first" };
      const prev = pageInfo(s.result.total, s.page).prev;
      if (!prev.ok) return { ok: false, error: prev.reason };
      return loadSearch(rt, s.query, s.page - 1);
    },
    [CLEAR_ACTION]: async (rt) => {
      clearSearch(rt);
      rt.recompose([RECORDS_KEY]);
      return { ok: true };
    },
  },
};
