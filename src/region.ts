// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { CanvasBoardView, RibActionResult } from "@keelson/shared";
import type { Area, Runtime } from "./runtime.ts";

export type ActionHandler = (rt: Runtime, payload: unknown) => Promise<RibActionResult>;

// One slice of the rib: its tier-1 reads, the boards it composes, the board
// actions it handles, and what it adds to a tab badge. index.ts wires a list
// of these, so a new region is one module and one line.
export interface RegionModule {
  areas?: readonly Area[];
  composers?: Readonly<Record<string, (rt: Runtime) => CanvasBoardView>>;
  actions?: Readonly<Record<string, ActionHandler>>;
  badges?: Readonly<Record<string, (rt: Runtime) => number>>;
}
