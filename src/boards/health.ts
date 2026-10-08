// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { CanvasBoardView } from "@keelson/shared";
import {
  type AzureHealth,
  type Health,
  labelOf,
  releases,
  SERVICE_CATALOG,
  type ServiceProbe,
  type Verdict,
  verdict,
} from "../data/health.ts";
import type { Measured } from "../sweep.ts";

type Section = CanvasBoardView["sections"][number];

// The chip that ends the header's connection line, e.g. "healthy · 0.28".
export function healthChip(v: Verdict): { label: string; tone: Verdict["tone"] } {
  return { label: [v.word, v.release].filter(Boolean).join(" · "), tone: v.tone };
}

function azureText(azure: AzureHealth): string {
  if (azure.state === "unread") return `? (${azure.reason})`;
  const since = azure.since ? ` since ${azure.since.slice(0, 16).replace("T", " ")}Z` : "";
  return `${azure.state}${since}${azure.summary && azure.state !== "Available" ? ` · ${azure.summary}` : ""}`;
}

function releaseText(services: readonly ServiceProbe[]): string {
  const found = releases(services);
  if (found.length === 0) return "?";
  const answering = services.filter((s) => s.state !== "off").length;
  return found.map(([r, n]) => `${r} on ${n} of ${answering}`).join(" · ");
}

function summary(v: Verdict, services: readonly ServiceProbe[]): string {
  const enabled = services.filter((s) => s.state !== "off");
  const down = enabled.filter((s) => s.state === "down").length;
  if (v.word.startsWith("Azure")) return `Azure reports ${v.word.slice(7)} for this instance`;
  if (down > 0) return `${enabled.length - down} of ${enabled.length} services answer`;
  return `All ${enabled.length} enabled services answer`;
}

function result(p: ServiceProbe | undefined): { value: string; tone: "ok" | "error" | "neutral" } {
  if (!p) return { value: "?", tone: "neutral" };
  switch (p.state) {
    case "off":
      return { value: "not enabled", tone: "neutral" };
    case "down":
      return {
        value: [p.status ?? "no answer", p.message].filter(Boolean).join(", "),
        tone: "error",
      };
    case "up":
      if (p.version) return { value: p.version, tone: "ok" };
      return { value: p.status ? `up, ${p.status} without a version` : "up", tone: "ok" };
  }
}

// The Connection inspector's Platform block: the verdict, Azure's view and every service.
export function platformSections(measured: Measured<Health>, fresh?: string): Section[] {
  const health = measured.data;
  const v = verdict(health);
  if (!health) {
    return [
      {
        kind: "rows",
        title: "Platform",
        boxed: true,
        items: [
          measured.error
            ? { glyph: "error", text: "Health check failed", trailing: measured.error }
            : { glyph: "neutral", text: "Not checked yet. The next sweep checks every service." },
        ],
      },
    ];
  }
  const glyph = v.tone === "caution" ? "warn" : v.tone;
  const off = health.services.filter((s) => s.state === "off").length;
  const answered = health.services.length - off;
  const byService = new Map(health.services.map((s) => [s.service, s]));
  return [
    {
      kind: "rows",
      title: "Platform",
      boxed: true,
      items: [
        { glyph, text: summary(v, health.services), ...(fresh ? { trailing: fresh } : {}) },
        { text: "Azure Resource Health", trailing: azureText(health.azure) },
        { text: "Release", trailing: releaseText(health.services) },
      ],
    },
    {
      kind: "table",
      title: `Services · ${answered} enabled${off > 0 ? ` · ${off} not enabled` : ""}`,
      columns: [
        { key: "group", label: "Group" },
        { key: "service", label: "Service" },
        { key: "result", label: "Version or result" },
      ],
      rows: SERVICE_CATALOG.map((e) => ({
        group: e.group,
        service: labelOf(e.service),
        result: result(byService.get(e.service)),
      })),
      caption:
        "Up is any answer but 404, so a 403 still means the service runs. Checked at most hourly; Refresh now checks again.",
    },
  ];
}
