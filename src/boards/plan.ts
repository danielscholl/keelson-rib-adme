// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { CanvasActionItem, CanvasBoardView, CanvasTone } from "@keelson/shared";
import {
  type Classification,
  isExpired,
  type Plan,
  type PlanKind,
  planStats,
  type Subject,
} from "../plan/model.ts";
import { inputsOf, planState } from "../plan/state.ts";
import { EMPTY_BOARD } from "../resting.ts";
import type { Runtime } from "../runtime.ts";
import { clock } from "../sweep.ts";
import { SIGNIN_REASON } from "./connection.ts";

type Section = CanvasBoardView["sections"][number];
type Card = Extract<Section, { kind: "cards" }>["items"][number];

export const APPLY_PLAN_ACTION = "apply-plan";
export const RECHECK_PLAN_ACTION = "recheck-plan";
export const DISCARD_PLAN_ACTION = "discard-plan";
export const EXPORT_PLAN_ACTION = "export-dry-run";

const PILL: Record<Classification, { label: string; tone: CanvasTone }> = {
  "will-invite": { label: "will invite", tone: "info" },
  "existing-guest": { label: "existing guest", tone: "neutral" },
  "existing-member": { label: "existing member", tone: "neutral" },
  restorable: { label: "restore", tone: "info" },
  ambiguous: { label: "ambiguous", tone: "warn" },
  "same-identity": { label: "existing guest", tone: "warn" },
  "has-access": { label: "has access", tone: "neutral" },
  application: { label: "application", tone: "neutral" },
};

const JOURNEY: Record<PlanKind, { title: string; text?: string }[]> = {
  "add-people": [
    {
      title: "Resolve identity",
      text: "By mail, other mails and deleted users, before any invite",
    },
    { title: "Invite or reuse", text: "An invite to a known identity halts the plan" },
    { title: "Roster group" },
    { title: "Entitlements", text: "users@ and the role group, by object id" },
    { title: "Verify", text: "Effective groups against the expected count" },
  ],
  "add-app": [
    { title: "Entitlements", text: "users@ and the role group, by app id" },
    { title: "Verify" },
  ],
  "fix-users": [{ title: "Add to users@" }, { title: "Verify" }],
  "cleanup-duplicate": [
    { title: "Remove the entry by email", text: "The entry by object id stays" },
    { title: "Verify" },
  ],
  "remove-person": [
    { title: "Role groups" },
    { title: "users@" },
    { title: "Roster group", text: "The Entra guest account is kept" },
  ],
};

function minutesLeft(plan: Plan, now: Date): number {
  return Math.max(0, Math.ceil((Date.parse(plan.expiresAt) - now.getTime()) / 60_000));
}

function stepCard(s: Subject): Card {
  const pill = PILL[s.classification];
  const title = s.name && s.name !== s.address ? `${s.address} · ${s.name}` : s.address;
  return {
    title,
    mono: true,
    pill,
    ...(s.blocked ? { edge: "warn" as const } : {}),
    ...(s.steps.length > 0
      ? {
          stacked: true,
          fields: s.steps.map((t) => ({
            label: String(t.n),
            value: t.already ? `already true · ${t.text}` : t.text,
            ...(t.already ? { tone: "ok" as const } : {}),
          })),
        }
      : {}),
    ...(s.footnote ? { footnote: s.footnote } : {}),
    ...(s.reason ? { reason: { label: s.blocked ? "Blocked" : "Note", text: s.reason } } : {}),
  };
}

function peopleSub(plan: Plan): string {
  const inputs = inputsOf(plan);
  if (inputs.kind === "add-people") {
    return [inputs.role, inputs.cohort].filter(Boolean).join(" · ");
  }
  if (inputs.kind === "add-app") return `${inputs.role} · application`;
  return plan.subjects[0]?.name ?? "";
}

function stats(plan: Plan): Section {
  const st = planStats(plan);
  const changing = plan.subjects.filter(
    (s) => !s.blocked && s.steps.some((t) => t.change && !t.already),
  );
  const only = changing.length === 1 ? changing[0]?.address.split("@")[0] : undefined;
  return {
    kind: "stats",
    title: `Dry run result, ${clock(plan.createdAt)}`,
    items: [
      {
        label: "Will change",
        value: st.willChange,
        sub: only ? `all for ${only}` : "membership writes and invites",
      },
      { label: "Already true", value: st.alreadyTrue, sub: "a 409 on apply counts here" },
      {
        label: "Blocked",
        value: st.blocked,
        ...(st.blocked > 0 ? { tone: "warn" as const } : {}),
        sub: st.blocked > 0 ? "nothing is written for these" : "none",
      },
      {
        label: plan.kind === "add-app" ? "Applications" : "People",
        value: st.subjects,
        sub: peopleSub(plan),
      },
    ],
  };
}

function excludedRows(plan: Plan): Section | undefined {
  const items = [
    ...plan.subjects
      .filter((s) => s.blocked)
      .map((s) => ({
        chip: { label: "blocked", tone: "warn" as const },
        text: s.address,
        trailing: s.reason ?? "",
      })),
    ...plan.excluded.map((e) => ({
      chip: { label: "excluded", tone: "neutral" as const },
      text: e.address,
      trailing: e.reason,
    })),
  ];
  return items.length > 0
    ? { kind: "rows", title: `Protected or excluded · ${items.length}`, items }
    : undefined;
}

function dryRunCard(plan: Plan): Section {
  const lines = plan.subjects.reduce((n, s) => n + s.steps.length, 0);
  const blocked = plan.subjects.filter((s) => s.blocked).length + plan.excluded.length;
  return {
    kind: "cards",
    boxed: true,
    items: [
      {
        title: "Dry run",
        fields: [
          {
            label: "Dry run CSV",
            value: `plan-${plan.id}-dry-run.csv · ${lines} step lines, ${blocked} blocked`,
            copyable: true,
          },
          { label: "Correlation id", value: `keelson-adme-${plan.id}-<n>`, copyable: true },
        ],
      },
    ],
  };
}

function actions(rt: Runtime, plan: Plan): Section {
  const binding = { ...plan.binding, planId: plan.id };
  const st = planStats(plan);
  const signedOut = rt.status.phase !== "connected";
  const expired = isExpired(plan, rt.now());
  const applyReason = signedOut
    ? SIGNIN_REASON
    : expired
      ? "the plan expired; Recheck to refresh it"
      : st.willChange === 0
        ? "nothing to change"
        : "Apply is not available yet";
  const items: CanvasActionItem[] = [
    {
      type: APPLY_PLAN_ACTION,
      label: `Apply ${st.willChange} change${st.willChange === 1 ? "" : "s"}`,
      tone: "brand",
      binding,
      disabled: true,
      reason: applyReason,
    },
    {
      type: RECHECK_PLAN_ACTION,
      label: "Recheck",
      binding,
      pendingLabel: "Rechecking…",
      ...(signedOut ? { disabled: true, reason: SIGNIN_REASON } : {}),
    },
    { type: EXPORT_PLAN_ACTION, label: "Save dry run CSV", binding },
    { type: DISCARD_PLAN_ACTION, label: "Discard plan", binding },
  ];
  return { kind: "actions", wrap: true, items };
}

export function composePlan(rt: Runtime): CanvasBoardView {
  const s = planState(rt);
  if (s.building && !s.plan) {
    return {
      view: "board",
      title: `Plan · ${s.building.title}`,
      header: { status: { label: "building the dry run", tone: "info" } },
      sections: [
        {
          kind: "rows",
          items: [{ glyph: "info", text: "Resolving each identity. Nothing is written." }],
        },
      ],
    };
  }
  if (!s.plan) {
    if (!s.error) return EMPTY_BOARD;
    return {
      view: "board",
      title: "Plan",
      header: { status: { label: "dry run failed", tone: "error" } },
      sections: [{ kind: "rows", items: [{ glyph: "error", text: s.error }] }],
    };
  }
  const plan = s.plan;
  const now = rt.now();
  const expired = isExpired(plan, now);
  const sections: Section[] = [
    { kind: "journey", title: "What apply does, in order", items: JOURNEY[plan.kind] },
  ];
  if (s.changedFrom) {
    sections.push({
      kind: "rows",
      items: [
        {
          glyph: "warn",
          text: `The dry run changed since plan ${s.changedFrom.id} at ${clock(s.changedFrom.at)}. This is a new plan.`,
        },
      ],
    });
  }
  if (s.error) sections.push({ kind: "rows", items: [{ glyph: "error", text: s.error }] });
  sections.push(stats(plan));
  const excluded = excludedRows(plan);
  if (excluded) sections.push(excluded);
  sections.push({
    kind: "cards",
    title: `Steps per ${plan.kind === "add-app" ? "application" : "person"} · ${plan.subjects.length}`,
    items: plan.subjects.map(stepCard),
  });
  sections.push(dryRunCard(plan));
  sections.push({
    kind: "rows",
    items: [
      {
        glyph: "info",
        text: `Apply re-runs the dry run first and stops if anything changed since ${clock(plan.createdAt)}.`,
      },
    ],
  });
  sections.push(actions(rt, plan));
  return {
    view: "board",
    title: `Plan · ${plan.title}`,
    header: {
      status: expired
        ? { label: "expired · nothing changed", tone: "warn" }
        : s.building
          ? { label: "rechecking", tone: "info" }
          : { label: "dry run · nothing changed", tone: "neutral" },
      chip: expired
        ? `plan ${plan.id} · expired`
        : `plan ${plan.id} · expires in ${minutesLeft(plan, now)} min`,
    },
    sections,
  };
}
