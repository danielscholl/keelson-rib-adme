// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import {
  type CellDetail,
  MARK_LEGEND,
  type Mark,
  type Matrix,
  NO_GRANT,
  SHARED,
} from "../brief/seismic.ts";
import { esc, TONE_CLASS } from "./html.ts";

const MARK_CLASS: Record<Mark, string> = {
  A: "m-a",
  V: "m-v",
  AV: "m-a",
  "A!": "m-bad",
  "V!": "m-bad",
  "AV!": "m-bad",
  D: "m-d",
  "D*": "m-dx",
  "?": "m-q",
  "·": "m-none",
};

function cellPane(d: CellDetail, selected: boolean): string {
  const path = d.path
    .map((p) => `<span class="hop">${esc(p)}</span>`)
    .join('<span class="arrow">→</span>');
  return `<section class="detail" data-cell-detail="${esc(d.id)}"${selected ? "" : " hidden"}>
<p class="eyebrow">Selected · ${esc(d.eyebrow)}</p>
<h3>${esc(d.title)}</h3>
<p class="state ${TONE_CLASS[d.tone]}">${esc(d.state)}</p>
<p class="path">${path}</p>
<p>${esc(d.text)}</p>
${d.group ? `<p class="scope">${esc(d.group)}</p>` : ""}
<button type="button" class="open" data-inspect="${esc(d.id)}">Open in inspector</button>
</section>`;
}

function firstCell(m: Matrix): string | undefined {
  const row = m.rows.find((r) => r.group === "people") ?? m.rows[0];
  const cell = row?.cells.find((c) => c.mark !== "·" && c.column !== SHARED) ?? row?.cells[0];
  return cell?.id;
}

export function seismicTab(m: Matrix | undefined): string {
  if (!m) {
    return `<h2>Seismic members are not read yet.</h2><p class="summary">The first read runs with the next sweep; Refresh now reads it at once.</p>`;
  }
  const first = firstCell(m);
  const signals = m.signals
    .map((s) =>
      s.inspect
        ? `<button type="button" class="sig ${TONE_CLASS[s.tone]}" data-inspect="${esc(s.inspect)}">${esc(s.text)}</button>`
        : `<span class="sig ${TONE_CLASS[s.tone]}">${esc(s.text)}</span>`,
    )
    .join("");
  const apps = m.rows.filter((r) => r.group === "apps").length;
  const filter =
    apps > 0
      ? `<div class="facets"><button type="button" class="facet on" data-mgroup="people">People</button><button type="button" class="facet" data-mgroup="apps">Applications <span class="n">${apps}</span></button><button type="button" class="facet" data-mgroup="all">Both</button></div>`
      : "";
  const head = `<thead><tr><th class="corner"></th>${m.shared.length > 0 ? `<th title="${esc(m.shared.join(", "))}">Shared¹</th>` : ""}${m.columns
    .map(
      (c) =>
        `<th><button type="button" class="colh${c.unread ? " t-warn" : ""}" data-inspect="${esc(c.inspect)}">${esc(c.name)}${c.unread ? " ?" : ""}</button></th>`,
    )
    .join("")}</tr></thead>`;
  const body = m.rows
    .map(
      (r) =>
        `<tr data-mrow="${r.group}"${r.group === "apps" ? " hidden" : ""}><th scope="row"><button type="button" class="rowh" data-inspect="${esc(r.inspect)}">${esc(r.name)}</button><span class="rs">${esc(r.sub)}</span></th>${r.cells
          .map(
            (c) =>
              `<td><button type="button" class="mc ${MARK_CLASS[c.mark]}${c.id === first ? " on" : ""}" data-cell="${esc(c.id)}"${c.mark === "·" ? ` data-title="${esc(`${r.name} → ${c.column}`)}"` : ""} aria-pressed="${c.id === first}" aria-label="${esc(`${r.name}, ${c.column}: ${c.mark}`)}">${esc(c.mark)}</button></td>`,
          )
          .join("")}</tr>`,
    )
    .join("");
  const legend = `<p class="marks">${MARK_LEGEND.map(([mark, text]) => `<span><span class="mc ${MARK_CLASS[mark]} sm">${esc(mark)}</span>${esc(text)}</span>`).join("")}</p>`;
  const notes =
    m.notes.length > 0
      ? `<ul class="notes">${m.notes.map((n, i) => `<li>${i === 1 && m.shared.length > 0 ? "¹ " : ""}${esc(n)}</li>`).join("")}</ul>`
      : "";
  // Cells with no grant share one pane the frame fills in, to keep the frame small.
  const panes =
    m.details
      .filter((d) => d.state !== NO_GRANT)
      .map((d) => cellPane(d, d.id === first))
      .join("") +
    `<section class="detail" data-cell-detail="*" hidden><p class="eyebrow">Selected · no configured grant</p><h3 data-fill></h3><p class="state">neither group lists them</p><p>Neither group of this subproject lists this identity. Grant from the inspector if they need it.</p><button type="button" class="open" data-inspect="">Open in inspector</button></section>`;
  return `<h2>${esc(m.headline)}</h2>
<div class="signals">${signals}</div>
${filter}
${m.rows.length > 0 ? `<div class="mwrap"><table class="matrix">${head}<tbody>${body}</tbody></table></div>${legend}` : ""}
${notes}
${panes ? `<div class="pane cells">${panes}</div>` : ""}`;
}

export const SEISMIC_STYLE = `
.signals { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0 4px; }
.sig { font: inherit; font-family: var(--mono); font-size: 11.5px; padding: 3px 9px; border: 1px solid var(--border); border-radius: 6px; background: var(--card); color: var(--fg); }
button.sig { cursor: pointer; }
.sig.t-warn { border-color: var(--warn); color: var(--warn); } .sig.t-bad { border-color: var(--crit); color: var(--crit); }
.mwrap { overflow-x: auto; margin-top: 8px; border: 1px solid var(--border); border-radius: 8px; }
.matrix { border-collapse: collapse; font-size: 13px; min-width: 100%; }
.matrix th, .matrix td { border-bottom: 1px solid var(--border); padding: 3px 4px; text-align: center; }
.matrix thead th { font-family: var(--mono); font-size: 11px; font-weight: 600; color: var(--muted); white-space: nowrap; padding: 6px 4px; }
.matrix tbody th { position: sticky; left: 0; z-index: 1; background: var(--bg); text-align: left; padding: 4px 10px; min-width: 13rem; }
.matrix .corner { position: sticky; left: 0; z-index: 2; background: var(--bg); }
.colh, .rowh { font: inherit; background: none; border: none; padding: 0; color: inherit; cursor: pointer; text-decoration: underline dotted; text-underline-offset: 3px; }
.colh.t-warn { color: var(--warn); }
.rowh { display: block; font-weight: 600; color: var(--fg-strong); font-size: 13px; text-align: left; }
.rs { display: block; font-size: 11.5px; color: var(--muted); }
.mc { display: inline-block; min-width: 2.4em; font: inherit; font-family: var(--mono); font-size: 12px; font-weight: 700; padding: 3px 4px; border: 1px solid transparent; border-radius: 5px; background: none; color: var(--muted); cursor: pointer; }
.mc:hover { background: var(--card-2); }
.mc.on { border-color: var(--accent); background: var(--card); }
.m-a { color: var(--fg-strong); background: color-mix(in srgb, var(--src-instance) 22%, transparent); }
.m-v { color: var(--fg-strong); background: color-mix(in srgb, var(--src-instance) 10%, transparent); }
.m-d { color: var(--src-instance); font-weight: 600; }
.m-dx { color: var(--warn); }
.m-bad { color: var(--crit); background: color-mix(in srgb, var(--crit) 12%, transparent); }
.m-q { color: var(--warn); background: repeating-linear-gradient(45deg, transparent 0 4px, color-mix(in srgb, var(--warn) 18%, transparent) 4px 7px); }
.m-none { font-weight: 400; opacity: .6; }
.mc.sm { min-width: 2.2em; font-size: 10.5px; padding: 0 3px; margin-right: 4px; cursor: default; }
.marks { display: flex; flex-wrap: wrap; gap: 12px; margin: 8px 0 0; font-size: 12px; color: var(--muted); }
.notes { margin: 8px 0 0; padding-left: 18px; font-size: 12.5px; color: var(--muted); }
.cells { margin-top: 12px; position: static; max-width: 760px; }
.state { font-weight: 600; margin: 0 0 6px !important; }
.state.t-ok { color: var(--good); } .state.t-warn { color: var(--warn); }
.path { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; margin: 6px 0 8px !important; }
.hop { font-size: 12.5px; padding: 2px 8px; border: 1px solid var(--border); border-radius: 999px; background: var(--card-2); color: var(--fg-strong); }
.arrow { color: var(--muted); }`;
