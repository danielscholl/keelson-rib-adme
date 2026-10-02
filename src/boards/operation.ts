// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { CanvasActionItem, CanvasBoardView, CanvasTone } from "@keelson/shared";
import { currentOperation, type OpStatus, type StepState } from "../plan/apply.ts";
import { EMPTY_BOARD } from "../resting.ts";
import type { Runtime } from "../runtime.ts";
import { clock } from "../sweep.ts";
import { SIGNIN_REASON } from "./connection.ts";

type Section = CanvasBoardView["sections"][number];

export const RESUME_OPERATION_ACTION = "resume-operation";
export const CANCEL_OPERATION_ACTION = "cancel-operation";
export const DISMISS_OPERATION_ACTION = "dismiss-operation";

const STEP_CHIP: Record<StepState, { label: string; tone: CanvasTone }> = {
  queued: { label: "queued", tone: "neutral" },
  running: { label: "running", tone: "info" },
  done: { label: "done", tone: "ok" },
  already: { label: "already", tone: "ok" },
  failed: { label: "failed", tone: "error" },
  mismatch: { label: "mismatch", tone: "warn" },
  skipped: { label: "skipped", tone: "neutral" },
};

const STATUS_TONE: Record<OpStatus, CanvasTone> = {
  running: "info",
  paused: "warn",
  halted: "error",
  aborted: "warn",
  failed: "error",
  done: "ok",
};

export function composeOperation(rt: Runtime): CanvasBoardView {
  const op = currentOperation(rt);
  if (!op || !rt.profile) return EMPTY_BOARD;
  const total = op.steps.length;
  const finished = op.steps.filter((t) => t.state !== "queued" && t.state !== "running").length;
  const mismatches = op.steps.filter((t) => t.state === "mismatch").length;
  const label =
    op.status === "running"
      ? `running ${Math.min(finished + 1, total)} of ${total}`
      : op.status === "done" && mismatches > 0
        ? `done · ${mismatches} verify mismatch`
        : op.status;
  const bySubject = new Map<string, typeof op.steps>();
  for (const t of op.steps) {
    const list = bySubject.get(t.subject) ?? [];
    list.push(t);
    bySubject.set(t.subject, list);
  }
  const sections: Section[] = [
    {
      kind: "rows",
      items: [
        {
          glyph: STATUS_TONE[op.status] === "ok" ? "ok" : "info",
          text: `${op.title[0]?.toUpperCase() ?? ""}${op.title.slice(1)}`,
          trailing: `${finished} of ${total} calls`,
          bar: { value: finished, total },
        },
        ...(op.reason ? [{ glyph: STATUS_TONE[op.status], text: op.reason }] : []),
      ],
    },
  ];
  for (const [subject, steps] of bySubject) {
    sections.push({
      kind: "rows",
      title: subject ? `Steps · ${subject}` : "Before any write",
      items: steps.map((t) => ({
        chip: STEP_CHIP[t.state],
        text: t.n === 0 ? t.text : `${t.n}. ${t.text}`,
        trailing:
          t.note ?? (t.n > 0 && t.state === "running" ? `keelson-adme-${op.planId}-${t.n}` : ""),
      })),
    });
  }
  const actions: CanvasActionItem[] = [];
  if (op.status === "paused") {
    actions.push({
      type: RESUME_OPERATION_ACTION,
      label: "Resume",
      tone: "brand",
      ...(rt.status.phase !== "connected" ? { disabled: true, reason: SIGNIN_REASON } : {}),
    });
  }
  if (op.status === "running" || op.status === "paused") {
    actions.push({
      type: CANCEL_OPERATION_ACTION,
      label: op.status === "running" ? "Stop after this step" : "Cancel",
    });
  } else {
    actions.push({ type: DISMISS_OPERATION_ACTION, label: "Dismiss" });
  }
  sections.push({ kind: "actions", wrap: true, items: actions });
  return {
    view: "board",
    header: { status: { label, tone: STATUS_TONE[op.status] }, chip: `plan ${op.planId}` },
    sections,
  };
}

const KIND_CHIP: Record<string, { label: string; tone: CanvasTone }> = {
  "dry run": { label: "dry run", tone: "neutral" },
  applied: { label: "applied", tone: "ok" },
  paused: { label: "paused", tone: "warn" },
  halted: { label: "halted", tone: "error" },
  aborted: { label: "aborted", tone: "warn" },
  failed: { label: "failed", tone: "error" },
};

const RECENT_LIMIT = 10;

function when(iso: string, now: Date): string {
  return iso.slice(0, 10) === now.toISOString().slice(0, 10)
    ? (clock(iso) ?? iso)
    : iso.slice(0, 10);
}

export function composeRecent(rt: Runtime): CanvasBoardView {
  if (!rt.profile || rt.status.phase === "firstrun") return EMPTY_BOARD;
  const events = rt.tracker.events.filter((e) => !e.who).slice(0, RECENT_LIMIT);
  if (events.length === 0) {
    return {
      view: "board",
      sections: [{ kind: "rows", items: [{ glyph: "neutral", text: "No changes recorded yet." }] }],
    };
  }
  const now = rt.now();
  return {
    view: "board",
    sections: [
      {
        kind: "rows",
        items: events.map((e) => ({
          chip: KIND_CHIP[e.kind ?? ""] ?? { label: "event", tone: "info" as const },
          text: e.text,
          trailing: when(e.at, now),
        })),
      },
    ],
  };
}
