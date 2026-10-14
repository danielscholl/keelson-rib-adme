// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { Fact, Source, Tone } from "../brief/index.ts";

export const TONE_CLASS: Record<Tone, string> = {
  bad: "t-bad",
  warn: "t-warn",
  ok: "t-ok",
  neutral: "",
};

export const SOURCE_LABEL: Record<Source, string> = {
  directory: "Directory",
  instance: "Instance",
  audit: "Audit log",
  operator: "Operator",
};

export function esc(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const SOURCE_CLASS: Record<Source, string> = {
  directory: "sd",
  instance: "si",
  audit: "sa",
  operator: "so",
};

// Compact on purpose: a profile pane per identity is the bulk of the frame.
export function factRows(facts: readonly Fact[]): string {
  return facts
    .map((f) => {
      const tone = TONE_CLASS[f.tone];
      return `<p class="fr"><i class="${SOURCE_CLASS[f.source]}"></i><b>${esc(f.label)}</b><span${tone ? ` class="${tone}"` : ""}>${esc(f.value)}</span></p>`;
    })
    .join("");
}

export function legend(): string {
  return `<p class="legend">${(Object.keys(SOURCE_LABEL) as Source[])
    .map((s) => `<span><i class="${SOURCE_CLASS[s]}"></i>${SOURCE_LABEL[s]}</span>`)
    .join("")}</p>`;
}
