// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { CanvasActionItem, CanvasBoardView, CanvasTone } from "@keelson/shared";
import { type Check, type CheckStatus, type Explanation, explanations } from "../access/explain.ts";
import { bindingOf } from "../plan/model.ts";
import type { Profile } from "../profile.ts";
import { EMPTY_BOARD } from "../resting.ts";
import type { Runtime } from "../runtime.ts";
import { clock } from "../sweep.ts";
import { EXPLAIN_ACTION, PREVIEW_CLEANUP_ACTION, PREVIEW_FIX_ACTION } from "./change.ts";
import { SIGNIN_REASON } from "./connection.ts";

type Section = CanvasBoardView["sections"][number];
type Row = Extract<Section, { kind: "rows" }>["items"][number];

const CHIP: Record<CheckStatus, { label: string; tone: CanvasTone }> = {
  pass: { label: "pass", tone: "ok" },
  warn: { label: "warn", tone: "warn" },
  fail: { label: "fail", tone: "error" },
  skipped: { label: "skipped", tone: "neutral" },
  unchecked: { label: "?", tone: "neutral" },
};

function checkRow(c: Check): Row {
  const chip = CHIP[c.status];
  return {
    glyph: chip.tone,
    chip,
    text: c.label,
    trailing: c.trailing,
    ...(c.detail ? { detail: c.detail } : {}),
  };
}

function segments(e: Explanation, title: string): Section {
  const n = (...s: CheckStatus[]) => e.checks.filter((c) => s.includes(c.status)).length;
  const warned = n("warn");
  const unchecked = n("unchecked");
  return {
    kind: "segments",
    title,
    items: [
      { label: "passed", n: n("pass"), tone: "ok" },
      ...(warned > 0 ? [{ label: "warning", n: warned, tone: "warn" as const }] : []),
      { label: "failed", n: n("fail"), tone: "error" },
      { label: "skipped", n: n("skipped"), tone: "neutral" },
      ...(unchecked > 0 ? [{ label: "not checked", n: unchecked, tone: "neutral" as const }] : []),
    ],
  };
}

function fixSection(rt: Runtime, e: Explanation, profile: Profile): Section | undefined {
  if (e.fix) {
    const signedOut = rt.status.phase !== "connected";
    const plan: CanvasActionItem = {
      type: e.fix.kind === "fix-users" ? PREVIEW_FIX_ACTION : PREVIEW_CLEANUP_ACTION,
      label: e.fix.kind === "fix-users" ? "Plan the fix" : "Plan the cleanup",
      tone: "brand",
      pendingLabel: "Planning…",
      binding: { ...bindingOf(profile), id: e.id },
      ...(signedOut ? { disabled: true, reason: SIGNIN_REASON } : {}),
    };
    return {
      kind: "cards",
      title: "Fix",
      items: [
        {
          title: e.fix.title,
          edge: e.verdict.code ? "error" : "warn",
          pill: {
            label: `${e.fix.changes} change${e.fix.changes === 1 ? "" : "s"}`,
            tone: "neutral",
          },
          stacked: true,
          fields: e.fix.lines.map((line, i) => ({ label: String(i + 1), value: line })),
          footnote: "Nothing changes until you apply the plan.",
          reason: { label: "why", text: e.fix.reason },
          actions: [plan],
        },
      ],
    };
  }
  if (e.advice) {
    return { kind: "rows", title: "Fix", items: [{ glyph: "info", text: e.advice }] };
  }
  return undefined;
}

function noteSection(e: Explanation): Section {
  return {
    kind: "cards",
    title: "Send to this person",
    items: [
      {
        title: `Note for ${e.name}`,
        pill: { label: "plain text", tone: "neutral" },
        prose: true,
        fields: [{ label: "Note", value: e.note, copyable: true }],
        footnote: "Copy only. The rib does not send mail.",
      },
    ],
  };
}

function when(iso: string, now: Date): string {
  return iso.slice(0, 10) === now.toISOString().slice(0, 10)
    ? (clock(iso) ?? iso)
    : iso.slice(0, 10);
}

function recentSection(rt: Runtime, earlier: readonly Explanation[], profile: Profile): Section {
  const now = rt.now();
  return {
    kind: "rows",
    title: `Recent answers · ${earlier.length}`,
    items: earlier.map(
      (x): Row => ({
        glyph: x.verdict.code ? "warn" : "ok",
        chip: { label: x.verdict.code ?? "ok", tone: x.verdict.code ? "warn" : "ok" },
        text: `${x.name}: ${x.verdict.reason}`,
        trailing: when(x.at, now),
        action: { type: EXPLAIN_ACTION, payload: { ...bindingOf(profile), id: x.id } },
      }),
    ),
  };
}

export function composeExplain(rt: Runtime): CanvasBoardView {
  const profile = rt.profile;
  if (!profile) return EMPTY_BOARD;
  const [e, ...earlier] = explanations(rt);
  if (!e) {
    return {
      view: "board",
      title: "Why 401/403",
      sections: [
        {
          kind: "rows",
          items: [
            {
              glyph: "neutral",
              text: "No answer yet. Pick a person under Change access, Why 401/403.",
            },
          ],
        },
      ],
    };
  }
  const sections: Section[] = [segments(e, e.email ?? e.name)];
  if (e.source === "cached") {
    sections.push({
      kind: "rows",
      items: [
        {
          glyph: "warn",
          text: `Answered from the sweep${e.sweptAt ? ` cached at ${clock(e.sweptAt)}` : ""}, not a live read.`,
          ...(e.sourceNote ? { trailing: e.sourceNote } : {}),
        },
      ],
    });
  }
  sections.push({
    kind: "rows",
    title: "Checks, in the order the platform applies them",
    items: e.checks.map(checkRow),
  });
  const fix = fixSection(rt, e, profile);
  if (fix) sections.push(fix);
  sections.push(noteSection(e));
  if (earlier.length > 0) sections.push(recentSection(rt, earlier, profile));
  const checked =
    e.source === "live" ? `checked ${clock(e.at)}` : `cached from ${clock(e.sweptAt ?? e.at)}`;
  return {
    view: "board",
    title: `Why 401/403 · ${e.name}`,
    header: {
      status: { label: e.verdict.label, tone: e.verdict.code ? "error" : "ok" },
      chip: `${checked} · ${e.checks.length} checks`,
    },
    sections,
  };
}
