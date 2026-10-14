// Writes the sample instance's console to an html file: bun dev/console.ts <out.html> [light|dark]
import { writeFileSync } from "node:fs";
import rib from "../src/index.ts";
import { CONSOLE_KEY } from "../src/keys.ts";

process.env.KEELSON_ADME_SAMPLE = "1";
const out = process.argv[2] ?? "console.html";
const theme = process.argv[3] ?? "light";
const frames = new Map<string, unknown>();
const composers = new Map<string, () => Promise<unknown>>();
const ctx = {
  getExec: () => ({
    runJSON: async () => ({ ok: false, error: "", code: 1 }),
    runText: async () => ({ ok: false, error: "", code: 1 }),
  }),
  getSnapshotManager: () => ({
    register: (key: string, compose: () => unknown) => {
      composers.set(key, async () => compose());
      return () => composers.delete(key);
    },
    recompose: async (key: string) => {
      const c = composers.get(key);
      if (c) frames.set(key, await c());
    },
    latest: () => undefined,
    keys: () => [...composers.keys()],
    dispose: async () => undefined,
  }),
};
rib.registerTools?.(ctx as never);
await new Promise((r) => setTimeout(r, 500));
await ctx.getSnapshotManager().recompose(CONSOLE_KEY);
const html = String(frames.get(CONSOLE_KEY) ?? "");
const bridge = `<script>window.keelson = { action: function (t, p) { console.log("action", t, JSON.stringify(p)); }, saveState: function () {}, onRestore: function () {} };</script>`;
writeFileSync(
  out,
  `<!doctype html><html data-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>${bridge}${html}</body></html>`,
);
console.log(`wrote ${out} (${html.length} bytes)`);
await rib.dispose?.();
