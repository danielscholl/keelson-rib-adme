// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import {
  expectView,
  type Rib,
  type RibAction,
  type RibActionResult,
  type RibContext,
  type RibSurfaceBadge,
  type RibViewDescriptor,
  ribSurfaceBadgeSchema,
  type SnapshotManager,
} from "@keelson/shared";
import { composeConnection, RETEST_ACTION, SAVE_PROFILE_ACTION } from "./boards/connection.ts";
import {
  BADGE_KEYS,
  BOARD_KEYS,
  CONNECTION_KEY,
  DATA_PULSE_KEY,
  PULSE_KEY,
  RIB_ID,
  SEIS_PULSE_KEY,
} from "./keys.ts";
import { composeRestingHeader, EMPTY_BOARD } from "./resting.ts";
import { Runtime, TICK_MS } from "./runtime.ts";
import { Store } from "./store.ts";
import { REFRESH_ACTION, SURFACES } from "./surfaces.ts";

const ALL_KEYS = [...BOARD_KEYS, ...BADGE_KEYS];

let snapshots: SnapshotManager | undefined;
let runtime: Runtime | undefined;
let unregisters: Array<() => void> = [];
let ticker: ReturnType<typeof setInterval> | undefined;

function recompose(keys: readonly string[]): void {
  for (const key of keys) snapshots?.recompose(key).catch(() => undefined);
}

function composers(rt: Runtime): Map<string, () => unknown> {
  const map = new Map<string, () => unknown>();
  map.set(CONNECTION_KEY, () => composeConnection(rt.status));
  map.set(PULSE_KEY, () =>
    composeRestingHeader(rt.status, {
      firstRunHere: true,
      connectedText: `Connected${rt.status.test?.signedInAs ? ` as ${rt.status.test.signedInAs}` : ""}.`,
    }),
  );
  map.set(DATA_PULSE_KEY, () => composeRestingHeader(rt.status, { connectedText: "Connected." }));
  map.set(SEIS_PULSE_KEY, () => composeRestingHeader(rt.status, { connectedText: "Connected." }));
  return map;
}

function bind(ctx: RibContext): void {
  unbind();
  snapshots = ctx.getSnapshotManager?.();
  const sm = snapshots;
  const rt = new Runtime({
    exec: ctx.getExec(),
    store: new Store(ctx.getDataDir?.()),
    recompose,
    allKeys: ALL_KEYS,
  });
  runtime = rt;
  if (!sm) return;
  const byKey = composers(rt);
  for (const key of BOARD_KEYS) {
    const compose = byKey.get(key) ?? (() => EMPTY_BOARD);
    unregisters.push(
      sm.register(key, async () => compose(), { validate: expectView(key, "board") }),
    );
  }
  for (const key of BADGE_KEYS) {
    unregisters.push(
      sm.register(key, async (): Promise<RibSurfaceBadge> => ({ count: 0 }), {
        validate: (data) => ribSurfaceBadgeSchema.parse(data),
      }),
    );
  }
  recompose(ALL_KEYS);
  rt.sweep().catch(() => undefined);
  ticker = setInterval(() => {
    if (rt.shouldTick()) rt.sweep().catch(() => undefined);
  }, TICK_MS);
  ticker.unref?.();
}

function unbind(): void {
  for (const un of unregisters) un();
  unregisters = [];
  if (ticker) clearInterval(ticker);
  ticker = undefined;
  snapshots = undefined;
  runtime = undefined;
}

const rib: Rib = {
  id: RIB_ID,
  displayName: "ADME",

  views: BOARD_KEYS.map(
    (key): RibViewDescriptor => ({
      key,
      canvasKind: "view",
      title: `ADME: ${key.split(":").pop()}`,
    }),
  ),

  surfaces: SURFACES,

  // Composers bind here because this is the first hook that receives the context.
  registerTools: (ctx: RibContext) => {
    bind(ctx);
    return [];
  },

  onAction: async (action: RibAction): Promise<RibActionResult> => {
    const rt = runtime;
    if (!rt) return { ok: false, error: "adme is not bound yet" };
    rt.touch();
    switch (action.type) {
      case SAVE_PROFILE_ACTION: {
        const res = await rt.saveProfile(action.payload ?? {});
        if (!res.ok) return res;
        return {
          ok: true,
          data: { message: `Connection ${rt.status.phase === "connected" ? "works" : "tested"}` },
        };
      }
      case RETEST_ACTION:
        await rt.testConnection();
        return { ok: true };
      case REFRESH_ACTION:
        await rt.sweep();
        return { ok: true };
      default:
        return { ok: false, error: `adme does not handle '${action.type}'` };
    }
  },

  dispose: () => {
    unbind();
  },
};

export default rib;
