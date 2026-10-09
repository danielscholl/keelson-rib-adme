import { describe, expect, test } from "bun:test";
import { type CanvasBoardView, expectView } from "@keelson/shared";
import { composeDataPulse } from "../src/boards/data-pulse";
import { KINDS_AREA, LEGAL_AREA } from "../src/data/areas";
import { FACETS_AREA } from "../src/data/map";
import { DATA_PULSE_KEY } from "../src/keys";
import { dataPulseModule } from "../src/modules/data";
import { NOW, SAMPLE_FACETS, SAMPLE_KINDS, SAMPLE_LEGAL } from "./fixtures/data";
import { seededRuntime } from "./harness";

const pulseBoard = expectView(DATA_PULSE_KEY, "board");

const SEED = {
  [LEGAL_AREA]: SAMPLE_LEGAL,
  [KINDS_AREA]: SAMPLE_KINDS,
  [FACETS_AREA]: SAMPLE_FACETS,
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
    expect(view.header?.status).toEqual({ label: "1 expiring", tone: "caution" });
    expect(view.header?.chip).toBe("opendes · measured counts 14:05Z, legal 14:05Z");
    expect(tiles(view)).toEqual({
      Records: { value: "1,284,512", sub: "summed over kinds, may be incomplete" },
      Kinds: { value: "214", sub: "214 families · 1 authority" },
      "Legal tags in use": { value: "4 of 15", sub: "1 invalid · 1 within 30 days" },
      "ACL groups": { value: "6", sub: "4 read · 2 own, on records" },
    });
    const needs = section(view, "stats")?.items.find((t) => t.label === "Legal tags in use");
    expect(needs?.tone).toBe("caution");
  });

  test("a headline sentence leads, built only from measured values", () => {
    const headline = (seed: Record<string, unknown>) =>
      section(pulse(seededRuntime(seed, { now: NOW })), "rows")?.items[0]?.text;
    expect(headline(SEED)).toBe(
      "1,284,512 records under 4 legal tags; 93% readable through data.default.viewers.",
    );
    const held = {
      ...SAMPLE_FACETS,
      tags: [...(SAMPLE_FACETS.tags ?? []), { key: "opendes-legacy-training", count: 40 }],
    };
    expect(headline({ ...SEED, [FACETS_AREA]: held })).toEndWith(
      "; 1 invalid tag holds 40 records.",
    );
    expect(headline({ [KINDS_AREA]: SAMPLE_KINDS })).toBe("1,284,512 records.");
    expect(headline({ [LEGAL_AREA]: SAMPLE_LEGAL })).toBeUndefined();
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

  test("the Data badge counts invalid tags holding records and expiring tags in use", () => {
    const badge = dataPulseModule.counts?.data;
    expect(badge?.(seededRuntime(SEED, { now: NOW }))).toBe(1);
    const held = {
      ...SAMPLE_FACETS,
      tags: [...(SAMPLE_FACETS.tags ?? []), { key: "opendes-legacy-training", count: 40 }],
    };
    expect(badge?.(seededRuntime({ ...SEED, [FACETS_AREA]: held }, { now: NOW }))).toBe(2);
    expect(badge?.(seededRuntime({ [LEGAL_AREA]: SAMPLE_LEGAL }, { now: NOW }))).toBe(2);
    expect(badge?.(seededRuntime({}, { now: NOW }))).toBe(0);
  });

  test("nothing to look at reads calm", () => {
    const legal = { valid: SAMPLE_LEGAL.valid.slice(1), invalid: [] };
    const view = pulse(seededRuntime({ ...SEED, [LEGAL_AREA]: legal }, { now: NOW }));
    expect(view.header?.status?.tone).toBe("ok");
    const needs = section(view, "stats")?.items.find((t) => t.label === "Legal tags in use");
    expect(needs).toMatchObject({ value: "3 of 13", sub: "all valid, none expire within 30 days" });
    expect(needs?.tone).toBeUndefined();
  });

  test("an unmeasured area draws ? and never 0", () => {
    const view = pulse(seededRuntime({ [LEGAL_AREA]: SAMPLE_LEGAL }, { now: NOW }));
    const t = tiles(view);
    expect(t.Records).toEqual({ value: null, sub: "not measured" });
    expect(t.Kinds).toEqual({ value: null, sub: "not measured" });
    expect(t["Legal tags"]?.value).toBe("15");
    expect(t["ACL groups"]).toEqual({ value: null, sub: "not measured" });
  });

  test("invalid tags count for attention only while they hold records", () => {
    const many = {
      valid: SAMPLE_LEGAL.valid.slice(1),
      invalid: Array.from({ length: 46 }, (_, i) => ({ name: `opendes-old-${i}`, countries: [] })),
    };
    const calm = pulse(seededRuntime({ ...SEED, [LEGAL_AREA]: many }, { now: NOW }));
    expect(calm.header?.status).toEqual({ label: "legal tags hold", tone: "ok" });
    expect(tiles(calm)["Legal tags in use"]).toEqual({
      value: "3 of 59",
      sub: "46 invalid · 0 within 30 days",
    });
    const facets = {
      ...SAMPLE_FACETS,
      tags: [...(SAMPLE_FACETS.tags ?? []), { key: "opendes-old-0", count: 40 }],
    };
    const held = pulse(
      seededRuntime({ ...SEED, [LEGAL_AREA]: many, [FACETS_AREA]: facets }, { now: NOW }),
    );
    expect(held.header?.status).toEqual({ label: "1 invalid tag holds records", tone: "caution" });
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
    });
  }
});
