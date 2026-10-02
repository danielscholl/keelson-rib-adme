import type { RibContext, RibExec, SnapshotManager } from "@keelson/shared";

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
