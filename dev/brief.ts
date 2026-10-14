// Prints the sample instance's brief: KEELSON_ADME_SAMPLE=1 bun dev/brief.ts
import rib from "../src/index.ts";

process.env.KEELSON_ADME_SAMPLE = "1";
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
const tools = rib.registerTools?.(ctx as never) ?? [];
await new Promise((r) => setTimeout(r, 400));
const brief = tools.find((t) => t.name === "adme_brief");
await brief?.execute({}, {
  emit: (e: { content: string }) => console.log(JSON.stringify(JSON.parse(e.content), null, 2)),
} as never);
await rib.dispose?.();
