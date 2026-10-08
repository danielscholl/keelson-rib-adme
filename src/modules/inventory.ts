// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import {
  composeInventory,
  INVENTORY_GROUP_ACTION,
  INVENTORY_OPEN_ACTION,
} from "../boards/inventory.ts";
import { isGroupBy, setGroupBy } from "../data/inventory.ts";
import { buildQuery } from "../data/records.ts";
import { INVENTORY_KEY, RECORDS_KEY } from "../keys.ts";
import type { RegionModule } from "../region.ts";
import { focusRegion } from "../section.ts";
import { loadSearch } from "./records.ts";

export const inventoryModule: RegionModule = {
  composers: { [INVENTORY_KEY]: composeInventory },
  actions: {
    [INVENTORY_GROUP_ACTION]: async (rt, payload) => {
      const by = (payload as { by?: unknown } | undefined)?.by;
      if (!isGroupBy(by))
        return { ok: false, error: "Pick family, authority, namespace or version." };
      setGroupBy(rt, by);
      rt.recompose([INVENTORY_KEY]);
      return { ok: true };
    },
    [INVENTORY_OPEN_ACTION]: async (rt, payload) => {
      const pattern = (payload as { pattern?: unknown } | undefined)?.pattern;
      const built = buildQuery("kind", { kind: pattern });
      if (!built.ok) return { ok: false, error: built.error };
      const res = await loadSearch(rt, built.query, 0);
      return res.ok ? focusRegion(rt, "data", RECORDS_KEY) : res;
    },
  },
};
