// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { DataBrief, Family } from "../brief/data.ts";
import { fmt, plural } from "../brief/words.ts";
import { esc } from "./html.ts";

export const FIND_ID = "find";

function familyRow(f: Family, selected: boolean): string {
  return `<button type="button" class="row frow${selected ? " on" : ""}" data-fam="${esc(f.id)}" aria-pressed="${selected}">
<span class="body"><span class="tt">${esc(f.label)}</span><span class="ss">${plural(f.kinds.length, "kind", "kinds")} · ${plural(f.versions, "version", "versions")} · ${esc(f.authorities.join(", "))}</span></span>
<span class="num">${fmt(f.count)}</span></button>`;
}

function familyPane(f: Family, selected: boolean): string {
  const kinds = f.kinds
    .slice(0, 12)
    .map(
      (k) =>
        `<p class="kr"><span class="mono">${esc(k.kind)}</span><span class="num">${fmt(k.count)}</span></p>`,
    )
    .join("");
  const more =
    f.kinds.length > 12
      ? `<p class="scope">${f.kinds.length - 12} more kinds in the inspector</p>`
      : "";
  return `<section class="detail" data-fam-detail="${esc(f.id)}"${selected ? "" : " hidden"}>
<p class="eyebrow">Family · indexed, visible to this sign-in</p>
<h3>${esc(f.label)} · ${fmt(f.count)}</h3>
<div class="kinds">${kinds}</div>${more}
<button type="button" class="open" data-inspect="${esc(f.id)}">Open in inspector · Browse records</button>
</section>`;
}

export function dataTab(d: DataBrief | undefined): string {
  if (!d) {
    return `<h2>Records and legal tags are not read yet.</h2><p class="summary">They are read with the next sweep; Refresh now reads them at once.</p>`;
  }
  const first = d.families[0]?.id;
  const facts = d.facts
    .map(
      (f) =>
        `<div class="tile${f.tone === "warn" ? " t-warn" : ""}"><p class="eyebrow">${esc(f.label)}</p><p class="big">${f.value === null ? "?" : esc(f.value)}</p><p class="ss">${esc(f.sub)}</p></div>`,
    )
    .join("");
  const families = d.families.map((f) => familyRow(f, f.id === first)).join("");
  const rest = d.rest
    ? `<p class="row frow static"><span class="body"><span class="tt">${plural(d.rest.kinds, "other kind", "other kinds")}</span></span><span class="num">${fmt(d.rest.count)}</span></p>`
    : "";
  const queue = d.queue
    .map(
      (x) =>
        `<button type="button" class="row" data-inspect="${esc(x.id)}"><span class="cls t-warn">${esc(x.cls)}</span><span class="body"><span class="tt">${esc(x.title)}</span><span class="ss">${esc(x.sub)}</span></span></button>`,
    )
    .join("");
  const lower =
    d.lower.length > 0
      ? `<div class="block"><span class="k">Lower priority</span> ${d.lower.map(esc).join(" ")}</div>`
      : "";
  const scopes = `<details class="scopes"><summary>How these are counted</summary><div class="facts">${d.scopes
    .map(([k, v]) => `<p class="fr"><i class="si"></i><b>${esc(k)}</b><span>${esc(v)}</span></p>`)
    .join("")}</div></details>`;
  const panes = d.families.map((f) => familyPane(f, f.id === first)).join("");
  return `<h2>${esc(d.headline)}</h2>
<div class="tiles">${facts}</div>
<div class="split">
<div class="focus">
<p class="eyebrow">Record families · indexed, visible to this sign-in</p>
${families}${rest}
<p class="adoption">A family is a kind's entity name, so versions and authorities add together.</p>
<p class="eyebrow gap">Stewardship · ${d.queue.length}</p>
${d.queue.length > 0 ? queue : `<p class="none">No legal tag in use needs care.</p>`}
${lower}
<p class="links"><button type="button" class="link" data-inspect="${FIND_ID}">Find records ▸</button></p>
${scopes}
</div>
<div class="pane">${panes}</div>
</div>`;
}

export const DATA_STYLE = `
.tiles { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); border-block: 1px solid var(--border); margin-top: 10px; }
.tile { padding: 10px 14px; }
.tile + .tile { border-left: 1px solid var(--border); }
.tile .big { margin: 0; font-family: var(--mono); font-size: 24px; font-weight: 600; color: var(--fg-strong); font-variant-numeric: tabular-nums; line-height: 1.3; }
.tile.t-warn .big { color: var(--warn); }
.frow { grid-template-columns: minmax(0, 1fr) auto; }
.frow.static { cursor: default; margin: 0; }
.frow.static:hover { background: none; }
.num { font-family: var(--mono); font-size: 12.5px; color: var(--fg-strong); font-variant-numeric: tabular-nums; padding-top: 2px; }
.eyebrow.gap { margin-top: 14px; }
.links { margin: 12px 10px 0; font-size: 13px; }
.scopes { margin: 12px 10px 0; font-size: 12.5px; color: var(--muted); }
.scopes summary { cursor: pointer; }
.scopes .fr { display: grid; grid-template-columns: 10px minmax(9rem, auto) minmax(0, 1fr); gap: 8px; margin: 0; padding: 3px 0; border-bottom: 1px solid var(--border); }
.kinds { margin-top: 6px; }
.kr { display: flex; justify-content: space-between; gap: 8px; margin: 0 !important; padding: 3px 0; border-bottom: 1px solid var(--border); font-size: 12px; }
.kr .mono { font-family: var(--mono); font-size: 11.5px; overflow-wrap: anywhere; color: var(--fg); }
@media (max-width: 760px) { .tiles { grid-template-columns: minmax(0, 1fr); } .tile + .tile { border-left: none; border-top: 1px solid var(--border); } }`;
