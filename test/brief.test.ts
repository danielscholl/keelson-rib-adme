import { describe, expect, test } from "bun:test";
import { ACCESS_AREA } from "../src/access/read";
import { briefOf } from "../src/brief/inputs";
import { LEGAL_AREA } from "../src/data/areas";
import { FACETS_AREA } from "../src/data/map";
import { SEISMIC_AREA } from "../src/seismic/read";
import { sampleAccess } from "./fixtures/access";
import { NOW, SAMPLE_FACETS, SAMPLE_LEGAL } from "./fixtures/data";
import { groupEmail, sampleSeismic } from "./fixtures/seismic";
import { seededRuntime } from "./harness";

const FORMER = "00000000-0000-4000-8000-0000000000ff";
const ORPHAN = "ffffffff-0000-4000-8000-000000000001";

function healthy() {
  const read = sampleAccess();
  const users = new Set(read.groups.users.map((m) => m.id));
  for (const m of read.groups.editors) {
    if (!m.id.includes("@") && !users.has(m.id)) read.groups.users.push({ id: m.id, owner: false });
  }
  read.groups.editors = read.groups.editors.filter((m) => !m.id.includes("@"));
  return read;
}

describe("decisions", () => {
  test("blocked and inconsistent people lead; invitations and no call never raise an item", () => {
    const brief = briefOf(seededRuntime({ [ACCESS_AREA]: sampleAccess() }));
    expect(brief.items.map((i) => [i.cls, i.title])).toEqual([
      ["BLOCKED", "Rachel Kim cannot use the instance"],
      ["INCONSISTENT", "Dmitri Volkov is listed twice in the Editor group"],
    ]);
    expect(brief.headline).toBe("Rachel Kim cannot use the instance as configured.");
    expect(brief.summary).toBe(
      "Editor role configured; users@ membership missing. Dmitri Volkov is listed twice in the Editor group.",
    );
    expect(brief.onboarding?.count).toBe(3);
    expect(brief.onboarding?.text).toContain("None has accepted.");
    expect(brief.adoption).toBe("Observed use is not measured: no audit log workspace is set.");
    const rachel = brief.items[0];
    expect(rachel?.facts.map((f) => [f.label, f.value, f.source])).toEqual([
      ["Invitation", "accepted 29 Sep", "directory"],
      ["users@ membership", "missing", "instance"],
      ["Data role", "Editor configured", "instance"],
      ["Observed use", "not measured", "audit"],
    ]);
    expect(rachel?.subject).toBe("who:00000000-0000-4000-8000-000000000011");
  });

  test("with nothing to decide the headline says so and the summary names the oldest invitation", () => {
    const brief = briefOf(seededRuntime({ [ACCESS_AREA]: healthy() }));
    expect(brief.items).toEqual([]);
    expect(brief.headline).toBe("Nobody is blocked.");
    expect(brief.summary).toBe("The oldest pending invitation is Amara Diallo's, 4 d ago.");
  });

  test("an unnamed id with a role is an identity item until labelled; a labelled loader keeps one while it holds a role", () => {
    const read = healthy();
    read.groups.users.push({ id: ORPHAN, owner: false });
    read.groups.ops.push({ id: ORPHAN, owner: false });
    const rt = seededRuntime({ [ACCESS_AREA]: read });
    expect(briefOf(rt).items.map((i) => i.title)).toEqual(["An id holding Ops has no name"]);
    const key = `object:${rt.profile?.tenantId}:${ORPHAN}`;
    rt.annotations.set(key, { label: "Reference data loader", kind: "historical-actor" }, NOW);
    expect(briefOf(rt).items.map((i) => i.title)).toEqual([
      "Reference data loader still holds Ops",
    ]);
    read.groups.ops = read.groups.ops.filter((m) => m.id !== ORPHAN);
    rt.cache.succeed(ACCESS_AREA, read, NOW);
    expect(briefOf(rt).items).toEqual([]);
  });

  test("a seismic grant held without users@ or a role is a GRANT item that opens its cell", () => {
    const access = healthy();
    access.directory[FORMER] = {
      kind: "user",
      name: "Kari Solberg",
      mail: "kari@halden-geo.example",
    };
    const seismic = sampleSeismic();
    seismic.groups[groupEmail("delta", "viewer")]?.members?.push(FORMER);
    const brief = briefOf(seededRuntime({ [ACCESS_AREA]: access, [SEISMIC_AREA]: seismic }));
    const grant = brief.items.find((i) => i.cls === "GRANT");
    expect(grant).toMatchObject({
      title: "Kari Solberg keeps a delta grant without instance access",
      sub: "Viewer on delta; no role group, no users@",
      subject: `cell:${FORMER}:delta`,
    });
  });

  test("a tag in use that expires soon is LEGAL; an invalid tag nothing uses is not", () => {
    const brief = briefOf(
      seededRuntime({
        [ACCESS_AREA]: healthy(),
        [LEGAL_AREA]: SAMPLE_LEGAL,
        [FACETS_AREA]: SAMPLE_FACETS,
        [SEISMIC_AREA]: sampleSeismic(),
      }),
    );
    expect(brief.items.map((i) => [i.cls, i.title, i.sub])).toEqual([
      [
        "LEGAL",
        "opendes-pilot-trial expires in 22 days",
        "in use on foxtrot, golf, golf2, golf3 and 8,400 indexed records",
      ],
    ]);
  });

  test("invalid tags carried only by records fold into one decision; Data keeps each", () => {
    const leftovers = ["opendes-test-tag-01", "opendes-test-tag-02", "opendes-test-tag-03"];
    const legal = {
      ...SAMPLE_LEGAL,
      invalid: [
        ...SAMPLE_LEGAL.invalid,
        ...leftovers.map((name) => ({
          name,
          expirationDate: "2026-01-31",
          countries: ["US"],
          dataType: "Public Domain Data",
          securityClassification: "Public",
        })),
      ],
    };
    const facets = {
      ...SAMPLE_FACETS,
      tags: [
        ...(SAMPLE_FACETS.tags ?? []),
        { key: "opendes-test-tag-01", count: 1 },
        { key: "opendes-test-tag-02", count: 6 },
        { key: "opendes-test-tag-03", count: 2 },
      ],
    };
    const brief = briefOf(
      seededRuntime({
        [ACCESS_AREA]: healthy(),
        [LEGAL_AREA]: legal,
        [FACETS_AREA]: facets,
        [SEISMIC_AREA]: sampleSeismic(),
      }),
    );
    expect(brief.items.map((i) => [i.id, i.title, i.sub])).toEqual([
      [
        "item:legal:opendes-pilot-trial",
        "opendes-pilot-trial expires in 22 days",
        "in use on foxtrot, golf, golf2, golf3 and 8,400 indexed records",
      ],
      [
        "item:legal:*invalid",
        "3 invalid legal tags still hold 9 indexed records",
        "most on opendes-test-tag-02 (6) · Data lists each",
      ],
    ]);
    expect(brief.headline).toBe("Four legal tags in use need care.");
    expect(brief.items[1]?.facts.map((f) => f.label)).toEqual([
      "opendes-test-tag-02",
      "opendes-test-tag-03",
      "opendes-test-tag-01",
    ]);
    expect(brief.stewardship?.map((i) => i.id)).toEqual([
      "item:legal:opendes-test-tag-01",
      "item:legal:opendes-test-tag-02",
      "item:legal:opendes-test-tag-03",
      "item:legal:opendes-pilot-trial",
    ]);
  });

  test("a seismic read past 24 hours is a READ item and an amber stamp note", () => {
    const rt = seededRuntime({ [ACCESS_AREA]: healthy() });
    rt.cache.succeed(SEISMIC_AREA, sampleSeismic(), new Date(NOW.getTime() - 6 * 86_400_000));
    const brief = briefOf(rt);
    expect(brief.items.map((i) => [i.cls, i.title, i.sub])).toEqual([
      ["READ", "Seismic members were read 6 days ago", "limit is 24 h; views show that read"],
    ]);
    expect(brief.stamp.text).toBe("read 14:05Z");
    expect(brief.stamp.notes).toContainEqual({
      text: "seismic members 6 days old",
      inspect: "read:seismic",
    });
  });

  test("a failed read keeps its last data and names the error", () => {
    const rt = seededRuntime({ [ACCESS_AREA]: healthy(), [SEISMIC_AREA]: sampleSeismic() });
    rt.cache.fail(SEISMIC_AREA, "subprojects: 503", new Date(NOW.getTime() + 60_000));
    const read = briefOf(rt).items.find((i) => i.cls === "READ");
    expect(read).toMatchObject({
      title: "Seismic members could not be read",
      sub: "subprojects: 503",
    });
    expect(read?.next).toContain("Views keep the last good read until then.");
  });
});

describe("before the instance is read", () => {
  test("unconnected and sign-in states say what to do, with no items", () => {
    const first = briefOf(seededRuntime({}, { phase: "firstrun" }));
    expect(first).toMatchObject({ state: "unconnected", headline: "Connect to an ADME instance." });
    const signin = briefOf(seededRuntime({}, { phase: "signin" }));
    expect(signin).toMatchObject({ state: "signin", items: [] });
  });
});
