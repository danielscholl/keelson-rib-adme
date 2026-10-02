import { afterEach, describe, expect, test } from "bun:test";
import {
  columnRegions,
  ribIdSchema,
  ribSurfaceDescriptorSchema,
  ribViewDescriptorSchema,
} from "@keelson/shared";
import rib from "../src/index";
import { BADGE_KEYS, BOARD_KEYS, CONNECTION_KEY, PERSON_KEY } from "../src/keys";
import { fakeContext } from "./harness";

afterEach(async () => {
  await rib.dispose?.();
});

function regionKeys(): string[] {
  return (rib.surfaces ?? []).flatMap((s) => [
    ...(s.layout.header ? [s.layout.header.key] : []),
    ...s.layout.rows.flatMap((r) => r.columns.flatMap((c) => columnRegions(c).map((x) => x.key))),
    ...(s.layout.footer ? [s.layout.footer.key] : []),
  ]);
}

describe("rib contract shape", () => {
  test("id is a valid rib id matching the package basename", () => {
    expect(ribIdSchema.parse(rib.id)).toBe("adme");
  });

  test("every view and surface parses against the host schemas", () => {
    for (const view of rib.views ?? []) ribViewDescriptorSchema.parse(view);
    for (const surface of rib.surfaces ?? []) ribSurfaceDescriptorSchema.parse(surface);
  });

  test("three surfaces, labelled with the rib name, share one connection footer", () => {
    const surfaces = rib.surfaces ?? [];
    expect(surfaces.map((s) => s.title)).toEqual(["ADME Access", "ADME Data", "ADME Seismic"]);
    expect(surfaces.map((s) => s.layout.footer?.key)).toEqual([
      CONNECTION_KEY,
      CONNECTION_KEY,
      CONNECTION_KEY,
    ]);
  });

  test("every key lives under the rib namespace", () => {
    for (const key of [...BOARD_KEYS, ...BADGE_KEYS, ...regionKeys()]) {
      expect(key.startsWith("rib:adme:")).toBe(true);
    }
  });

  test("every region binds a declared view; inspectors have a view and no region", () => {
    const views = new Set((rib.views ?? []).map((v) => v.key));
    for (const key of regionKeys()) expect(views.has(key)).toBe(true);
    expect(views.has(PERSON_KEY)).toBe(true);
    expect(regionKeys()).not.toContain(PERSON_KEY);
  });

  test("badge keys belong to surfaces and are not views", () => {
    const badges = (rib.surfaces ?? []).map((s) => s.badgeKey).filter(Boolean);
    expect(badges).toEqual([...BADGE_KEYS]);
    const views = new Set((rib.views ?? []).map((v) => v.key));
    for (const key of BADGE_KEYS) expect(views.has(key)).toBe(false);
  });
});

describe("binding", () => {
  test("registers every key and every resting frame passes its validator", async () => {
    const { ctx, snapshots } = fakeContext();
    rib.registerTools?.(ctx);
    expect(snapshots.keys().sort()).toEqual([...BOARD_KEYS, ...BADGE_KEYS].sort());
    const frames = await snapshots.composeAll();
    expect(frames.size).toBe(BOARD_KEYS.length + BADGE_KEYS.length);
  });

  test("binding twice replaces the registrations instead of throwing", () => {
    const { ctx } = fakeContext();
    rib.registerTools?.(ctx);
    expect(() => rib.registerTools?.(ctx)).not.toThrow();
  });

  test("unknown actions fail closed", async () => {
    const result = await rib.onAction?.({ type: "nope" } as any, fakeContext().ctx);
    expect(result).toMatchObject({ ok: false });
  });
});

describe("docs", () => {
  test("the docs source parses", async () => {
    const { ribDocsSourceSchema } = await import("@keelson/shared");
    for (const source of rib.contributeDocs?.(fakeContext().ctx) ?? []) {
      ribDocsSourceSchema.parse(source);
    }
  });
});
