import type { RibContext, RibExec, SnapshotManager } from "@keelson/shared";
import type { Transport } from "../src/client";
import { Runtime } from "../src/runtime";
import { Store } from "../src/store";
import { SAMPLE_PROFILE } from "./fixtures/profile";

type Composer = () => Promise<unknown>;
type Validator = (data: unknown) => unknown;

// An in-memory SnapshotManager that runs each key's validator on compose, so a
// test fails the same way the host would refuse a frame.
export class FakeSnapshots implements SnapshotManager {
  readonly composers = new Map<string, { compose: Composer; validate?: Validator }>();
  readonly frames = new Map<string, unknown>();

  register<T>(
    key: string,
    compose: () => Promise<T> | T,
    opts?: { validate?: (data: unknown) => T },
  ): () => void {
    if (this.composers.has(key)) throw new Error(`duplicate key ${key}`);
    this.composers.set(key, { compose: async () => compose(), validate: opts?.validate });
    return () => {
      this.composers.delete(key);
    };
  }

  async recompose<T = unknown>(key: string): Promise<any> {
    const entry = this.composers.get(key);
    if (!entry) return undefined;
    const raw = await entry.compose();
    const data = entry.validate ? entry.validate(raw) : raw;
    this.frames.set(key, data);
    return { key, version: 1, data: data as T };
  }

  latest<T = unknown>(key: string): any {
    return this.frames.has(key) ? { key, version: 1, data: this.frames.get(key) as T } : undefined;
  }

  keys(): string[] {
    return [...this.composers.keys()];
  }

  async dispose(): Promise<void> {
    this.composers.clear();
    this.frames.clear();
  }

  async composeAll(): Promise<Map<string, unknown>> {
    for (const key of this.keys()) await this.recompose(key);
    return this.frames;
  }
}

export const noExec: RibExec = {
  runJSON: async () => {
    throw new Error("exec not stubbed");
  },
  runText: async () => {
    throw new Error("exec not stubbed");
  },
};

export function fakeContext(overrides: Partial<RibContext> = {}): {
  ctx: RibContext;
  snapshots: FakeSnapshots;
} {
  const snapshots = new FakeSnapshots();
  const ctx: RibContext = {
    getExec: () => noExec,
    getSnapshotManager: () => snapshots,
    ...overrides,
  };
  return { ctx, snapshots };
}

export interface ExecCall {
  cmd: string;
  args: string[];
}

// An exec that answers `az account get-access-token` with a token per resource,
// or with a failure line, answers `az rest` with `rest`, and records every call.
export function azExec(
  answer: (resource: string) => { token: string } | { error: string } = (r) => ({
    token: `tok-${r}`,
  }),
  rest: () => { data: unknown } | { error: string } = () => ({ data: { data: [] } }),
): RibExec & { calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  const exec = {
    calls,
    runJSON: async <T>(cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      if (args[0] === "rest") {
        const r = rest();
        if ("error" in r) return { ok: false as const, error: r.error, code: 1 };
        return { ok: true as const, data: r.data as T };
      }
      const resource = args[args.indexOf("--resource") + 1] ?? "";
      const a = answer(resource);
      if ("error" in a) return { ok: false as const, error: a.error, code: 1 };
      return { ok: true as const, data: { accessToken: a.token } as T };
    },
    runText: async () => ({ ok: false as const, error: "not stubbed", code: null }),
  };
  return exec;
}

export interface SentRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}

// A transport that routes by "METHOD url-substring" and records each request.
export function routeTransport(
  routes: Record<string, (req: SentRequest) => { status: number; body?: unknown }>,
) {
  const sent: SentRequest[] = [];
  const transport = async (req: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body?: string;
  }) => {
    const parsed: SentRequest = {
      ...req,
      body: req.body === undefined ? undefined : JSON.parse(req.body),
    };
    sent.push(parsed);
    const match = Object.keys(routes)
      .filter((k) => {
        const [m, ...rest] = k.split(" ");
        return m === req.method && req.url.includes(rest.join(" "));
      })
      .sort((a, b) => b.length - a.length)[0];
    if (!match) return { status: 404, body: JSON.stringify({ message: `no route ${req.url}` }) };
    const res = routes[match]!(parsed);
    return {
      status: res.status,
      body: res.body === undefined ? "" : JSON.stringify(res.body),
    };
  };
  return { transport, sent };
}

// A runtime that is connected to the sample instance with the given areas
// already measured at `now`, for composer tests. Pass `phase` to draw another state.
export function seededRuntime(
  seed: Record<string, unknown>,
  opts: { now?: Date; phase?: "connected" | "signin" | "firstrun"; transport?: Transport } = {},
): Runtime {
  const now = opts.now ?? new Date("2026-10-02T14:05:00Z");
  const store = new Store(undefined);
  if (opts.phase !== "firstrun") {
    store.write("profile.json", SAMPLE_PROFILE);
    store.write("test.json", {
      testedAt: now.toISOString(),
      signedInAs: "ingrid.halvorsen@contoso.example",
      capabilities: [],
    });
  }
  const rt = new Runtime({
    exec: azExec(),
    store,
    recompose: () => undefined,
    allKeys: [],
    now: () => now,
    ...(opts.transport ? { transport: opts.transport } : {}),
    sleep: async () => undefined,
  });
  for (const [area, data] of Object.entries(seed)) rt.cache.succeed(area, data, now);
  if (opts.phase === "signin") rt.status = { ...rt.status, phase: "signin", error: "expired" };
  return rt;
}
