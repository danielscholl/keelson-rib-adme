// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { OpHandle, RegisterOpRequest, RibExec } from "@keelson/shared";
import type { z } from "zod";
import {
  type AdmeClient,
  type Batch,
  type CallResult,
  createClient,
  type Transport,
} from "./client.ts";
import {
  type ConnectionStatus,
  probeConnection,
  type TestResult,
  testResultSchema,
} from "./connection.ts";
import { type Discovery, discoverInstances } from "./discover.ts";
import { type Profile, profileSchema } from "./profile.ts";
import type { Store } from "./store.ts";
import { clock, SweepCache } from "./sweep.ts";
import { Tracker, trackerFile } from "./tracker.ts";

export const IDLE_WINDOW_MS = 15 * 60_000;
export const TICK_MS = 5 * 60_000;

// A tier-1 area: one read the sweep runs on open, on Refresh now and while the
// operator is active. `keys` recompose when it lands.
export interface Area<T = unknown> {
  name: string;
  keys: readonly string[];
  read(batch: Batch): Promise<CallResult<T>>;
}

export interface RuntimeOptions {
  exec: RibExec;
  store: Store;
  recompose: (keys: readonly string[]) => void;
  allKeys: readonly string[];
  now?: () => Date;
  transport?: Transport;
  sleep?: (ms: number) => Promise<void>;
  registerOp?: ((req: RegisterOpRequest) => OpHandle) | undefined;
}

export class Runtime {
  readonly cache: SweepCache;
  tracker: Tracker;
  status: ConnectionStatus = { phase: "firstrun" };
  discovery: Discovery = { state: "idle" };
  private readonly areas: Area[] = [];
  private client: AdmeClient | undefined;
  private lastActionAt = 0;
  private sweeping: Promise<void> | undefined;
  readonly now: () => Date;

  constructor(private readonly opts: RuntimeOptions) {
    this.now = opts.now ?? (() => new Date());
    this.cache = new SweepCache(opts.store);
    this.tracker = new Tracker(opts.store, trackerFile(undefined));
    const profile = opts.store.read("profile.json", profileSchema);
    const test = opts.store.read("test.json", testResultSchema);
    if (profile) this.useProfile(profile, test);
  }

  get profile(): Profile | undefined {
    return this.status.profile;
  }

  addArea(area: Area): void {
    this.areas.push(area);
  }

  // "measured 14:05Z" while connected; "cached from 13:02Z" once sign-in is needed.
  freshness(area: string): string | undefined {
    const at = clock(this.cache.get(area).at);
    if (!at) return undefined;
    return this.status.phase === "connected" ? `measured ${at}` : `cached from ${at}`;
  }

  writeExport(name: string, text: string): string | undefined {
    return this.opts.store.writeText(`exports/${name}`, text);
  }

  recompose(keys: readonly string[]): void {
    this.opts.recompose(keys);
  }

  sleep(ms: number): Promise<void> {
    return this.opts.sleep ? this.opts.sleep(ms) : new Promise((r) => setTimeout(r, ms));
  }

  // A durable handle the host's run_cancel can reach; absent on older hosts.
  registerOp(req: RegisterOpRequest): OpHandle | undefined {
    return this.opts.registerOp?.(req);
  }

  readStore<T>(name: string, schema: z.ZodType<T>): T | undefined {
    return this.opts.store.read(name, schema);
  }

  writeStore(name: string, data: unknown): void {
    this.opts.store.write(name, data);
  }

  // An on-demand read outside the tier-1 sweep (a record search, an inspector).
  // A lapsed sign-in flips the phase so every header says so.
  async run<T>(work: (batch: Batch) => Promise<CallResult<T>>): Promise<CallResult<T>> {
    const client = this.client;
    if (!client || this.status.phase !== "connected") {
      return {
        ok: false,
        failure: { kind: "signin", status: null, message: "not connected" },
      };
    }
    const res = await client.batch(work);
    if (!res.ok && res.failure.kind === "signin" && res.failure.status === null) {
      this.status = { ...this.status, phase: "signin", error: res.failure.message };
      this.opts.recompose(this.opts.allKeys);
    }
    return res;
  }

  touch(): void {
    this.lastActionAt = this.now().getTime();
  }

  // Timers run only shortly after the operator acted, and never while signed out.
  shouldTick(): boolean {
    return (
      this.status.phase === "connected" && this.now().getTime() - this.lastActionAt < IDLE_WINDOW_MS
    );
  }

  async saveProfile(input: unknown): Promise<{ ok: true } | { ok: false; error: string }> {
    const parsed = profileSchema.safeParse(input);
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues.map((i) => i.message).join("; ") };
    }
    const changedInstance =
      this.profile?.host !== parsed.data.host || this.profile?.partition !== parsed.data.partition;
    this.opts.store.write("profile.json", parsed.data);
    if (changedInstance) this.cache.clear();
    this.useProfile(parsed.data, undefined);
    await this.testConnection();
    return { ok: true };
  }

  async discover(): Promise<void> {
    if (this.discovery.state === "looking") return;
    this.discovery = { state: "looking" };
    this.opts.recompose(this.opts.allKeys);
    try {
      this.discovery = await discoverInstances(this.opts.exec);
    } catch (err) {
      this.discovery = { state: "failed", error: err instanceof Error ? err.message : String(err) };
    }
    this.opts.recompose(this.opts.allKeys);
  }

  // The profile comes from the discovered record, never from the action payload.
  async connectInstance(
    id: string,
    partition: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const found = this.discovery.state === "found" ? this.discovery.instances : [];
    const instance = found.find((i) => i.id === id);
    if (!instance?.partitions.includes(partition)) {
      return { ok: false, error: "That instance is no longer in the list. Look again." };
    }
    const rosterGroupId =
      this.profile?.host === instance.host ? this.profile.rosterGroupId : undefined;
    return this.saveProfile({
      host: instance.host,
      partition,
      tenantId: instance.tenantId,
      admeAppId: instance.admeAppId,
      ...(rosterGroupId ? { rosterGroupId } : {}),
    });
  }

  useSuggestedRosterGroup(id: unknown): { ok: true } | { ok: false; error: string } {
    const profile = this.profile;
    const suggestion = this.status.test?.rosterSuggestion;
    if (!profile || !suggestion || suggestion.id !== id) {
      return { ok: false, error: "That suggestion is out of date. Re-test the connection." };
    }
    const parsed = profileSchema.safeParse({ ...profile, rosterGroupId: suggestion.id });
    if (!parsed.success) return { ok: false, error: "The suggested group id is not a GUID." };
    const next = parsed.data;
    this.opts.store.write("profile.json", next);
    this.client = this.clientFor(next);
    this.status = { ...this.status, profile: next };
    this.opts.recompose(this.opts.allKeys);
    return { ok: true };
  }

  async testConnection(): Promise<void> {
    const client = this.client;
    if (!client || !this.profile) return;
    const outcome = await client.batch((b) => probeConnection(b, this.now));
    // Read after the await: the profile may have gained a roster group meanwhile.
    let profile = this.profile;
    if (!profile) return;
    if (outcome.kind === "tested") {
      if (outcome.entitlementsDomain && outcome.entitlementsDomain !== profile.entitlementsDomain) {
        profile = { ...profile, entitlementsDomain: outcome.entitlementsDomain };
        this.opts.store.write("profile.json", profile);
        this.client = this.clientFor(profile);
      }
      this.opts.store.write("test.json", outcome.result);
      this.status = outcome.reachable
        ? { phase: "connected", profile, test: outcome.result }
        : { phase: "profile-error", profile, test: outcome.result, error: outcome.message };
    } else {
      this.status = {
        phase: outcome.kind === "signin" ? "signin" : "profile-error",
        profile,
        ...(this.status.test ? { test: this.status.test } : {}),
        error: outcome.message,
      };
    }
    this.opts.recompose(this.opts.allKeys);
    if (this.status.phase === "connected") await this.sweep();
  }

  // Tier 1: every area in one batch, so the reads share one token per resource.
  sweep(): Promise<void> {
    if (this.sweeping) return this.sweeping;
    const client = this.client;
    if (!client || this.status.phase !== "connected") return Promise.resolve();
    this.sweeping = client
      .batch((b) => this.readAreas(b))
      .finally(() => {
        this.sweeping = undefined;
      });
    return this.sweeping;
  }

  private async readAreas(batch: Batch): Promise<void> {
    const results = await Promise.all(this.areas.map((a) => a.read(batch)));
    const at = this.now();
    const keys = new Set<string>();
    let signin: string | undefined;
    results.forEach((res, i) => {
      const area = this.areas[i] as Area;
      for (const k of area.keys) keys.add(k);
      if (res.ok) {
        this.cache.succeed(area.name, res.data, at);
        return;
      }
      if (res.failure.kind === "signin" && res.failure.status === null) {
        signin = res.failure.message;
        return;
      }
      this.cache.fail(area.name, res.failure.message, at);
    });
    if (signin !== undefined && this.profile) {
      this.status = { ...this.status, phase: "signin", error: signin };
      this.opts.recompose(this.opts.allKeys);
      return;
    }
    this.opts.recompose([...keys]);
  }

  private clientFor(profile: Profile): AdmeClient {
    return createClient(this.opts.exec, profile, {
      ...(this.opts.transport ? { transport: this.opts.transport } : {}),
      ...(this.opts.sleep ? { sleep: this.opts.sleep } : {}),
    });
  }

  private useProfile(profile: Profile, test: TestResult | undefined): void {
    this.client = this.clientFor(profile);
    this.tracker = new Tracker(this.opts.store, trackerFile(profile));
    this.status = test
      ? { phase: "connected", profile, test }
      : { phase: "profile-error", profile, error: "Test connection has not run yet." };
  }
}
