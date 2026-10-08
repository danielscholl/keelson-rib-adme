import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  columnRegions,
  ribIdSchema,
  ribSurfaceDescriptorSchema,
  ribViewDescriptorSchema,
} from "@keelson/shared";
import rib from "../src/index";
import { BOARD_KEYS, CONNECTION_KEY, HEADER_KEY, PERSON_KEY, RECORDS_KEY } from "../src/keys";
import { SECTION_ACTION } from "../src/section";
import { Store } from "../src/store";
import { sectionOf } from "../src/surfaces";
import { SAMPLE_PROFILE } from "./fixtures/profile";
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

  test("one ADME surface whose header carries the sections and the connection", () => {
    const surfaces = rib.surfaces ?? [];
    expect(surfaces.map((s) => s.title)).toEqual(["ADME"]);
    const layout = surfaces[0]?.layout;
    expect(layout?.header?.key).toBe(HEADER_KEY);
    expect(layout?.footer).toBeUndefined();
    expect(regionKeys()).not.toContain(CONNECTION_KEY);
  });

  test("every row region belongs to a section and hides when that section is not showing", () => {
    const rows = (rib.surfaces ?? []).flatMap((s) =>
      s.layout.rows.flatMap((r) => r.columns.flatMap((c) => columnRegions(c))),
    );
    for (const region of rows) {
      expect(sectionOf(region.key)).toBeDefined();
      expect(region.hideWhenEmpty).toBe(true);
    }
    expect(rows.some((r) => sectionOf(r.key) === "access")).toBe(true);
    expect(rows.some((r) => sectionOf(r.key) === "data")).toBe(true);
    expect(rows.some((r) => sectionOf(r.key) === "seismic")).toBe(true);
    for (const row of (rib.surfaces ?? []).flatMap((s) => s.layout.rows)) {
      expect(row.zoneTitle).toBeUndefined();
    }
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

  test("the tab carries no badge; counts live on the section switcher", () => {
    expect((rib.surfaces ?? []).map((s) => s.badgeKey)).toEqual([undefined]);
  });
});

describe("binding", () => {
  test("registers every key and every resting frame passes its validator", async () => {
    const { ctx, snapshots } = fakeContext();
    rib.registerTools?.(ctx);
    expect(snapshots.keys().sort()).toEqual([...BOARD_KEYS].sort());
    const frames = await snapshots.composeAll();
    expect(frames.size).toBe(BOARD_KEYS.length);
  });

  test("only the showing section's regions publish", async () => {
    const dir = mkdtempSync(join(tmpdir(), "adme-rib-"));
    const store = new Store(dir);
    store.write("profile.json", SAMPLE_PROFILE);
    store.write("test.json", { testedAt: "2026-10-02T14:05:00Z", capabilities: [] });
    const { ctx, snapshots } = fakeContext({ getDataDir: () => dir });
    rib.registerTools?.(ctx);
    const sections = async (key: string) => {
      const frame = await snapshots.recompose(key);
      return (frame.data as { sections: unknown[] }).sections.length;
    };
    expect(await sections(RECORDS_KEY)).toBe(0);
    const res = await rib.onAction?.(
      { type: SECTION_ACTION, payload: { section: "data" } },
      fakeContext().ctx,
    );
    expect(res).toMatchObject({ ok: true, data: { effect: "open-surface" } });
    expect(await sections(RECORDS_KEY)).toBeGreaterThan(0);
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
