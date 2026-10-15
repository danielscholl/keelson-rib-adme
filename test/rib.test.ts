import { afterEach, describe, expect, test } from "bun:test";
import {
  columnRegions,
  ribIdSchema,
  ribSurfaceDescriptorSchema,
  ribViewDescriptorSchema,
} from "@keelson/shared";
import rib from "../src/index";
import {
  BOARD_KEYS,
  CONNECTION_KEY,
  CONSOLE_KEY,
  HEADER_KEY,
  MAP_KEY,
  OPERATION_KEY,
  PERSON_KEY,
  RECENT_KEY,
} from "../src/keys";
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

  test("one ADME surface: the connect header, the console banner, then the regions below it", () => {
    const surfaces = rib.surfaces ?? [];
    expect(surfaces.map((s) => s.title)).toEqual(["ADME"]);
    const layout = surfaces[0]?.layout;
    expect(layout?.header).toMatchObject({ key: HEADER_KEY, hideWhenEmpty: true });
    expect(layout?.banner?.key).toBe(CONSOLE_KEY);
    expect(layout?.footer).toBeUndefined();
    expect(regionKeys()).toEqual([HEADER_KEY, OPERATION_KEY, RECENT_KEY, MAP_KEY]);
    expect(regionKeys()).not.toContain(CONNECTION_KEY);
  });

  test("the console is html; every other region and drawer is a board", () => {
    const kinds = new Map((rib.views ?? []).map((v) => [v.key, v.canvasKind]));
    expect(kinds.get(CONSOLE_KEY)).toBe("html");
    for (const key of BOARD_KEYS) expect(kinds.get(key)).toBe("view");
  });

  test("every key lives under the rib namespace", () => {
    for (const key of [...BOARD_KEYS, ...regionKeys()]) {
      expect(key.startsWith("rib:adme:")).toBe(true);
    }
  });

  test("every region binds a declared view; inspectors have a view and no region", () => {
    const views = new Set((rib.views ?? []).map((v) => v.key));
    for (const key of regionKeys()) expect(views.has(key)).toBe(true);
    expect(views.has(PERSON_KEY)).toBe(true);
    expect(regionKeys()).not.toContain(PERSON_KEY);
  });

  test("the tab carries no badge; the console names its decisions", () => {
    expect((rib.surfaces ?? []).map((s) => s.badgeKey)).toEqual([undefined]);
  });
});

describe("binding", () => {
  test("registers every key and every resting frame passes its validator", async () => {
    const { ctx, snapshots } = fakeContext();
    rib.registerTools?.(ctx);
    expect(snapshots.keys().sort()).toEqual([...BOARD_KEYS, CONSOLE_KEY].sort());
    const frames = await snapshots.composeAll();
    expect(frames.size).toBe(BOARD_KEYS.length + 1);
    expect(typeof frames.get(CONSOLE_KEY)).toBe("string");
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
