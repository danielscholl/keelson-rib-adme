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
import { BADGE_KEYS, BOARD_KEYS, RIB_ID } from "./keys.ts";
import { composeResting } from "./resting.ts";
import { REFRESH_ACTION, RETEST_ACTION, SURFACES } from "./surfaces.ts";

let snapshots: SnapshotManager | undefined;
let unregisters: Array<() => void> = [];

function recomposeAll(): void {
  for (const key of [...BOARD_KEYS, ...BADGE_KEYS]) {
    snapshots?.recompose(key).catch(() => undefined);
  }
}

function bind(ctx: RibContext): void {
  for (const un of unregisters) un();
  unregisters = [];
  snapshots = ctx.getSnapshotManager?.();
  const sm = snapshots;
  if (!sm) return;
  for (const key of BOARD_KEYS) {
    unregisters.push(
      sm.register(key, async () => composeResting(key), { validate: expectView(key, "board") }),
    );
  }
  for (const key of BADGE_KEYS) {
    unregisters.push(
      sm.register(key, async (): Promise<RibSurfaceBadge> => ({ count: 0 }), {
        validate: (data) => ribSurfaceBadgeSchema.parse(data),
      }),
    );
  }
  recomposeAll();
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
    switch (action.type) {
      case REFRESH_ACTION:
      case RETEST_ACTION:
        recomposeAll();
        return { ok: true };
      default:
        return { ok: false, error: `adme does not handle '${action.type}'` };
    }
  },

  dispose: () => {
    for (const un of unregisters) un();
    unregisters = [];
    snapshots = undefined;
  },
};

export default rib;
