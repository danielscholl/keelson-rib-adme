// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { SIGNIN_REASON } from "../boards/connection.ts";
import { composeRecord, RECORD_OPEN_ACTION } from "../boards/record.ts";
import { readRecord, setOpenedRecord } from "../data/record.ts";
import { instanceOf } from "../data/records.ts";
import { RECORD_KEY } from "../keys.ts";
import type { RegionModule } from "../region.ts";

export const recordModule: RegionModule = {
  composers: { [RECORD_KEY]: composeRecord },
  actions: {
    [RECORD_OPEN_ACTION]: async (rt, payload) => {
      const id = (payload as { id?: unknown } | undefined)?.id;
      if (typeof id !== "string" || !id.trim()) return { ok: false, error: "Pick a record." };
      if (rt.status.phase === "signin") return { ok: false, error: SIGNIN_REASON };
      if (rt.status.phase !== "connected") return { ok: false, error: "Not connected." };
      const res = await rt.run((b) => readRecord(b, id));
      const base = { instance: instanceOf(rt.profile), id, at: rt.now().toISOString() };
      if (res.ok) setOpenedRecord(rt, { ...base, ok: true, record: res.data });
      else if (res.failure.kind === "signin" && res.failure.status === null) {
        return { ok: false, error: SIGNIN_REASON };
      } else {
        const why =
          res.failure.kind === "forbidden"
            ? "storage refused this sign-in (403)"
            : res.failure.kind === "not-found"
              ? "storage has no record with this id (404)"
              : `storage read failed: ${res.failure.message}`;
        setOpenedRecord(rt, { ...base, ok: false, error: why });
      }
      rt.recompose([RECORD_KEY]);
      return {
        ok: true,
        data: {
          effect: "open-canvas",
          key: RECORD_KEY,
          title: `Record · ${id}`,
          placement: "side",
        },
      };
    },
  },
};
