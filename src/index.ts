// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import {
  type CanvasBoardView,
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
import { BADGE_KEYS, BOARD_KEYS, RIB_ID } from "./keys.ts";
import { connectionModule } from "./modules/connection.ts";
import type { ActionHandler, RegionModule } from "./region.ts";
import { EMPTY_BOARD } from "./resting.ts";
import { Runtime, TICK_MS } from "./runtime.ts";
import { Store } from "./store.ts";
import { SURFACES } from "./surfaces.ts";

// Later modules override earlier ones for the same key.
const MODULES: readonly RegionModule[] = [connectionModule];

const ALL_KEYS = [...BOARD_KEYS, ...BADGE_KEYS];

let snapshots: SnapshotManager | undefined;
let runtime: Runtime | undefined;
let unregisters: Array<() => void> = [];
let ticker: ReturnType<typeof setInterval> | undefined;

function recompose(keys: readonly string[]): void {
  for (const key of keys) snapshots?.recompose(key).catch(() => undefined);
}

function boardComposers(): Map<string, (rt: Runtime) => CanvasBoardView> {
  const map = new Map<string, (rt: Runtime) => CanvasBoardView>();
  for (const m of MODULES) for (const [k, f] of Object.entries(m.composers ?? {})) map.set(k, f);
  return map;
}

function badgeCount(rt: Runtime, key: string): number {
  let n = 0;
  for (const m of MODULES) n += m.badges?.[key]?.(rt) ?? 0;
  return n;
}

const ACTIONS = new Map<string, ActionHandler>(
  MODULES.flatMap((m) => Object.entries(m.actions ?? {})),
);

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
  for (const m of MODULES) for (const area of m.areas ?? []) rt.addArea(area);
  runtime = rt;
  if (!sm) return;
  const byKey = boardComposers();
  for (const key of BOARD_KEYS) {
    const compose = byKey.get(key);
    unregisters.push(
      sm.register(key, async () => (compose ? compose(rt) : EMPTY_BOARD), {
        validate: expectView(key, "board"),
      }),
    );
  }
  for (const key of BADGE_KEYS) {
    unregisters.push(
      sm.register(
        key,
        async (): Promise<RibSurfaceBadge> => ({
          count: rt.status.phase === "connected" ? badgeCount(rt, key) : 0,
        }),
        { validate: (data) => ribSurfaceBadgeSchema.parse(data) },
      ),
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
    const handle = ACTIONS.get(action.type);
    if (!handle) return { ok: false, error: `adme does not handle '${action.type}'` };
    return handle(rt, action.payload);
  },

  dispose: () => {
    unbind();
  },
};

export default rib;
