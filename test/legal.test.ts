import { describe, expect, test } from "bun:test";
import { type CanvasBoardView, expectView } from "@keelson/shared";
import {
  composeLegal,
  INVALID_CARD_CAP,
  INVALID_ROW_CAP,
  VALID_ROW_CAP,
} from "../src/boards/legal";
import { LEGAL_BROWSE_ACTION } from "../src/boards/records";
import { LEGAL_AREA, type LegalTag, type LegalTags } from "../src/data/areas";
import { classifyTags } from "../src/data/legal";
import { LEGAL_KEY } from "../src/keys";
import { legalModule } from "../src/modules/legal";
import { NOW, SAMPLE_LEGAL } from "./fixtures/data";
import { seededRuntime } from "./harness";

const board = expectView(LEGAL_KEY, "board");

type Section = CanvasBoardView["sections"][number];

function section<K extends Section["kind"]>(
  view: CanvasBoardView,
  kind: K,
  title: string,
): Extract<Section, { kind: K }> {
  const found = view.sections.find((s) => s.kind === kind && s.title?.startsWith(title));
  if (!found) throw new Error(`no ${kind} section "${title}"`);
  return found as Extract<Section, { kind: K }>;
}

function validate(view: CanvasBoardView): CanvasBoardView {
  return board(view) as CanvasBoardView;
}

function draw(seed: Record<string, unknown>, phase?: "connected" | "signin" | "firstrun") {
  const rt = seededRuntime(seed, { now: NOW, ...(phase ? { phase } : {}) });
  return validate(composeLegal(rt));
}

function scaledCast(): LegalTags {
  const invalid: LegalTag[] = Array.from({ length: 46 }, (_, i) => ({
    name: `opendes-sample-stale-${String(i + 1).padStart(2, "0")}`,
    expirationDate: `2025-${String((i % 12) + 1).padStart(2, "0")}-15`,
    countries: ["US"],
  }));
  const valid: LegalTag[] = Array.from({ length: 30 }, (_, i) => ({
    name: `opendes-sample-valid-${String(i + 1).padStart(2, "0")}`,
    expirationDate: i < 2 ? `2026-10-${String(10 + i)}` : "2099-12-31",
    countries: ["NO"],
    dataType: "Public Domain Data",
  }));
  return { valid, invalid };
}

describe("classifyTags", () => {
  test("splits the sample cast into 1 invalid, 1 expiring in 22 d, and 13 others", () => {
    const c = classifyTags(SAMPLE_LEGAL, NOW);
    expect(c.invalid.map((t) => t.name)).toEqual(["opendes-legacy-training"]);
    expect(c.expiring).toHaveLength(1);
    expect(c.expiring[0]?.tag.name).toBe("opendes-pilot-trial");
    expect(c.expiring[0]?.daysLeft).toBe(22);
    expect(c.rest).toHaveLength(13);
  });

  test("orders invalid tags newest expiry first", () => {
    const c = classifyTags(
      {
        valid: [],
        invalid: [
          { name: "a", countries: [] },
          { name: "b", expirationDate: "2026-01-01", countries: [] },
          { name: "c", expirationDate: "2026-09-01", countries: [] },
        ],
      },
      NOW,
    );
    expect(c.invalid.map((t) => t.name)).toEqual(["c", "b", "a"]);
  });
});

describe("connected", () => {
  test("the sample cast draws per spec", () => {
    const view = draw({ [LEGAL_AREA]: SAMPLE_LEGAL });
    expect(view.header?.status).toEqual({ label: "2 need a look", tone: "caution" });
    expect(view.header?.chip).toBe("15 tags · measured 14:05Z");
    expect(view.header?.segments).toEqual([
      { label: "valid", n: 14, tone: "ok" },
      { label: "invalid", n: 1, tone: "error" },
    ]);

    const needs = section(view, "cards", "Needs a look · 2");
    const [invalid, expiring] = needs.items;
    expect(needs.items).toHaveLength(2);
    expect(invalid?.title).toBe("opendes-legacy-training");
    expect(invalid?.edge).toBe("error");
    expect(invalid?.pill?.label).toBe("invalid");
    expect(invalid?.fields).toContainEqual({
      label: "expired",
      value: "2026-08-31",
      tone: "error",
    });
    expect(invalid?.actions).toEqual([
      {
        type: LEGAL_BROWSE_ACTION,
        label: "Browse records",
        payload: { tag: "opendes-legacy-training" },
      },
    ]);
    expect(invalid?.fields).toContainEqual({
      label: "name",
      value: "opendes-legacy-training",
      copyable: true,
    });
    expect(invalid?.reason?.text).toBe("the contract expiry date has passed.");
    expect(JSON.stringify(view)).not.toContain("cannot be read");

    expect(expiring?.title).toBe("opendes-pilot-trial");
    expect(expiring?.edge).toBe("warn");
    expect(expiring?.pill?.label).toBe("expires");
    expect(expiring?.fields).toEqual([
      { label: "expires in", value: "22 d", tone: "warn" },
      { label: "on", value: "2026-10-24" },
      { label: "countries", value: "US" },
      { label: "classification", value: "Private" },
    ]);

    const valid = section(view, "rows", "Valid, no expiry within 30 days · 13");
    expect(valid.items.map((r) => r.text)).toEqual([
      "opendes-public-usa-dataset",
      "opendes-public-norway",
      "… 11 more valid tags",
    ]);
    expect(valid.items[0]?.trailing).toBe("expires 2099-12-31 · Public Domain Data");
    expect(view.sections.some((s) => s.title?.startsWith("More invalid"))).toBe(false);

    const bands = section(view, "bars", "Tags by expiry");
    expect(bands.items.map((b) => [b.label, b.value])).toEqual([
      ["past", 1],
      ["0–30 d", 1],
      ["31–90 d", 0],
      ["91–365 d", 0],
      ["over 365 d", 13],
      ["no date", 0],
    ]);
    expect(bands.items[0]?.tone).toBe("error");

    const props = section(view, "rows", "Tag properties · counted over tags");
    expect(props.items[0]).toEqual({ text: "country of origin", trailing: "US 13 · NO 2" });
    expect(props.items[3]).toEqual({ text: "personal data", trailing: "not set 15" });
  });

  test("46 invalid and 30 valid tags stay within the caps", () => {
    const view = draw({ [LEGAL_AREA]: scaledCast() });
    expect(view.header?.status?.label).toBe("48 need a look");
    expect(view.header?.chip).toBe("76 tags · measured 14:05Z");

    const needs = section(view, "cards", "Needs a look · 48");
    expect(needs.items).toHaveLength(INVALID_CARD_CAP + 2);
    expect(needs.items.filter((c) => c.pill?.label === "invalid")).toHaveLength(INVALID_CARD_CAP);

    const more = section(view, "rows", `More invalid tags · ${46 - INVALID_CARD_CAP}`);
    expect(more.items).toHaveLength(INVALID_ROW_CAP + 1);
    expect(more.items.at(-1)?.text).toBe(
      `… ${46 - INVALID_CARD_CAP - INVALID_ROW_CAP} more invalid tags`,
    );

    const valid = section(view, "rows", "Valid, no expiry within 30 days · 28");
    expect(valid.items).toHaveLength(VALID_ROW_CAP + 1);
    expect(valid.items.at(-1)?.text).toBe(`… ${28 - VALID_ROW_CAP} more valid tags`);
  });

  test("a calm status when nothing needs a look", () => {
    const view = draw({ [LEGAL_AREA]: { valid: SAMPLE_LEGAL.valid.slice(1), invalid: [] } });
    expect(view.header?.status?.tone).toBe("ok");
    expect(view.sections.some((s) => s.title?.startsWith("Needs a look"))).toBe(false);
  });

  test("a failed read over older data keeps the data and names the error", () => {
    const rt = seededRuntime({ [LEGAL_AREA]: SAMPLE_LEGAL }, { now: NOW });
    rt.cache.fail(LEGAL_AREA, "legal answered 500", new Date("2026-10-02T14:10:00Z"));
    const view = validate(composeLegal(rt));
    const first = view.sections[0];
    expect(first?.kind).toBe("rows");
    expect(JSON.stringify(first)).toContain("legal answered 500");
    section(view, "cards", "Needs a look · 2");
  });

  test("never measured says so and draws nothing else", () => {
    const view = draw({});
    expect(view.header?.status).toEqual({ label: "not measured", tone: "neutral" });
    expect(view.sections).toHaveLength(1);
    expect(view.sections[0]?.kind).toBe("rows");
  });
});

describe("other phases", () => {
  test("sign-in needed keeps the cached content", () => {
    const view = draw({ [LEGAL_AREA]: SAMPLE_LEGAL }, "signin");
    expect(view.header?.chip).toBe("15 tags · cached from 14:05Z");
    section(view, "cards", "Needs a look · 2");
  });

  test("first run hides the region", () => {
    expect(draw({ [LEGAL_AREA]: SAMPLE_LEGAL }, "firstrun").sections).toEqual([]);
  });

  test("a profile error hides the region", () => {
    const rt = seededRuntime({ [LEGAL_AREA]: SAMPLE_LEGAL }, { now: NOW });
    rt.status = { ...rt.status, phase: "profile-error", error: "unreachable" };
    expect(validate(composeLegal(rt)).sections).toEqual([]);
  });

  test("the module composes the legal key and registers no areas or counts", () => {
    expect(Object.keys(legalModule.composers ?? {})).toEqual([LEGAL_KEY]);
    expect(legalModule.areas).toBeUndefined();
    expect(legalModule.counts).toBeUndefined();
  });
});
