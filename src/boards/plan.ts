// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { CanvasActionItem, CanvasBoardView } from "@keelson/shared";
import { briefInputs } from "../brief/inputs.ts";
import { peopleRows } from "../brief/people.ts";
import { currentOperation, isActive } from "../plan/apply.ts";
import { isExpired, type Plan, type PlanKind, planStats, type Subject } from "../plan/model.ts";
import { coverage } from "../plan/seismic.ts";
import { inputsOf, planState } from "../plan/state.ts";
import { shortSeismicGroup } from "../plan/steps.ts";
import { EMPTY_BOARD } from "../resting.ts";
import type { Runtime } from "../runtime.ts";
import { clock } from "../sweep.ts";
import { SIGNIN_REASON } from "./connection.ts";
import { factSection } from "./inspect.ts";
import { measuredSeismic } from "./seismic.ts";

type Section = CanvasBoardView["sections"][number];
type Card = Extract<Section, { kind: "cards" }>["items"][number];

export const APPLY_PLAN_ACTION = "apply-plan";
export const RECHECK_PLAN_ACTION = "recheck-plan";
export const DISCARD_PLAN_ACTION = "discard-plan";
export const EXPORT_PLAN_ACTION = "export-dry-run";

const JOURNEY: Record<PlanKind, { title: string; text?: string }[]> = {
  "seismic-grant": [
    {
      title: "Subproject ACL group",
      text: "By object id; a shared group reaches every subproject on it",
    },
    { title: "Verify", text: "Effective groups, one more than before" },
  ],
  "seismic-revoke": [
    { title: "Subproject ACL group", text: "Reach through data.default is not touched" },
    { title: "Verify", text: "Effective groups, one fewer than before" },
  ],
};

function minutesLeft(plan: Plan, now: Date): number {
  return Math.max(0, Math.ceil((Date.parse(plan.expiresAt) - now.getTime()) / 60_000));
}

function stepCard(s: Subject): Card {
  const title = s.name && s.name !== s.address ? `${s.address} · ${s.name}` : s.address;
  return {
    title,
    mono: true,
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
    ...(s.reason ? { reason: { label: s.blocked ? "Blocked" : "Note", text: s.reason } } : {}),
  };
}

function peopleSub(plan: Plan): string {
  const inputs = inputsOf(plan);
  return `${inputs.role} · ${inputs.subproject}`;
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
        sub: only ? `all for ${only}` : "membership writes",
      },
      { label: "Already true", value: st.alreadyTrue, sub: "a 409 on apply counts here" },
      {
        label: "Blocked",
        value: st.blocked,
        ...(st.blocked > 0 ? { tone: "warn" as const } : {}),
        sub: st.blocked > 0 ? "nothing is written for these" : "none",
      },
      {
        label: "People",
        value: st.subjects,
        sub: peopleSub(plan),
      },
    ],
  };
}

function blockedRows(plan: Plan): Section | undefined {
  const items = plan.subjects
    .filter((s) => s.blocked)
    .map((s) => ({
      chip: { label: "blocked", tone: "warn" as const },
      text: s.address,
      trailing: s.reason ?? "",
    }));
  return items.length > 0 ? { kind: "rows", title: `Blocked · ${items.length}`, items } : undefined;
}

function dryRunCard(plan: Plan): Section {
  const lines = plan.subjects.reduce((n, s) => n + s.steps.length, 0);
  const blocked = plan.subjects.filter((s) => s.blocked).length;
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

function confirmFor(plan: Plan, changes: number): Partial<CanvasActionItem> {
  const label = `Apply ${changes} change${changes === 1 ? "" : "s"}`;
  const inputs = inputsOf(plan);
  const reason = plan.subjects[0]?.reason;
  if (inputs.kind === "seismic-revoke") {
    const subject = plan.subjects[0]?.name ?? plan.subjects[0]?.address ?? plan.id;
    return {
      destructive: true,
      inline: true,
      confirm: {
        irreversible: true,
        subject,
        title: `Revoke ${subject}`,
        body: `Removes ${subject} from the ${inputs.role} group of ${inputs.subproject}. ${reason ?? ""}`.trim(),
        confirmLabel: label,
      },
    };
  }
  const who = plan.subjects[0]?.name ?? plan.subjects[0]?.address;
  const parts = [
    ...(who ? [`Adds ${who} to the ${inputs.role} group of ${inputs.subproject}.`] : []),
    ...(reason ? [reason] : []),
    `${changes} membership write${changes === 1 ? "" : "s"}.`,
    "The dry run is re-checked first.",
  ];
  return { confirm: { title: `${label}?`, body: parts.join(" "), confirmLabel: label } };
}

function actions(rt: Runtime, plan: Plan): Section {
  const binding = { ...plan.binding, planId: plan.id };
  const st = planStats(plan);
  const signedOut = rt.status.phase !== "connected";
  const expired = isExpired(plan, rt.now());
  const handedOff = planState(rt).appliedAs === plan.id;
  const busy = isActive(currentOperation(rt));
  const applyReason = signedOut
    ? SIGNIN_REASON
    : handedOff
      ? "this plan was applied; see Operation"
      : expired
        ? "the plan expired; Recheck to refresh it"
        : st.willChange === 0
          ? "nothing to change"
          : busy
            ? "another plan is applying; see Operation"
            : undefined;
  const items: CanvasActionItem[] = [
    {
      type: APPLY_PLAN_ACTION,
      label: `Apply ${st.willChange} change${st.willChange === 1 ? "" : "s"}`,
      tone: "brand",
      binding,
      pendingLabel: "Starting…",
      ...confirmFor(plan, st.willChange),
      ...(applyReason ? { disabled: true, reason: applyReason } : {}),
    },
    {
      type: RECHECK_PLAN_ACTION,
      label: "Recheck",
      binding,
      pendingLabel: "Rechecking…",
      ...(signedOut || handedOff
        ? { disabled: true, reason: handedOff ? "this plan was applied" : SIGNIN_REASON }
        : {}),
    },
    { type: EXPORT_PLAN_ACTION, label: "Save dry run CSV", binding },
    { type: DISCARD_PLAN_ACTION, label: handedOff ? "Close plan" : "Discard plan", binding },
  ];
  return { kind: "actions", wrap: true, items };
}

const GROUP_PATH = /\/groups\/([^/]+)\/members/;

function roleMark(roles: ReadonlySet<string>): string {
  return roles.has("admin") && roles.has("viewer")
    ? "Admin and Viewer"
    : roles.has("admin")
      ? "Admin"
      : roles.has("viewer")
        ? "Viewer"
        : "none";
}

// Who the change is for, what it does to every subproject a touched group backs, and
// how far each group reaches, read from the dry run's own steps.
function seismicSections(rt: Runtime, plan: Plan): Section[] {
  const model = measuredSeismic(rt)?.model;
  const subject = plan.subjects[0];
  if (!model || !subject?.oid) return [];
  const id = subject.oid;
  const out: Section[] = [];
  const row = peopleRows(briefInputs(rt)).find((r) => r.id === id);
  if (row) out.push(factSection(`Who · ${row.name}`, row.ladder));
  const cover = coverage(model);
  const roleOf = new Map<string, "admin" | "viewer">();
  for (const sub of model.subprojects) {
    for (const g of sub.adminGroups) roleOf.set(g, "admin");
    for (const g of sub.viewerGroups) if (!roleOf.has(g)) roleOf.set(g, "viewer");
  }
  const touched = new Map<string, { add: boolean; change: boolean }>();
  for (const step of subject.steps) {
    if (step.kind !== "member-add" && step.kind !== "member-remove") continue;
    const m = step.call ? GROUP_PATH.exec(step.call.path) : null;
    if (!m) continue;
    const group = decodeURIComponent(m[1] as string).toLowerCase();
    touched.set(group, { add: step.kind === "member-add", change: step.change && !step.already });
  }
  if (touched.size === 0) return out;
  const asked = inputsOf(plan).subproject;
  const subs = [...new Set([...touched.keys()].flatMap((g) => cover.get(g) ?? []))];
  const current = (sub: string) =>
    new Set((model.grants[id] ?? []).filter((g) => g.subproject === sub).map((g) => g.role));
  out.push({
    kind: "rows",
    boxed: true,
    title: `Current and proposed · ${subs.length} ${subs.length === 1 ? "subproject" : "subprojects"} touched`,
    items: subs.map((sub) => {
      const now = current(sub);
      const next = new Set(now);
      for (const [g, t] of touched) {
        if (!(cover.get(g) ?? []).includes(sub) || !t.change) continue;
        const role = roleOf.get(g);
        if (!role) continue;
        if (t.add) next.add(role);
        else next.delete(role);
      }
      const changed = roleMark(now) !== roleMark(next);
      return {
        glyph: changed ? ("warn" as const) : ("neutral" as const),
        text: sub === asked ? `${sub} · selected` : sub,
        trailing: changed ? `${roleMark(now)} → ${roleMark(next)}` : `${roleMark(now)}, unchanged`,
      };
    }),
  });
  out.push({
    kind: "rows",
    title: "Reach · every subproject each touched group backs",
    items: [...touched.keys()].map((g) => ({
      glyph: "neutral" as const,
      text: shortSeismicGroup(g),
      trailing: (cover.get(g) ?? []).join(", ") || "no subproject",
    })),
  });
  return out;
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
          items: [{ glyph: "info", text: "Reading the person's groups. Nothing is written." }],
        },
      ],
    };
  }
  if (!s.plan) {
    if (!s.error) {
      if (!rt.profile) return EMPTY_BOARD;
      return {
        view: "board",
        title: "Plan",
        sections: [
          {
            kind: "rows",
            items: [
              {
                glyph: "neutral",
                text: "No plan is open. Preview one from a cell in the console's Seismic view.",
              },
            ],
          },
        ],
      };
    }
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
    ...seismicSections(rt, plan),
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
  const blocked = blockedRows(plan);
  if (blocked) sections.push(blocked);
  sections.push({
    kind: "cards",
    title: `Steps per person · ${plan.subjects.length}`,
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
      status:
        s.appliedAs === plan.id
          ? { label: "applied · see Operation", tone: "info" }
          : expired
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
