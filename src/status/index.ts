// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { type ActivityModel, daysBetween, type Usage } from "../access/activity.ts";
import type { Identity, Role } from "../access/model.ts";
import type { Measured } from "../sweep.ts";

const HOUR_MS = 3_600_000;

// Each axis comes from one source, and no word folds two of them together.
export type Onboarding =
  | { state: "invited"; since?: string; days?: number }
  | { state: "accepted"; at?: string }
  | { state: "member" };

export type BlockedReason = "no-users" | "deleted" | "not-in-entra";
export type InconsistentReason = "duplicate" | "no-role";

export type Configured =
  | { state: "ready"; role: Role }
  | { state: "blocked"; reason: BlockedReason; role?: Role }
  | { state: "inconsistent"; reason: InconsistentReason; role?: Role }
  // Neither users@ nor a role group lists the identity.
  | { state: "none" }
  | { state: "unmeasured" };

export type Observed =
  | { state: "active"; last: string }
  | { state: "idle"; last: string }
  | { state: "no-call"; since?: string }
  | { state: "unmeasured"; reason: string };

export type IdentityState = "resolved" | "labelled" | "unresolved";

export function onboardingOf(p: Identity, now: Date): Onboarding {
  if (p.kind !== "person") return { state: "member" };
  if (p.state === "pending") {
    return {
      state: "invited",
      ...(p.invitedAt ? { since: p.invitedAt, days: daysBetween(p.invitedAt, now) } : {}),
    };
  }
  if (!p.guest) return { state: "member" };
  return { state: "accepted", ...(p.acceptedAt ? { at: p.acceptedAt } : {}) };
}

// From group membership only: what is configured, not whether a call succeeds.
export function configuredOf(p: Identity | undefined): Configured {
  if (!p) return { state: "none" };
  const role = p.role ? { role: p.role } : {};
  if (p.deleted && p.role) return { state: "blocked", reason: "deleted", ...role };
  if (p.role && !p.memberships.users) return { state: "blocked", reason: "no-users", ...role };
  if (p.duplicateIn) return { state: "inconsistent", reason: "duplicate", ...role };
  if (!p.role && p.memberships.users) return { state: "inconsistent", reason: "no-role" };
  if (p.role) return { state: "ready", role: p.role };
  return { state: "none" };
}

export function observedOf(
  p: Identity,
  activity: ActivityModel | undefined,
  usage: Usage | undefined,
  reason: string,
): Observed {
  if (!activity) return { state: "unmeasured", reason };
  const a = activity.byId.get(p.id);
  if (!a || usage === "invited" || usage === "not-used") {
    return { state: "no-call", ...(activity.since ? { since: activity.since } : {}) };
  }
  return usage === "active" ? { state: "active", last: a.last } : { state: "idle", last: a.last };
}

// ---- Read signals: availability, completeness and freshness, per area ----

export const READ_AREAS = ["access", "activity", "seismic", "legal", "kinds", "facets"] as const;
export type ReadArea = (typeof READ_AREAS)[number];

export const READ_LABEL: Record<ReadArea, string> = {
  access: "Access",
  activity: "Audit log",
  seismic: "Seismic members",
  legal: "Legal tags",
  kinds: "Record kinds",
  facets: "Tag and group counts",
};

export const READ_LIMIT_MS: Record<ReadArea, number> = {
  access: 2 * HOUR_MS,
  activity: 24 * HOUR_MS,
  seismic: 24 * HOUR_MS,
  legal: 2 * HOUR_MS,
  kinds: 2 * HOUR_MS,
  facets: 2 * HOUR_MS,
};

// The service each area depends on, for availability from the health probes.
export const READ_SERVICE: Partial<Record<ReadArea, string>> = {
  access: "entitlements",
  seismic: "seismic",
  legal: "legal",
  kinds: "search",
  facets: "search",
};

export interface Completeness {
  complete: boolean;
  // "22 of 24 groups read"; absent when the area has no parts to count.
  text?: string;
}

export interface ReadSignal {
  area: ReadArea;
  label: string;
  // Not set up (no audit workspace): never an item, and never "?" for the rest.
  configured: boolean;
  available: "up" | "down" | "unknown";
  at?: string;
  ageMs?: number;
  limitMs: number;
  stale: boolean;
  // The newest read failed; the last good data (if any) still shows.
  failed: boolean;
  error?: string;
  errorAt?: string;
  completeness?: Completeness;
  // Calls a re-read costs, as a phrase.
  cost: string;
}

export interface SignalInput {
  area: ReadArea;
  measured: Measured;
  configured?: boolean;
  available?: "up" | "down" | "unknown";
  completeness?: Completeness;
  cost: string;
  now: Date;
}

export function readSignal(i: SignalInput): ReadSignal {
  const { measured: m } = i;
  const limitMs = READ_LIMIT_MS[i.area];
  const ageMs = m.at ? Math.max(0, i.now.getTime() - Date.parse(m.at)) : undefined;
  const failed = m.error !== undefined && (!m.at || (m.errorAt ?? "") >= m.at);
  return {
    area: i.area,
    label: READ_LABEL[i.area],
    configured: i.configured ?? true,
    available: i.available ?? "unknown",
    ...(m.at ? { at: m.at } : {}),
    ...(ageMs !== undefined ? { ageMs } : {}),
    limitMs,
    stale: ageMs !== undefined && ageMs > limitMs,
    failed,
    ...(failed && m.error ? { error: m.error } : {}),
    ...(failed && m.errorAt ? { errorAt: m.errorAt } : {}),
    ...(i.completeness ? { completeness: i.completeness } : {}),
    cost: i.cost,
  };
}

// A read needs a person when it failed, is incomplete, or is past its limit.
export function readTrouble(
  s: ReadSignal,
): "failed" | "incomplete" | "stale" | "unread" | undefined {
  if (!s.configured) return undefined;
  if (s.failed) return "failed";
  if (!s.at) return "unread";
  if (s.completeness && !s.completeness.complete) return "incomplete";
  if (s.stale) return "stale";
  return undefined;
}
