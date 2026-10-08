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
  type RibViewDescriptor,
  type SnapshotManager,
} from "@keelson/shared";
import { DOCS } from "./docs.ts";
import {
  BOARD_KEYS,
  DATA_PULSE_KEY,
  HEADER_KEY,
  PULSE_KEY,
  RIB_ID,
  SEIS_PULSE_KEY,
} from "./keys.ts";
import { accessModule } from "./modules/access.ts";
import { connectionModule } from "./modules/connection.ts";
import { dataPulseModule } from "./modules/data.ts";
import { explainModule } from "./modules/explain.ts";
import { headerModule } from "./modules/header.ts";
import { legalModule } from "./modules/legal.ts";
import { planModule } from "./modules/plan.ts";
import { recordsModule } from "./modules/records.ts";
import { seismicModule } from "./modules/seismic.ts";
import type { ActionHandler, RegionModule } from "./region.ts";
import { EMPTY_BOARD } from "./resting.ts";
import { Runtime, TICK_MS } from "./runtime.ts";
import { activeSection } from "./section.ts";
import { Store } from "./store.ts";
import { SURFACES, sectionOf } from "./surfaces.ts";

// Later modules override earlier ones for the same key.
const MODULES: readonly RegionModule[] = [
  connectionModule,
  accessModule,
  dataPulseModule,
  legalModule,
  recordsModule,
  planModule,
  seismicModule,
  explainModule,
  headerModule,
];

const ALL_KEYS = BOARD_KEYS;

let snapshots: SnapshotManager | undefined;
let runtime: Runtime | undefined;
let unregisters: Array<() => void> = [];
let ticker: ReturnType<typeof setInterval> | undefined;

// The header draws from the section pulses.
const HEADER_SOURCES = new Set<string>([PULSE_KEY, DATA_PULSE_KEY, SEIS_PULSE_KEY]);

function recompose(keys: readonly string[]): void {
  const all = new Set(keys);
  if (keys.some((k) => HEADER_SOURCES.has(k))) all.add(HEADER_KEY);
  for (const key of all) snapshots?.recompose(key).catch(() => undefined);
}

function boardComposers(): Map<string, (rt: Runtime) => CanvasBoardView> {
  const map = new Map<string, (rt: Runtime) => CanvasBoardView>();
  for (const m of MODULES) for (const [k, f] of Object.entries(m.composers ?? {})) map.set(k, f);
  return map;
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
    registerOp: ctx.registerOp,
  });
  for (const m of MODULES) for (const area of m.areas ?? []) rt.addArea(area);
  runtime = rt;
  if (!sm) return;
  const byKey = boardComposers();
  for (const key of BOARD_KEYS) {
    const compose = byKey.get(key);
    const section = sectionOf(key);
    // A region outside the showing section publishes nothing, so hideWhenEmpty hides it.
    const shown = (r: Runtime) => section === undefined || activeSection(r) === section;
    unregisters.push(
      sm.register(key, async () => (compose && shown(rt) ? compose(rt) : EMPTY_BOARD), {
        validate: expectView(key, "board"),
      }),
    );
  }
  recompose(ALL_KEYS);
  rt.sweep().catch(() => undefined);
  // A test saved before roles were recorded is re-run once so the header can show the role.
  if (rt.status.phase === "connected" && !rt.status.test?.roleGroups) {
    rt.testConnection().catch(() => undefined);
  }
  if (rt.status.phase !== "connected") rt.discover().catch(() => undefined);
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

  contributeDocs: () => DOCS,

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
