// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { createHash, randomBytes } from "node:crypto";
import type { Profile } from "../profile.ts";

export const PLAN_TTL_MS = 30 * 60_000;
export const REPLICATION_WAIT_MS = 10_000;

export type PlanKind =
  | "add-people"
  | "add-app"
  | "fix-users"
  | "cleanup-duplicate"
  | "remove-person";

export type Classification =
  | "will-invite"
  | "existing-guest"
  | "existing-member"
  | "restorable"
  | "ambiguous"
  | "same-identity"
  | "has-access"
  | "application";

export interface Call {
  service: "graph" | "entitlements";
  method: "GET" | "POST" | "DELETE";
  // `{oid}` stands for an object id the plan only learns when an invitation returns.
  path: string;
  body?: unknown;
}

export type StepKind =
  | "invite"
  | "restore"
  | "wait"
  | "roster-add"
  | "roster-remove"
  | "member-add"
  | "member-remove"
  | "verify";

export interface Step {
  n: number;
  subject: string;
  kind: StepKind;
  text: string;
  call?: Call;
  // Counts as a change when it would write; a wait or a verify read never does.
  change: boolean;
  // True already at dry run; Apply skips it, and a 409 lands here too.
  already?: boolean;
  expect?: number;
  waitMs?: number;
}

export interface Subject {
  address: string;
  classification: Classification;
  oid?: string;
  name?: string;
  blocked: boolean;
  reason?: string;
  steps: Step[];
  footnote?: string;
}

export interface Excluded {
  address: string;
  reason: string;
}

export interface Binding {
  host: string;
  partition: string;
  tenantId: string;
}

export interface Plan {
  id: string;
  kind: PlanKind;
  title: string;
  createdAt: string;
  expiresAt: string;
  binding: Binding;
  // What the operator asked for, so Recheck and Apply can rebuild the dry run.
  inputs: Record<string, unknown>;
  subjects: Subject[];
  excluded: Excluded[];
  hash: string;
}

export interface PlanStats {
  willChange: number;
  alreadyTrue: number;
  blocked: number;
  subjects: number;
}

export function newPlanId(): string {
  return randomBytes(2).toString("hex");
}

export function bindingOf(profile: Profile): Binding {
  return { host: profile.host, partition: profile.partition, tenantId: profile.tenantId };
}

export function sameBinding(a: Binding, b: Binding): boolean {
  return a.host === b.host && a.partition === b.partition && a.tenantId === b.tenantId;
}

// What the dry run found, without ids or timestamps, so a recheck that finds the
// same world produces the same hash.
export function planHash(plan: Omit<Plan, "hash" | "id" | "createdAt" | "expiresAt">): string {
  const canonical = JSON.stringify({
    kind: plan.kind,
    binding: plan.binding,
    inputs: plan.inputs,
    excluded: plan.excluded,
    subjects: plan.subjects.map((s) => ({
      address: s.address,
      classification: s.classification,
      oid: s.oid ?? null,
      blocked: s.blocked,
      steps: s.steps.map((t) => ({
        kind: t.kind,
        call: t.call ?? null,
        already: t.already ?? false,
        expect: t.expect ?? null,
      })),
    })),
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 12);
}

export function finishPlan(
  draft: Omit<Plan, "hash" | "id" | "createdAt" | "expiresAt">,
  now: Date,
  id = newPlanId(),
): Plan {
  return {
    ...draft,
    id,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + PLAN_TTL_MS).toISOString(),
    hash: planHash(draft),
  };
}

export function planStats(plan: Plan): PlanStats {
  let willChange = 0;
  let alreadyTrue = 0;
  for (const s of plan.subjects) {
    if (s.blocked) continue;
    for (const t of s.steps) {
      if (!t.change) continue;
      if (t.already) alreadyTrue++;
      else willChange++;
    }
  }
  return {
    willChange,
    alreadyTrue,
    blocked: plan.subjects.filter((s) => s.blocked).length,
    subjects: plan.subjects.length,
  };
}

export function isExpired(plan: Plan, now: Date): boolean {
  return now.getTime() >= Date.parse(plan.expiresAt);
}

export function correlationId(plan: Plan, step: Step): string {
  return `keelson-adme-${plan.id}-${step.n}`;
}

export type DraftSubject = Omit<Subject, "steps"> & { steps: Omit<Step, "n">[] };

export function numberSteps(subjects: DraftSubject[]): Subject[] {
  let n = 0;
  return subjects.map((s) => ({ ...s, steps: s.steps.map((t) => ({ ...t, n: ++n })) }));
}

function csv(value: unknown): string {
  const text = value === undefined || value === null ? "" : String(value);
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function dryRunCsv(plan: Plan): string {
  const lines = ["plan,step,subject,classification,call,change,already_true,blocked,note"];
  for (const s of plan.subjects) {
    if (s.blocked) {
      lines.push(
        [plan.id, "", s.address, s.classification, "", "", "", "yes", s.reason].map(csv).join(","),
      );
      continue;
    }
    for (const t of s.steps) {
      const call = t.call ? `${t.call.method} ${t.call.service} ${t.call.path}` : t.text;
      lines.push(
        [
          plan.id,
          t.n,
          s.address,
          s.classification,
          call,
          t.change ? "yes" : "no",
          t.already ? "yes" : "no",
          "no",
          t.expect !== undefined ? `expect ${t.expect}` : "",
        ]
          .map(csv)
          .join(","),
      );
    }
  }
  for (const e of plan.excluded) {
    lines.push(
      [plan.id, "", e.address, "excluded", "", "", "", "yes", e.reason].map(csv).join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}
