// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { CanvasBoardView } from "@keelson/shared";
import { SERVICES_AREA, type ServiceProbe } from "../data/areas.ts";
import { EMPTY_BOARD } from "../resting.ts";
import type { Runtime } from "../runtime.ts";

type Section = CanvasBoardView["sections"][number];
type Cell = Extract<Section, { kind: "grid" }>["cells"][number];
type Row = Extract<Section, { kind: "rows" }>["items"][number];

function badge(p: ServiceProbe): NonNullable<Cell["badge"]> {
  switch (p.state) {
    case "ok":
      return { text: "ok", tone: "ok" };
    case "forbidden":
      return { text: String(p.status ?? 403), tone: "caution" };
    case "unprobed":
      return { text: "?", tone: "neutral" };
    case "error":
      return { text: p.status ? String(p.status) : "error", tone: "error" };
  }
}

function forbiddenText(p: ServiceProbe): string {
  const code = p.status ?? 403;
  if (p.message?.startsWith("not permitted")) return `${code}, ${p.message}`;
  return `${code}, not permitted${p.message ? ` (${p.message})` : ""}`;
}

function versionRow(p: ServiceProbe): Row | undefined {
  switch (p.state) {
    case "ok":
      return p.version ? { glyph: "ok", text: p.service, trailing: p.version } : undefined;
    case "forbidden":
      return { glyph: "caution", text: p.service, trailing: forbiddenText(p) };
    case "error":
      return {
        glyph: "error",
        text: p.service,
        trailing: [p.status ?? "error", p.message].filter(Boolean).join(", "),
      };
    case "unprobed":
      return undefined;
  }
}

function summary(probes: readonly ServiceProbe[]): string {
  const n = (s: ServiceProbe["state"]) => probes.filter((p) => p.state === s).length;
  const parts: [number, string][] = [
    [n("forbidden"), "not permitted"],
    [n("error"), "failed"],
    [n("unprobed"), "not probed"],
  ];
  return [
    `${n("ok")} answered`,
    ...parts.filter(([count]) => count > 0).map(([count, what]) => `${count} ${what}`),
  ].join(" · ");
}

export function composeServices(rt: Runtime): CanvasBoardView {
  const phase = rt.status.phase;
  if (phase === "firstrun" || phase === "profile-error") return EMPTY_BOARD;
  const measured = rt.cache.get<ServiceProbe[]>(SERVICES_AREA);
  const probes = measured.data;
  if (!probes) {
    return {
      view: "board",
      header: { chip: "not measured" },
      sections: [
        {
          kind: "rows",
          items: [
            measured.error
              ? { glyph: "error", text: "Service probe failed", trailing: measured.error }
              : { glyph: "neutral", text: "Not measured yet. The next sweep probes each service." },
          ],
        },
      ],
    };
  }
  const fresh = phase === "signin" ? rt.freshness(SERVICES_AREA) : undefined;
  const rows = probes.map(versionRow).filter((r): r is Row => r !== undefined);
  const sections: Section[] = [
    {
      kind: "grid",
      title: "Probe result, by service",
      cells: probes.map((p) => ({ label: p.service, badge: badge(p) })),
    },
  ];
  if (rows.length > 0) {
    sections.push({ kind: "rows", title: "Versions from GET /info", boxed: true, items: rows });
  }
  return {
    view: "board",
    header: { chip: [summary(probes), fresh].filter(Boolean).join(" · ") },
    sections,
  };
}
