import { describe, expect, test } from "bun:test";
import { type CanvasBoardView, expectView } from "@keelson/shared";
import { composeDataPulse } from "../src/boards/data-pulse";
import { composeServices } from "../src/boards/services";
import { KINDS_AREA, LEGAL_AREA, SERVICES_AREA } from "../src/data/areas";
import { DATA_PULSE_KEY, SERVICES_KEY } from "../src/keys";
import { dataPulseModule } from "../src/modules/data";
import { NOW, SAMPLE_KINDS, SAMPLE_LEGAL, SAMPLE_SERVICES } from "./fixtures/data";
import { seededRuntime } from "./harness";

const pulseBoard = expectView(DATA_PULSE_KEY, "board");
const servicesBoard = expectView(SERVICES_KEY, "board");

const SEED = {
  [SERVICES_AREA]: SAMPLE_SERVICES,
  [LEGAL_AREA]: SAMPLE_LEGAL,
  [KINDS_AREA]: SAMPLE_KINDS,
};

type Section = CanvasBoardView["sections"][number];

function section<K extends Section["kind"]>(view: CanvasBoardView, kind: K) {
  return view.sections.find((s): s is Extract<Section, { kind: K }> => s.kind === kind);
}

function tiles(view: CanvasBoardView) {
  return Object.fromEntries(
    (section(view, "stats")?.items ?? []).map((t) => [t.label, { value: t.value, sub: t.sub }]),
  );
}

function pulse(rt: ReturnType<typeof seededRuntime>): CanvasBoardView {
  return pulseBoard(composeDataPulse(rt)) as CanvasBoardView;
}

describe("data pulse, connected", () => {
  test("the sample cast reproduces the spec's tiles, status and chip", () => {
    const view = pulse(seededRuntime(SEED, { now: NOW }));
    expect(view.header?.status).toEqual({ label: "1 tag invalid · 1 expiring", tone: "caution" });
    expect(view.header?.chip).toBe("opendes · measured counts 14:05Z, legal 14:05Z");
    expect(tiles(view)).toEqual({
      Records: { value: "1,284,512", sub: "summed over kinds, may be incomplete" },
      Kinds: { value: "214", sub: "214 families · 1 authority" },
      "Legal tags valid": { value: "14", sub: "of 15 tags" },
      "Invalid or expiring": { value: "2", sub: "1 invalid, 1 within 30 days" },
    });
    const needs = section(view, "stats")?.items.find((t) => t.label === "Invalid or expiring");
    expect(needs?.tone).toBe("caution");
  });

  test("the tracked total is the visible count; past the bucket limit kinds say so", () => {
    const many = Array.from({ length: 1000 }, (_, i) => ({
      kind: `osdu:wks:reference-data--Sample${i}:1.0.0`,
      count: 1,
    }));
    const seeded = { ...SEED, [KINDS_AREA]: { total: 1000, visible: 1_300_008, kinds: many } };
    const t = tiles(pulse(seededRuntime(seeded, { now: NOW })));
    expect(t.Records).toEqual({ value: "1,300,008", sub: "indexed, visible to this sign-in" });
    expect(t.Kinds).toEqual({ value: "1,000", sub: "search's 1,000 limit, may be more" });
  });

  test("the Data badge counts invalid and expiring tags", () => {
    const badge = dataPulseModule.counts?.data;
    expect(badge?.(seededRuntime(SEED, { now: NOW }))).toBe(2);
    expect(badge?.(seededRuntime({}, { now: NOW }))).toBe(0);
  });

  test("nothing to look at reads calm", () => {
    const legal = { valid: SAMPLE_LEGAL.valid.slice(1), invalid: [] };
    const view = pulse(seededRuntime({ ...SEED, [LEGAL_AREA]: legal }, { now: NOW }));
    expect(view.header?.status?.tone).toBe("ok");
    const needs = section(view, "stats")?.items.find((t) => t.label === "Invalid or expiring");
    expect(needs).toMatchObject({ value: "0" });
    expect(needs?.tone).toBeUndefined();
  });

  test("an unmeasured area draws ? and never 0", () => {
    const view = pulse(seededRuntime({ [LEGAL_AREA]: SAMPLE_LEGAL }, { now: NOW }));
    const t = tiles(view);
    expect(t.Records).toEqual({ value: null, sub: "not measured" });
    expect(t.Kinds).toEqual({ value: null, sub: "not measured" });
    expect(t["Legal tags valid"]?.value).toBe("14");
  });

  test("tiles read sensibly with many invalid tags", () => {
    const many = {
      valid: SAMPLE_LEGAL.valid.slice(1),
      invalid: Array.from({ length: 46 }, (_, i) => ({ name: `opendes-old-${i}`, countries: [] })),
    };
    const view = pulse(seededRuntime({ ...SEED, [LEGAL_AREA]: many }, { now: NOW }));
    expect(view.header?.status?.label).toBe("46 tags invalid");
    expect(tiles(view)["Legal tags valid"]).toEqual({ value: "13", sub: "of 59 tags" });
  });
});

describe("data pulse, other phases", () => {
  test("sign-in needed keeps the cached tiles and says cached from", () => {
    const view = pulse(seededRuntime(SEED, { now: NOW, phase: "signin" }));
    expect(view.header?.status).toEqual({ label: "sign-in needed", tone: "error" });
    expect(view.header?.chip).toBe("opendes · cached from counts 14:05Z, legal 14:05Z");
    expect(view.sections[0]).toMatchObject({ kind: "cards", title: "Sign in again" });
    expect(tiles(view).Records?.value).toBe("1,284,512");
  });

  test("first run draws ? everywhere and points at the connect steps", () => {
    const view = pulse(seededRuntime({}, { now: NOW, phase: "firstrun" }));
    expect(view.header?.status?.label).toBe(
      "not connected, finish the connect steps in the header",
    );
    const items = section(view, "stats")?.items ?? [];
    expect(items).toHaveLength(4);
    for (const t of items) expect(t).toMatchObject({ value: null, sub: "not measured" });
  });
});

describe("services", () => {
  test("the sample cast draws the chip, grid and versions", () => {
    const view = servicesBoard(
      composeServices(seededRuntime(SEED, { now: NOW })),
    ) as CanvasBoardView;
    expect(view.header?.chip).toBe("5 answered · 1 not permitted · 4 not probed");
    const grid = Object.fromEntries(
      (section(view, "grid")?.cells ?? []).map((c) => [c.label, c.badge]),
    );
    expect(grid.entitlements).toEqual({ text: "ok", tone: "ok" });
    expect(grid.partition).toEqual({ text: "403", tone: "caution" });
    expect(grid.schema).toEqual({ text: "?", tone: "neutral" });
    const rows = Object.fromEntries(
      (section(view, "rows")?.items ?? []).map((r) => [r.text, r.trailing]),
    );
    expect(rows).toEqual({
      entitlements: "0.28.2",
      legal: "0.28.0",
      storage: "0.28.1",
      search: "0.28.1",
      partition: "403, not permitted (service principal only)",
    });
  });

  test("a version is shown as returned and a failure is named", () => {
    const probes = [
      { service: "legal", state: "ok", version: "0.29.0-SNAPSHOT" },
      { service: "search", state: "error", status: 502, message: "bad gateway" },
      { service: "partition", state: "forbidden", status: 403, message: "Forbidden" },
    ];
    const view = composeServices(seededRuntime({ [SERVICES_AREA]: probes }, { now: NOW }));
    const text = JSON.stringify(servicesBoard(view));
    expect(text).toContain("0.29.0-SNAPSHOT");
    expect(text).toContain("502, bad gateway");
    expect(text).toContain("403, not permitted (Forbidden)");
    expect(text).toContain("1 failed");
  });

  test("sign-in needed keeps the last probe and says cached from", () => {
    const view = composeServices(seededRuntime(SEED, { now: NOW, phase: "signin" }));
    expect(view.header?.chip).toBe(
      "5 answered · 1 not permitted · 4 not probed · cached from 14:05Z",
    );
  });

  test("first run hides the region", () => {
    const view = composeServices(seededRuntime({}, { now: NOW, phase: "firstrun" }));
    expect(view.sections).toHaveLength(0);
  });
});

describe("every frame passes its validator", () => {
  const cases = [
    ["connected", seededRuntime(SEED, { now: NOW })],
    ["connected, unmeasured", seededRuntime({}, { now: NOW })],
    ["signin", seededRuntime(SEED, { now: NOW, phase: "signin" })],
    ["firstrun", seededRuntime({}, { now: NOW, phase: "firstrun" })],
  ] as const;
  for (const [name, rt] of cases) {
    test(name, () => {
      pulseBoard(composeDataPulse(rt));
      servicesBoard(composeServices(rt));
    });
  }
});
