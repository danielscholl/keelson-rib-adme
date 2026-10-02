// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { z } from "zod";
import type { Store } from "./store.ts";

// One area of the last sweep: the last good data, and the newest failure when
// the latest read did not succeed. A failed read never erases good data.
export interface Measured<T = unknown> {
  at?: string;
  data?: T;
  error?: string;
  errorAt?: string;
}

const measuredSchema = z.object({
  at: z.string().optional(),
  data: z.unknown().optional(),
  error: z.string().optional(),
  errorAt: z.string().optional(),
});
const sweepFileSchema = z.object({ areas: z.record(z.string(), measuredSchema) });

const FILE = "sweep.json";

export class SweepCache {
  private areas: Record<string, Measured>;

  constructor(private readonly store: Store) {
    this.areas = store.read(FILE, sweepFileSchema)?.areas ?? {};
  }

  get<T>(area: string): Measured<T> {
    return (this.areas[area] ?? {}) as Measured<T>;
  }

  succeed(area: string, data: unknown, at: Date): void {
    this.areas[area] = { at: at.toISOString(), data };
    this.save();
  }

  fail(area: string, error: string, at: Date): void {
    this.areas[area] = { ...this.areas[area], error, errorAt: at.toISOString() };
    this.save();
  }

  clear(): void {
    this.areas = {};
    this.save();
  }

  private save(): void {
    this.store.write(FILE, { areas: this.areas });
  }
}

export function clock(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}Z`;
}
