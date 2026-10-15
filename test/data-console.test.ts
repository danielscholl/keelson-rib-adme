import { describe, expect, test } from "bun:test";
import { expectView } from "@keelson/shared";
import { ACCESS_AREA } from "../src/access/read";
import { dataTab } from "../src/boards/console-data";
import { composeRecord } from "../src/boards/record";
import { dataBrief, familiesOf } from "../src/brief/data";
import { buildBrief } from "../src/brief/index";
import { briefInputs } from "../src/brief/inputs";
import { KINDS_AREA, LEGAL_AREA } from "../src/data/areas";
import { FACETS_AREA } from "../src/data/map";
import { setOpenedRecord } from "../src/data/record";
import { INSPECT_KEY, RECORD_KEY, RECORDS_KEY } from "../src/keys";
import { BROWSE_FAMILY_ACTION, composeInspect, consoleModule } from "../src/modules/console";
import { bindingOf } from "../src/plan/model";
import { SEISMIC_AREA } from "../src/seismic/read";
import { INSPECT_ACTION } from "../src/surfaces";
import { sampleAccess } from "./fixtures/access";
import { NOW, SAMPLE_FACETS, SAMPLE_KINDS, SAMPLE_LEGAL } from "./fixtures/data";
import { SAMPLE_PROFILE } from "./fixtures/profile";
import { sampleSeismic } from "./fixtures/seismic";
import { routeTransport, seededRuntime } from "./harness";

const LOADER = "aaaaaaaa-0000-4000-8000-00000000beef";

function rt(transport?: ReturnType<typeof routeTransport>["transport"]) {
  return seededRuntime(
    {
      [ACCESS_AREA]: sampleAccess(),
      [SEISMIC_AREA]: sampleSeismic(),
      [LEGAL_AREA]: SAMPLE_LEGAL,
      [KINDS_AREA]: SAMPLE_KINDS,
      [FACETS_AREA]: SAMPLE_FACETS,
    },
    { now: NOW, ...(transport ? { transport } : {}) },
  );
}

const act = (runtime: ReturnType<typeof rt>, type: string, payload: unknown) =>
  consoleModule.actions?.[type]?.(runtime, payload);

describe("data tab", () => {
  test("families lead, each count names its scope, and the queue keeps unused invalid tags apart", () => {
    const inputs = briefInputs(rt());
    const d = dataBrief(inputs, buildBrief(inputs).items);
    if (!d) throw new Error("data brief expected");
    expect(d.facts.map((f) => [f.label, f.value, f.sub])).toEqual([
      ["Indexed records", "1,284,512", "summed over kinds, may be incomplete"],
      ["Kinds", "214", "6 named families, 208 more kinds"],
      ["Tags needing care", "1", "in use; 1 invalid tag unused"],
    ]);
    expect(d.families.map((f) => [f.label, f.count])[0]).toEqual(["WellLog", 412_300]);
    expect(d.rest).toEqual({ kinds: 208, count: 393_216 });
    expect(d.queue.map((x) => x.title)).toEqual(["opendes-pilot-trial expires in 22 days"]);
    expect(d.lower).toEqual([
      "opendes-legacy-training is invalid. No indexed record carries it; subproject-legacy names it and has no members.",
    ]);
    const html = dataTab(d);
    expect(html).toContain('data-fam="fam:work-product-component--WellLog"');
    expect(html).toContain('data-inspect="find"');
    expect(html).toContain("How these are counted");
  });

  test("before records are read the tab says so", () => {
    const inputs = briefInputs(seededRuntime({ [ACCESS_AREA]: sampleAccess() }));
    expect(dataBrief(inputs, [])).toBeUndefined();
    expect(dataTab(undefined)).toContain("Records and legal tags are not read yet.");
  });
});

describe("family and find", () => {
  test("a family opens with its kinds and Browse records searches its pattern into Find records", async () => {
    const { transport, sent } = routeTransport({
      "POST /api/search/v2/query": () => ({ status: 200, body: { results: [], totalCount: 0 } }),
    });
    const runtime = rt(transport);
    const family = familiesOf(briefInputs(runtime))[0];
    expect(await act(runtime, INSPECT_ACTION, { id: family?.id })).toMatchObject({
      ok: true,
      data: { key: INSPECT_KEY, title: "Family · WellLog" },
    });
    const view = expectView(INSPECT_KEY, "board")(composeInspect(runtime));
    expect(JSON.stringify(view)).toContain("osdu:wks:work-product-component--WellLog:1.2.0");
    const res = await act(runtime, BROWSE_FAMILY_ACTION, { family: family?.key });
    expect(res).toMatchObject({ ok: true, data: { key: RECORDS_KEY, title: "Find records" } });
    expect((sent[0]?.body as { kind?: string } | undefined)?.kind).toBe(
      "*:*:work-product-component--WellLog:*",
    );
  });

  test("Find records opens from the console", async () => {
    const runtime = rt();
    expect(await act(runtime, INSPECT_ACTION, { id: "find" })).toMatchObject({
      data: { effect: "open-canvas", key: RECORDS_KEY },
    });
  });
});

describe("record inspector", () => {
  test("creator and modifier resolve through the directory; an unnamed id offers Label this id", async () => {
    const runtime = rt();
    setOpenedRecord(runtime, {
      instance: `${SAMPLE_PROFILE.host}/${SAMPLE_PROFILE.partition}`,
      id: "opendes:master-data--Well:1",
      at: NOW.toISOString(),
      ok: true,
      record: {
        id: "opendes:master-data--Well:1",
        kind: "osdu:wks:master-data--Well:1.2.0",
        createTime: "2025-03-04T10:00:00Z",
        createUser: LOADER,
        modifyTime: "2026-09-30T10:00:00Z",
        modifyUser: "ingrid.halvorsen@contoso.example",
        legaltags: [],
        countries: [],
        viewers: [],
        owners: [],
        parents: [],
        bytes: 100,
      },
    });
    const view = expectView(RECORD_KEY, "board")(composeRecord(runtime));
    const text = JSON.stringify(view);
    expect(text).toContain(`2025-03-04T10:00:00Z by ${LOADER} (unresolved)`);
    expect(text).toContain("by Ingrid Halvorsen (ingrid.halvorsen@contoso.example)");
    expect(text).toContain("Label this id");
    const saved = await act(runtime, "annotate-identity", {
      id: LOADER,
      label: "Reference data loader",
      kind: "historical-actor",
      ...bindingOf(SAMPLE_PROFILE),
    });
    expect(saved).toMatchObject({ ok: true });
    expect(JSON.stringify(composeRecord(runtime))).toContain(
      "by Reference data loader (operator label)",
    );
  });
});
