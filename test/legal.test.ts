import { describe, expect, test } from "bun:test";
import { classifyTags } from "../src/data/legal";
import { NOW, SAMPLE_LEGAL } from "./fixtures/data";

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
