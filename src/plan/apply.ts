// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { OpHandle } from "@keelson/shared";
import { z } from "zod";
import { measuredAccess } from "../boards/access.ts";
import type { Batch, CallResult } from "../client.ts";
import {
  ATTENTION_KEY,
  COHORTS_KEY,
  OPERATION_KEY,
  PEOPLE_KEY,
  PERSON_KEY,
  PLAN_KEY,
  PULSE_KEY,
  RECENT_KEY,
} from "../keys.ts";
import { measureSeismic } from "../modules/seismic.ts";
import { shortId } from "../profile.ts";
import type { Runtime } from "../runtime.ts";
import { buildPlan, type PlanInputs } from "./build.ts";
import { correlationId, isExpired, type Plan, type Step } from "./model.ts";
import { buildContext, inputsOf, planState } from "./state.ts";

export type StepState =
  | "queued"
  | "running"
  | "done"
  | "already"
  | "failed"
  | "mismatch"
  | "skipped";

export type OpStatus = "running" | "paused" | "halted" | "aborted" | "failed" | "done";

export interface OpStep {
  n: number;
  subject: string;
  text: string;
  state: StepState;
  note?: string;
}

export interface Operation {
  planId: string;
  title: string;
  status: OpStatus;
  startedAt: string;
  finishedAt?: string;
  reason?: string;
  // Step 0 is the re-run of the dry run; the rest are the plan's step lines.
  steps: OpStep[];
  // Object ids learned from invitations, by subject address.
  oids: Record<string, string>;
  plan: Plan;
}

const OP_FILE = "operation.json";
const ACCESS_KEYS = [PULSE_KEY, ATTENTION_KEY, PEOPLE_KEY, COHORTS_KEY, PERSON_KEY];
// An account created this long before Apply started is not one this plan invited.
const NEW_ACCOUNT_SLACK_MS = 5 * 60_000;

interface ExecState {
  op?: Operation;
  handle?: OpHandle;
  cancel?: boolean;
  pending?: Promise<void>;
}

const states = new WeakMap<Runtime, ExecState>();

function stateOf(rt: Runtime): ExecState {
  let s = states.get(rt);
  if (!s) {
    s = {};
    const saved = rt.readStore(
      OP_FILE,
      z.custom<Operation>((v) => typeof v === "object" && v !== null),
    );
    if (saved) {
      s.op =
        saved.status === "running"
          ? {
              ...saved,
              status: "paused",
              reason: "the server restarted while the plan was applying",
            }
          : saved;
    }
    states.set(rt, s);
  }
  return s;
}

export function currentOperation(rt: Runtime): Operation | undefined {
  return stateOf(rt).op;
}

export function operationPending(rt: Runtime): Promise<void> | undefined {
  return stateOf(rt).pending;
}

function save(rt: Runtime, op: Operation): void {
  rt.writeStore(OP_FILE, op);
  rt.recompose([OPERATION_KEY]);
}

export function isActive(op: Operation | undefined): boolean {
  return op?.status === "running" || op?.status === "paused";
}

function initialSteps(plan: Plan): OpStep[] {
  const steps: OpStep[] = [{ n: 0, subject: "", text: "Re-run the dry run", state: "queued" }];
  for (const s of plan.subjects) {
    if (s.blocked) continue;
    for (const t of s.steps) {
      steps.push({
        n: t.n,
        subject: s.address,
        text: t.text,
        state: t.already ? "already" : "queued",
        ...(t.already ? { note: "already true at dry run" } : {}),
      });
    }
  }
  return steps;
}

export type ApplyResult = { ok: true; message: string } | { ok: false; error: string };

export function startApply(rt: Runtime, plan: Plan): ApplyResult {
  const s = stateOf(rt);
  if (isActive(s.op)) {
    return {
      ok: false,
      error: `Plan ${s.op?.planId} is still ${s.op?.status}. Resume or dismiss it first.`,
    };
  }
  if (isExpired(plan, rt.now())) return { ok: false, error: "The plan expired. Recheck it first." };
  const op: Operation = {
    planId: plan.id,
    title: plan.title,
    status: "running",
    startedAt: rt.now().toISOString(),
    steps: initialSteps(plan),
    oids: Object.fromEntries(
      plan.subjects.filter((x) => x.oid).map((x) => [x.address, x.oid as string]),
    ),
    plan,
  };
  s.op = op;
  delete s.cancel;
  const handle = rt.registerOp({
    kind: "adme_apply",
    title: `Apply plan ${plan.id}: ${plan.title}`,
  });
  if (handle) {
    s.handle = handle;
    handle.signal.addEventListener("abort", () => {
      s.cancel = true;
    });
  }
  planState(rt).appliedAs = plan.id;
  save(rt, op);
  rt.recompose([PLAN_KEY]);
  s.pending = drive(rt, s, true);
  const changes = op.steps.filter((t) => t.state === "queued" && t.n > 0).length;
  return { ok: true, message: `Plan ${plan.id} started: ${changes} steps queued` };
}

export function resumeApply(rt: Runtime): ApplyResult {
  const s = stateOf(rt);
  const op = s.op;
  if (op?.status !== "paused") return { ok: false, error: "No paused plan to resume." };
  if (rt.status.phase !== "connected") {
    return { ok: false, error: "Sign-in needed: run az login, then Re-test." };
  }
  op.status = "running";
  delete op.reason;
  delete s.cancel;
  save(rt, op);
  s.pending = drive(rt, s, false);
  return { ok: true, message: `Plan ${op.planId} resumed` };
}

export function cancelApply(rt: Runtime): ApplyResult {
  const s = stateOf(rt);
  if (s.op?.status === "running") {
    s.cancel = true;
    return { ok: true, message: "Stopping after the current step" };
  }
  if (s.op?.status === "paused") {
    finish(rt, s, "aborted", "cancelled while paused; completed steps are kept");
    return { ok: true, message: `Plan ${s.op.planId} cancelled` };
  }
  return { ok: false, error: "No plan is applying." };
}

export function dismissOperation(rt: Runtime): ApplyResult {
  const s = stateOf(rt);
  if (!s.op) return { ok: false, error: "Nothing to dismiss." };
  if (isActive(s.op)) return { ok: false, error: "Cancel or resume the plan first." };
  delete s.op;
  rt.writeStore(OP_FILE, null);
  rt.recompose([OPERATION_KEY]);
  return { ok: true, message: "Dismissed" };
}

async function drive(rt: Runtime, s: ExecState, fresh: boolean): Promise<void> {
  const op = s.op as Operation;
  try {
    if (fresh && !(await recheck(rt, s, op))) return;
    await runSteps(rt, s, op);
  } catch (err) {
    finish(rt, s, "failed", err instanceof Error ? err.message : String(err));
  }
}

// Apply re-runs the dry run against a fresh sweep; any difference aborts before a write.
async function recheck(rt: Runtime, s: ExecState, op: Operation): Promise<boolean> {
  const head = op.steps[0] as OpStep;
  head.state = "running";
  save(rt, op);
  await rt.sweep();
  const ctx = buildContext(rt);
  if (!ctx || rt.status.phase !== "connected") {
    pause(rt, s, op, head, "sign-in lapsed before the dry run could be re-run");
    return false;
  }
  const again = await rt.run((b) => buildPlan(b, inputsOf(op.plan) as PlanInputs, ctx));
  if (!again.ok) {
    if (again.failure.kind === "signin" && again.failure.status === null) {
      pause(rt, s, op, head, "sign-in lapsed while re-running the dry run");
    } else {
      head.state = "failed";
      finish(rt, s, "aborted", `the dry run could not be re-run: ${again.failure.message}`);
    }
    return false;
  }
  if (again.data.hash !== op.plan.hash) {
    head.state = "failed";
    head.note = "changed";
    finish(
      rt,
      s,
      "aborted",
      `the dry run changed since ${op.plan.createdAt.slice(11, 16)}Z; nothing was written`,
    );
    return false;
  }
  head.state = "done";
  head.note = "nothing changed";
  save(rt, op);
  return true;
}

function planStep(op: Operation, n: number): { step: Step; subject: string } | undefined {
  for (const s of op.plan.subjects) {
    const step = s.steps.find((t) => t.n === n);
    if (step) return { step, subject: s.address };
  }
  return undefined;
}

async function runSteps(rt: Runtime, s: ExecState, op: Operation): Promise<void> {
  for (const line of op.steps) {
    if (line.n === 0 || line.state !== "queued") continue;
    if (s.cancel) {
      finish(rt, s, "aborted", `cancelled before step ${line.n}; completed steps are kept`);
      return;
    }
    const found = planStep(op, line.n);
    if (!found) continue;
    line.state = "running";
    save(rt, op);
    s.handle?.progress(`step ${line.n}: ${line.text}`);
    const outcome = await runStep(rt, op, found.step, found.subject);
    if (outcome.kind === "ok") {
      line.state = outcome.state;
      if (outcome.note) line.note = outcome.note;
      save(rt, op);
      continue;
    }
    if (outcome.kind === "pause") {
      pause(rt, s, op, line, outcome.reason);
      return;
    }
    line.state = "failed";
    line.note = outcome.reason;
    for (const rest of op.steps) if (rest.state === "queued") rest.state = "skipped";
    finish(rt, s, outcome.kind === "halt" ? "halted" : "failed", outcome.reason);
    return;
  }
  finish(rt, s, "done");
}

type Outcome =
  | { kind: "ok"; state: StepState; note?: string }
  | { kind: "pause"; reason: string }
  | { kind: "halt"; reason: string }
  | { kind: "fail"; reason: string };

function substitute(value: unknown, oid: string | undefined): unknown {
  if (oid === undefined) return value;
  return JSON.parse(JSON.stringify(value ?? null).replaceAll("{oid}", oid));
}

async function runStep(rt: Runtime, op: Operation, step: Step, subject: string): Promise<Outcome> {
  if (step.kind === "wait") {
    await rt.sleep(step.waitMs ?? 0);
    return { kind: "ok", state: "done" };
  }
  const call = step.call;
  if (!call) return { kind: "ok", state: "done" };
  const oid = op.oids[subject];
  if (call.path.includes("{oid}") && !oid) {
    return {
      kind: "fail",
      reason: "the object id is not known; the invitation did not return one",
    };
  }
  const path = call.path.replaceAll("{oid}", oid ?? "");
  const body = call.body === undefined ? undefined : substitute(call.body, oid);
  const res = await rt.run<unknown>((b: Batch) =>
    call.service === "graph"
      ? b.graph(path, { method: call.method, ...(body !== undefined ? { body } : {}) })
      : b.adme("entitlements", path, {
          method: call.method,
          ...(body !== undefined ? { body } : {}),
          correlationId: correlationId(op.plan, step),
        }),
  );
  if (!res.ok) return failure(step, res);
  if (step.kind === "invite") return afterInvite(rt, op, subject, res.data);
  if (step.kind === "verify") return verified(step, res.data);
  return { kind: "ok", state: "done" };
}

function failure(step: Step, res: Extract<CallResult<unknown>, { ok: false }>): Outcome {
  const f = res.failure;
  if (f.kind === "conflict") return { kind: "ok", state: "already", note: "409, already true" };
  if (step.kind === "roster-add" && f.status === 400 && /already exist/i.test(f.message)) {
    return { kind: "ok", state: "already", note: "already in the roster group" };
  }
  if ((step.kind === "member-remove" || step.kind === "roster-remove") && f.kind === "not-found") {
    return { kind: "ok", state: "already", note: "404, already gone" };
  }
  if (f.kind === "signin") {
    return { kind: "pause", reason: `sign-in lapsed at step ${step.n}` };
  }
  if (f.kind === "server" || f.kind === "network" || f.kind === "timeout") {
    return { kind: "pause", reason: `the service did not answer at step ${step.n} (${f.message})` };
  }
  return { kind: "fail", reason: `${f.status ?? f.kind}: ${f.message}` };
}

interface Invited {
  invitedUser?: { id?: string };
}

// An invitation to a new address can resolve to an existing guest and return that guest's id.
async function afterInvite(
  rt: Runtime,
  op: Operation,
  subject: string,
  data: unknown,
): Promise<Outcome> {
  const id = (data as Invited | undefined)?.invitedUser?.id?.toLowerCase();
  if (!id) return { kind: "halt", reason: "the invitation returned no object id" };
  const expected = op.plan.subjects.find((x) => x.address === subject)?.oid;
  if (expected) {
    return id === expected
      ? { kind: "ok", state: "done", note: "invitation sent again" }
      : {
          kind: "halt",
          reason: `the invitation for ${subject} returned another account (${shortId(id)}), not ${shortId(expected)}`,
        };
  }
  const model = measuredAccess(rt)?.model;
  const known = [...(model?.people ?? []), ...(model?.apps ?? []), ...(model?.unknown ?? [])].find(
    (x) => x.id === id,
  );
  if (known) {
    return {
      kind: "halt",
      reason: `the invitation for ${subject} returned ${known.name}'s account (${shortId(id)}); nothing more was written`,
    };
  }
  const user = await rt.run<{ createdDateTime?: string; displayName?: string }>((b) =>
    b.graph(`/v1.0/users/${id}?$select=id,displayName,createdDateTime`),
  );
  if (!user.ok)
    return {
      kind: "halt",
      reason: `the invited account could not be checked: ${user.failure.message}`,
    };
  const created = user.data.createdDateTime ? Date.parse(user.data.createdDateTime) : Number.NaN;
  if (Number.isFinite(created) && created < Date.parse(op.startedAt) - NEW_ACCOUNT_SLACK_MS) {
    return {
      kind: "halt",
      reason: `the invitation for ${subject} returned an existing account, ${user.data.displayName ?? shortId(id)} (${shortId(id)}), created ${user.data.createdDateTime?.slice(0, 10)}; nothing more was written`,
    };
  }
  op.oids[subject] = id;
  return { kind: "ok", state: "done", note: `invited, ${shortId(id)}` };
}

function verified(step: Step, data: unknown): Outcome {
  const groups = (data as { groups?: unknown[] } | undefined)?.groups;
  const got = Array.isArray(groups) ? groups.length : undefined;
  if (got === undefined || step.expect === undefined) return { kind: "ok", state: "done" };
  return got === step.expect
    ? { kind: "ok", state: "done", note: `${got} groups` }
    : { kind: "ok", state: "mismatch", note: `got ${got}, expected ${step.expect}` };
}

function pause(rt: Runtime, s: ExecState, op: Operation, line: OpStep, reason: string): void {
  line.state = "queued";
  op.status = "paused";
  op.reason = reason;
  save(rt, op);
  s.handle?.log(`paused: ${reason}`);
  rt.tracker.record(
    [{ kind: "paused", plan: op.planId, text: `${capital(op.title)}, ${reason}` }],
    rt.now(),
  );
  rt.recompose([RECENT_KEY]);
}

function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function finish(rt: Runtime, s: ExecState, status: OpStatus, reason?: string): void {
  const op = s.op as Operation;
  op.status = status;
  op.finishedAt = rt.now().toISOString();
  if (reason) op.reason = reason;
  else delete op.reason;
  save(rt, op);
  const mismatches = op.steps.filter((t) => t.state === "mismatch");
  const subjects = [
    ...new Set(op.steps.filter((t) => t.state === "done" && t.subject).map((t) => t.subject)),
  ];
  const events: { kind: string; plan: string; text: string; who?: string }[] = [];
  if (status === "done") {
    events.push({
      kind: "applied",
      plan: op.planId,
      text: `${capital(op.title)}${mismatches.length > 0 ? `, ${mismatches.length} verify mismatch` : ""}`,
    });
    for (const subject of subjects) {
      const who = op.oids[subject] ?? op.plan.subjects.find((x) => x.address === subject)?.oid;
      events.push({
        kind: "applied",
        plan: op.planId,
        text: `Plan ${op.planId}: ${op.title}`,
        ...(who ? { who } : {}),
      });
    }
    const inputs = inputsOf(op.plan);
    if (inputs.kind === "add-people" && inputs.cohort) {
      const added = op.plan.subjects.filter((x) => !x.blocked).map((x) => x.address);
      rt.tracker.assign(added, inputs.cohort, inputs.passEnds);
    }
  } else {
    events.push({
      kind: status,
      plan: op.planId,
      text: `${capital(op.title)}, ${reason ?? status}`,
    });
  }
  rt.tracker.record(events.reverse(), rt.now());
  if (status === "done" || status === "halted" || status === "failed") {
    s.handle?.[status === "done" ? "done" : "error"](reason ?? `plan ${op.planId} applied`);
  } else if (status === "aborted") {
    s.handle?.error(reason ?? "aborted");
  }
  delete s.handle;
  rt.recompose([RECENT_KEY, PLAN_KEY]);
  if (status !== "aborted") {
    rt.sweep()
      .then(() => rt.recompose(ACCESS_KEYS))
      .catch(() => undefined);
    if (op.plan.kind.startsWith("seismic-")) measureSeismic(rt).catch(() => undefined);
  }
}
