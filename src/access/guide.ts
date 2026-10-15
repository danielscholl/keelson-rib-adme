// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { grantedAt, USAGE_LABEL } from "./activity.ts";
import type { Measured } from "./measured.ts";

export const EXPORT_GUIDE_ACTION = "export-access-guide";

function guideDate(iso: string | undefined): string {
  if (!iso) return "–";
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

const mdCell = (s: string) =>
  s
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/[\r\n]+/g, " ");

// The "Who has access" table of the access guide, in the guide's own words.
export function accessGuideMarkdown(m: Measured): string {
  const measured = m.activity.kind === "measured" ? m.activity.model : undefined;
  const rows = [...m.model.people]
    .sort(
      (a, b) =>
        (grantedAt(a) ?? "").localeCompare(grantedAt(b) ?? "") || a.name.localeCompare(b.name),
    )
    .map((p) => {
      const u = m.usage.get(p.id);
      const status = u ? USAGE_LABEL[u] : p.state === "pending" ? "Invited" : "Accepted";
      const role = p.role === "Admin" || p.role === "Ops" ? ` (${p.role.toLowerCase()})` : "";
      const last = measured?.byId.get(p.id)?.last;
      return `| ${[
        `${p.name}${role}`,
        p.email ?? "",
        status,
        guideDate(grantedAt(p)),
        measured ? guideDate(last) : "?",
      ]
        .map(mdCell)
        .join(" | ")} |`;
    });
  return `${["| Name | Email | Status | Granted | Last active |", "|---|---|---|---|---|", ...rows].join("\n")}\n`;
}
