// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { designTokenCssBlock } from "@keelson/shared";
import type { Brief, Fact, Item, Source, Tone } from "../brief/index.ts";
import type { PersonRow } from "../brief/people.ts";
import { INSPECT_ACTION } from "../surfaces.ts";

// A console past this size means the brief stopped folding.
export const CONSOLE_MAX_BYTES = 256_000;

export const CONNECTION_ID = "connection";

export interface ConsoleParts {
  brief: Brief;
  people: PersonRow[];
  // Later tabs, each already laid out; a tab with no body is left out.
  tabs?: { id: string; label: string; html: string }[];
}

const TONE_CLASS: Record<Tone, string> = { bad: "t-bad", warn: "t-warn", ok: "t-ok", neutral: "" };

const SOURCE_LABEL: Record<Source, string> = {
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

export function factRows(facts: readonly Fact[]): string {
  return facts
    .map(
      (f) =>
        `<div class="fr"><span class="src s-${f.source}" title="${SOURCE_LABEL[f.source]}"></span><span class="fk">${esc(f.label)}</span><span class="fv ${TONE_CLASS[f.tone]}">${esc(f.value)}</span></div>`,
    )
    .join("");
}

export function legend(): string {
  return `<p class="legend">${(Object.keys(SOURCE_LABEL) as Source[])
    .map((s) => `<span><span class="src s-${s}"></span>${SOURCE_LABEL[s]}</span>`)
    .join("")}</p>`;
}

function chip(text: string, tone: Tone, extra = ""): string {
  return `<span class="chip ${TONE_CLASS[tone]}${extra ? ` ${extra}` : ""}">${esc(text)}</span>`;
}

const CLASS_TONE: Record<Item["cls"], Tone> = {
  BLOCKED: "bad",
  INCONSISTENT: "warn",
  IDENTITY: "warn",
  GRANT: "warn",
  LEGAL: "warn",
  READ: "neutral",
};

function itemRow(item: Item, selected: boolean): string {
  return `<button type="button" class="row${selected ? " on" : ""}" data-sel="${esc(item.id)}" aria-pressed="${selected}">
<span class="cls ${TONE_CLASS[CLASS_TONE[item.cls]]}">${esc(item.cls)}</span>
<span class="body"><span class="tt">${esc(item.title)}</span><span class="ss">${esc(item.sub)}</span></span></button>`;
}

function itemPane(item: Item, selected: boolean): string {
  return `<section class="detail" data-detail="${esc(item.id)}"${selected ? "" : " hidden"}>
<p class="eyebrow">Selected · ${esc(item.cls)}</p>
<h3>${esc(item.title)}</h3>
<div class="facts">${factRows(item.facts)}</div>
<p class="dl">Next</p><p>${esc(item.next)}</p>
${item.scope ? `<p class="scope">${esc(item.scope)}</p>` : ""}
<button type="button" class="open" data-inspect="${esc(item.id)}">Open in inspector</button>
${legend()}
</section>`;
}

function overviewHtml(b: Brief): string {
  const first = b.items[0]?.id;
  const rows = b.items.map((x) => itemRow(x, x.id === first)).join("");
  const onboarding = b.onboarding
    ? `<div class="block ${TONE_CLASS[b.onboarding.tone]}"><span class="k">Onboarding · ${b.onboarding.count}</span> ${esc(b.onboarding.text)}</div>`
    : "";
  const adoption = b.adoption ? `<p class="adoption">${esc(b.adoption)}</p>` : "";
  const list = `<div class="focus">${
    b.items.length > 0
      ? `<p class="eyebrow">Needs a decision · ${b.items.length}</p>${rows}`
      : `<p class="eyebrow">Needs a decision · 0</p><p class="none">Nothing needs a decision.</p>`
  }${onboarding}${adoption}</div>`;
  const panes = b.items.map((x) => itemPane(x, x.id === first)).join("");
  return `<h2>${esc(b.headline)}</h2>
${b.summary ? `<p class="summary">${esc(b.summary)}</p>` : ""}
${b.items.length > 0 ? `<div class="split">${list}<div class="pane">${panes}</div></div>` : list}`;
}

const FACETS: { id: string; label: string; test: (r: PersonRow) => boolean }[] = [
  { id: "all", label: "Everyone", test: () => true },
  { id: "people", label: "People", test: (r) => r.group === "people" },
  { id: "apps", label: "Applications", test: (r) => r.group === "apps" },
  { id: "actors", label: "Not in Entra", test: (r) => r.group === "actors" },
  {
    id: "look",
    label: "Needs a look",
    test: (r) => r.chips.some((c) => c.tone === "bad" || c.tone === "warn"),
  },
  {
    id: "invited",
    label: "Invited",
    test: (r) => r.chips.some((c) => c.text.startsWith("invited")),
  },
];

function personRow(r: PersonRow, selected: boolean): string {
  const facets = FACETS.filter((f) => f.test(r))
    .map((f) => f.id)
    .join(" ");
  return `<button type="button" class="row prow${selected ? " on" : ""}" data-who="${esc(r.id)}" data-q="${esc(r.search)}" data-facets="${facets}" aria-pressed="${selected}">
<span class="body"><span class="tt">${esc(r.name)}</span><span class="ss mono">${esc(r.keys)}</span>${r.note ? `<span class="ss note">${esc(r.note)}</span>` : ""}</span>
<span class="chips">${r.chips.map((c) => chip(c.text, c.tone)).join("")}</span></button>`;
}

function personPane(r: PersonRow, selected: boolean): string {
  return `<section class="detail" data-who-detail="${esc(r.id)}"${selected ? "" : " hidden"}>
<p class="eyebrow">${esc(r.heading)}</p>
<h3>${esc(r.name)}</h3>
<p class="dl">${esc(r.question)}</p>
<div class="facts">${factRows(r.ladder)}</div>
${r.known.length > 0 ? `<p class="dl">What we know</p><div class="facts">${factRows(r.known)}</div>` : ""}
${r.groups ? `<p class="scope">${esc(r.groups)} · group detail in the inspector</p>` : ""}
<button type="button" class="open" data-inspect="${esc(r.inspect)}">Open in inspector</button>
${legend()}
</section>`;
}

function peopleHtml(rows: readonly PersonRow[]): string {
  const first = rows[0]?.id;
  const count = (f: (typeof FACETS)[number]) => rows.filter(f.test).length;
  const facets = FACETS.filter((f) => f.id === "all" || count(f) > 0)
    .map(
      (f) =>
        `<button type="button" class="facet${f.id === "all" ? " on" : ""}" data-facet="${f.id}">${esc(f.label)} <span class="n">${count(f)}</span></button>`,
    )
    .join("");
  return `<div class="split">
<div class="focus">
<input class="search" type="search" placeholder="Find identity: name, address, label, organization or id" data-search aria-label="Find identity">
<div class="facets">${facets}</div>
<div class="plist">${rows.map((r) => personRow(r, r.id === first)).join("")}</div>
<p class="count" data-count data-total="${rows.length}">${rows.length} of ${rows.length} identities</p>
</div>
<div class="pane">${rows.map((r) => personPane(r, r.id === first)).join("")}</div>
</div>`;
}

function tab(id: string, label: string, selected: boolean): string {
  return `<button type="button" class="tab${selected ? " on" : ""}" role="tab" data-view="${id}" aria-selected="${selected}">${esc(label)}</button>`;
}

function stampHtml(b: Brief): string {
  const notes = b.stamp.notes
    .map(
      (n) =>
        `<button type="button" class="link alert" data-inspect="${esc(n.inspect)}">${esc(n.text)}</button>`,
    )
    .join(" · ");
  const who = [b.instance, b.operator].filter(Boolean).join(" · ");
  const parts = [
    who
      ? `<button type="button" class="link quiet" data-inspect="${CONNECTION_ID}">${esc(who)}</button>`
      : "",
    b.stamp.text ? esc(b.stamp.text) : "",
    notes,
  ].filter(Boolean);
  return parts.length > 0 ? `<span class="stamp">${parts.join(" · ")}</span>` : "";
}

// Markup only: the brief has decided every word, so this lays it out and adds
// selection. The frame cannot open links; evidence and verbs live in the inspector.
export function consoleHtml(parts: ConsoleParts): string {
  const b = parts.brief;
  const stamp = stampHtml(b);
  const measured = b.state === "measured" || (b.state === "signin" && parts.people.length > 0);
  const extra = (parts.tabs ?? []).filter((t) => t.html);
  const views = measured
    ? `<div class="tabs" role="tablist">${tab("overview", "Overview", true)}${tab("people", "People", false)}${extra.map((t) => tab(t.id, t.label, false)).join("")}${stamp}</div>
<div data-view-pane="overview">${overviewHtml(b)}</div>
<div data-view-pane="people" hidden>${peopleHtml(parts.people)}</div>
${extra.map((t) => `<div data-view-pane="${esc(t.id)}" hidden>${t.html}</div>`).join("\n")}`
    : `${stamp ? `<div class="tabs">${stamp}</div>` : ""}<h2>${esc(b.headline)}</h2>${b.summary ? `<p class="summary">${esc(b.summary)}</p>` : ""}`;
  return `<style>${designTokenCssBlock()}${STYLE}</style>
<div class="wrap">
${views}
</div>
<script>${SCRIPT}</script>`;
}

export function expectHtml(data: unknown): string {
  if (typeof data !== "string" || data.length === 0) throw new Error("console frame must be html");
  if (new TextEncoder().encode(data).byteLength > CONSOLE_MAX_BYTES) {
    throw new Error(`console frame exceeds ${CONSOLE_MAX_BYTES} bytes`);
  }
  return data;
}

const STYLE = `
:root { --src-directory: var(--id-1); --src-instance: var(--id-3); --src-audit: var(--id-2); --src-operator: var(--id-4); }
.wrap { padding: 14px 18px 20px; }
h2 { margin: 0 0 4px; font-size: 21px; line-height: 1.25; font-weight: 600; color: var(--fg-strong); text-wrap: balance; max-width: 70ch; }
.summary { margin: 0 0 14px; color: var(--fg); font-size: 14px; max-width: 90ch; }
.eyebrow, .dl, .k { font-family: var(--mono); font-size: 10.5px; font-weight: 600; letter-spacing: .1em; text-transform: uppercase; color: var(--muted); margin: 0; }
.split { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr); gap: 16px; margin-top: 12px; align-items: start; }
.focus { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.focus > .eyebrow { margin-bottom: 4px; }
.row { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 0 10px; text-align: left; padding: 7px 10px; border: 1px solid transparent; border-radius: 8px; background: none; color: inherit; font: inherit; cursor: pointer; }
.row:hover { background: var(--card-2); }
.row.on { background: var(--card); border-color: var(--accent); }
.cls { font-family: var(--mono); font-size: 10px; font-weight: 700; letter-spacing: .06em; color: var(--muted); padding-top: 3px; width: 13.5ch; }
.cls.t-bad, .chip.t-bad, .fv.t-bad { color: var(--crit); }
.cls.t-warn, .chip.t-warn, .fv.t-warn { color: var(--warn); }
.chip.t-ok, .fv.t-ok { color: var(--good); }
.tt { display: block; font-weight: 600; color: var(--fg-strong); font-size: 14px; }
.ss { display: block; font-size: 12.5px; color: var(--fg); }
.ss.mono { font-family: var(--mono); font-size: 11.5px; color: var(--muted); }
.ss.note { color: var(--muted); font-size: 12px; }
.chip { display: inline-block; font-family: var(--mono); font-size: 10px; font-weight: 600; letter-spacing: .04em; padding: 0 6px; border: 1px solid var(--border); border-radius: 999px; color: var(--muted); white-space: nowrap; }
.block { margin: 12px 0 0; padding: 8px 10px; border: 1px dashed var(--border); border-radius: 6px; font-size: 13px; color: var(--fg); }
.block.t-warn { border-color: var(--warn); }
.block .k { margin-right: 6px; }
.adoption { margin: 8px 0 0; padding: 0 10px; font-size: 12.5px; color: var(--muted); }
.none { margin: 4px 10px; color: var(--muted); font-size: 13px; }
.pane { min-width: 0; position: sticky; top: 8px; }
.detail { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px 12px; }
.detail h3 { margin: 2px 0 6px; font-size: 15px; color: var(--fg-strong); }
.detail .dl { margin-top: 10px; }
.detail p { margin: 2px 0 0; font-size: 13.5px; }
.facts { display: flex; flex-direction: column; margin-top: 4px; }
.fr { display: grid; grid-template-columns: 10px minmax(9rem, auto) minmax(0, 1fr); gap: 8px; align-items: baseline; padding: 3px 0; border-bottom: 1px solid var(--border); font-size: 13px; }
.fr:last-child { border-bottom: none; }
.fk { color: var(--muted); }
.fv { color: var(--fg-strong); overflow-wrap: anywhere; }
.src { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
.s-directory { background: var(--src-directory); } .s-instance { background: var(--src-instance); }
.s-audit { background: var(--src-audit); } .s-operator { background: var(--src-operator); }
.detail .scope { font-family: var(--mono); font-size: 11px; color: var(--muted); margin-top: 10px; }
.detail .legend { display: flex; flex-wrap: wrap; gap: 12px; margin: 10px 0 0; font-size: 11.5px; color: var(--muted); }
.legend .src { margin-right: 5px; }
.open { margin-top: 12px; font: inherit; font-size: 13px; font-weight: 600; padding: 6px 12px; border-radius: 6px; border: 1px solid var(--accent); color: var(--accent); background: none; cursor: pointer; }
.link { background: none; border: none; padding: 0; font: inherit; color: var(--accent); cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }
.link.quiet { color: inherit; text-decoration-style: dotted; }
.link.alert { color: var(--warn); text-decoration-style: dotted; }
.tabs { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; margin-bottom: 12px; border-bottom: 1px solid var(--border); }
.tab { font: inherit; font-size: 13px; font-weight: 600; padding: 6px 12px; margin-bottom: -1px; background: none; border: none; border-bottom: 2px solid transparent; color: var(--muted); cursor: pointer; }
.tab.on { color: var(--fg-strong); border-bottom-color: var(--accent); }
.stamp { margin-left: auto; padding: 6px 0; font-family: var(--mono); font-size: 11px; color: var(--muted); letter-spacing: .03em; }
.search { box-sizing: border-box; width: 100%; font: inherit; font-size: 13.5px; padding: 7px 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--card); color: var(--fg-strong); }
.search:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
.facets { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0 6px; }
.facet { font: inherit; font-size: 12px; padding: 2px 9px; border: 1px solid var(--border); border-radius: 999px; background: none; color: var(--fg); cursor: pointer; }
.facet .n { color: var(--muted); font-family: var(--mono); font-size: 11px; }
.facet.on { border-color: var(--accent); color: var(--fg-strong); }
.prow { grid-template-columns: minmax(0, 1fr) auto; }
.chips { display: flex; gap: 4px; align-items: start; padding-top: 2px; }
.plist { display: flex; flex-direction: column; gap: 2px; max-height: 640px; overflow-y: auto; }
.count { margin: 6px 10px 0; font-size: 12px; color: var(--muted); }
button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
@media (max-width: 760px) {
  .split { grid-template-columns: minmax(0, 1fr); }
  .pane { position: static; }
  .stamp { margin-left: 0; }
}`;

const SCRIPT = `(function () {
  var k = window.keelson || {};
  function show(row, pane, id, aria) {
    var found = false;
    document.querySelectorAll("[" + pane + "]").forEach(function (d) {
      var on = d.getAttribute(pane) === id;
      d.hidden = !on;
      if (on) found = true;
    });
    if (!found) return false;
    document.querySelectorAll("[" + row + "]").forEach(function (r) {
      var on = r.getAttribute(row) === id;
      r.classList.toggle("on", on);
      r.setAttribute(aria, on ? "true" : "false");
    });
    return true;
  }
  function current(row) {
    var on = document.querySelector("[" + row + "].on");
    return on ? on.getAttribute(row) : null;
  }
  var KINDS = [
    ["view", "data-view", "data-view-pane", "aria-selected"],
    ["sel", "data-sel", "data-detail", "aria-pressed"],
    ["who", "data-who", "data-who-detail", "aria-pressed"],
    ["cell", "data-cell", "data-cell-detail", "aria-pressed"],
    ["fam", "data-fam", "data-fam-detail", "aria-pressed"],
  ];
  var state = { q: "", facet: "all" };
  KINDS.forEach(function (c) { state[c[0]] = current(c[1]); });
  function save() { if (k.saveState) k.saveState(state); }
  function filter() {
    var terms = state.q.toLowerCase().split(/\\s+/).filter(Boolean);
    var shown = 0;
    document.querySelectorAll("[data-who]").forEach(function (r) {
      var q = r.getAttribute("data-q") || "";
      var facets = " " + (r.getAttribute("data-facets") || "") + " ";
      var ok = facets.indexOf(" " + state.facet + " ") >= 0 && terms.every(function (t) { return q.indexOf(t) >= 0; });
      r.hidden = !ok;
      if (ok) shown++;
    });
    document.querySelectorAll("[data-facet]").forEach(function (f) {
      f.classList.toggle("on", f.getAttribute("data-facet") === state.facet);
    });
    var c = document.querySelector("[data-count]");
    if (c) c.textContent = shown + " of " + c.getAttribute("data-total") + " identities" + (shown === 0 ? " · nothing matches" : "");
  }
  var box = document.querySelector("[data-search]");
  if (box) box.addEventListener("input", function () { state.q = box.value; filter(); save(); });
  if (k.onRestore) k.onRestore(function (s) {
    if (!s) return;
    KINDS.forEach(function (c) {
      var id = s[c[0]];
      if (typeof id === "string" && show(c[1], c[2], id, c[3])) state[c[0]] = id;
    });
    if (typeof s.q === "string") { state.q = s.q; if (box) box.value = s.q; }
    if (typeof s.facet === "string") state.facet = s.facet;
    filter();
  });
  document.addEventListener("click", function (e) {
    var t = e.target && e.target.closest ? e.target.closest("[data-view],[data-sel],[data-who],[data-cell],[data-fam],[data-facet],[data-inspect]") : null;
    if (!t) return;
    var facet = t.getAttribute("data-facet");
    if (facet !== null) { state.facet = facet; filter(); save(); return; }
    for (var i = 0; i < KINDS.length; i++) {
      var c = KINDS[i];
      var id = t.getAttribute(c[1]);
      if (id === null) continue;
      if (show(c[1], c[2], id, c[3])) { state[c[0]] = id; save(); }
      return;
    }
    if (k.action) k.action(${JSON.stringify(INSPECT_ACTION)}, { id: t.getAttribute("data-inspect") });
  });
})();`;
