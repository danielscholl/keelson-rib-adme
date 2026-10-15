import { afterEach, describe, expect, test } from "bun:test";
import { expectView } from "@keelson/shared";
import { ACCESS_AREA } from "../src/access/read";
import { CONSOLE_MAX_BYTES, consoleHtml, expectHtml } from "../src/boards/console";
import { ANNOTATE_ACTION, REREAD_ACTION } from "../src/boards/inspect";
import { buildBrief } from "../src/brief/index";
import { briefInputs } from "../src/brief/inputs";
import { peopleRows } from "../src/brief/people";
import { LEGAL_AREA } from "../src/data/areas";
import rib from "../src/index";
import { CONSOLE_KEY, INSPECT_KEY, PERSON_KEY } from "../src/keys";
import { composeConsole, composeInspect, consoleModule } from "../src/modules/console";
import { bindingOf } from "../src/plan/model";
import { SEISMIC_AREA } from "../src/seismic/read";
import { INSPECT_ACTION } from "../src/surfaces";
import { sampleAccess } from "./fixtures/access";
import { SAMPLE_LEGAL } from "./fixtures/data";
import { SAMPLE_PROFILE } from "./fixtures/profile";
import { sampleSeismic } from "./fixtures/seismic";
import { fakeContext, seededRuntime } from "./harness";

const RACHEL = "00000000-0000-4000-8000-000000000011";
const ORPHAN = "ffffffff-0000-4000-8000-000000000001";

function withOrphan() {
  const read = sampleAccess();
  read.groups.users.push({ id: ORPHAN, owner: false });
  read.groups.ops.push({ id: ORPHAN, owner: false });
  return read;
}

function rt() {
  return seededRuntime({
    [ACCESS_AREA]: withOrphan(),
    [SEISMIC_AREA]: sampleSeismic(),
    [LEGAL_AREA]: SAMPLE_LEGAL,
  });
}

function act(runtime: ReturnType<typeof rt>, type: string, payload?: unknown) {
  const handler = consoleModule.actions?.[type];
  if (!handler) throw new Error(`no handler for ${type}`);
  return handler(runtime, payload);
}

const bound = () => bindingOf(SAMPLE_PROFILE);

describe("console frame", () => {
  afterEach(async () => {
    await rib.dispose?.();
  });

  test("the frame may only inspect; every other verb from it is refused", async () => {
    const { ctx } = fakeContext();
    rib.registerTools?.(ctx);
    const res = await rib.onAction?.(
      { type: "preview-seismic-revoke", payload: {}, origin: "canvas-html" },
      ctx,
    );
    expect(res).toEqual({
      ok: false,
      error: "the console only opens the inspector; act from its buttons",
    });
    const inspect = await rib.onAction?.(
      { type: INSPECT_ACTION, payload: { id: "connection" }, origin: "canvas-html" },
      ctx,
    );
    expect(inspect).toMatchObject({ ok: true, data: { effect: "open-canvas" } });
  });

  test("the console registers as html and passes its validator", async () => {
    const { ctx, snapshots } = fakeContext();
    rib.registerTools?.(ctx);
    const frame = await snapshots.recompose(CONSOLE_KEY);
    expect(typeof frame.data).toBe("string");
    expect(String(frame.data)).toContain("Connect to an ADME instance.");
    expect(rib.views?.find((v) => v.key === CONSOLE_KEY)?.canvasKind).toBe("html");
  });

  test("the measured console leads with the headline, escapes text and stays under its limit", () => {
    const runtime = rt();
    const key = `object:${SAMPLE_PROFILE.tenantId}:${ORPHAN}`;
    runtime.annotations.set(
      key,
      { label: "<b>Loader</b>", kind: "historical-actor" },
      runtime.now(),
    );
    const html = composeConsole(runtime);
    expect(html).toContain("<h2>Rachel Kim cannot use the instance as configured.</h2>");
    expect(html).toContain("&lt;b&gt;Loader&lt;/b&gt; still holds Ops");
    expect(html).not.toContain("<b>Loader</b>");
    expect(html).toContain('data-view="people"');
    // Rows set their own display, so search and toggles need hidden to win.
    expect(html).toContain("[hidden] { display: none !important; }");
    expect(html).toContain(`data-inspect="who:${RACHEL}"`);
    expect(expectHtml(html)).toBe(html);
    expect(new TextEncoder().encode(html).byteLength).toBeLessThan(CONSOLE_MAX_BYTES);
  });

  test("before the instance is read the console has no tabs", () => {
    const inputs = briefInputs(seededRuntime({}, { phase: "firstrun" }));
    const html = consoleHtml({ brief: buildBrief(inputs), people: peopleRows(inputs) });
    expect(html).not.toContain("data-view=");
    expect(() => expectHtml("")).toThrow();
  });
});

describe("inspector", () => {
  test("an item opens in the inspector with its evidence, next step and verbs", async () => {
    const runtime = rt();
    const res = await act(runtime, INSPECT_ACTION, { id: `item:blocked:${RACHEL}` });
    expect(res).toEqual({
      ok: true,
      data: {
        effect: "open-canvas",
        key: INSPECT_KEY,
        title: "Rachel Kim cannot use the instance",
        placement: "side",
      },
    });
    const view = expectView(INSPECT_KEY, "board")(composeInspect(runtime));
    const text = JSON.stringify(view);
    expect(text).toContain('"label":"BLOCKED"');
    expect(text).toContain("users@ membership");
    expect(text).toContain("Why 401/403");
    expect(text).toContain(`"id":"who:${RACHEL}"`);
  });

  test("a person opens the person inspector; an id outside the people list opens an identity", async () => {
    const runtime = rt();
    const person = await act(runtime, INSPECT_ACTION, { id: `who:${RACHEL}` });
    expect(person).toMatchObject({
      ok: true,
      data: { key: PERSON_KEY, title: "Person · Rachel Kim" },
    });
    const orphan = await act(runtime, INSPECT_ACTION, { id: `who:${ORPHAN}` });
    expect(orphan).toMatchObject({ ok: true, data: { key: INSPECT_KEY } });
    const text = JSON.stringify(expectView(INSPECT_KEY, "board")(composeInspect(runtime)));
    expect(text).toContain("What can this id reach?");
    expect(text).toContain("Label this id");
  });

  test("an item that cleared or an unknown id is refused with a reason", async () => {
    const runtime = rt();
    expect(await act(runtime, INSPECT_ACTION, { id: "item:blocked:nobody" })).toMatchObject({
      ok: false,
    });
    expect(await act(runtime, INSPECT_ACTION, {})).toMatchObject({ ok: false });
  });

  test("a read and a tag open with their own inspectors", async () => {
    const runtime = rt();
    expect(await act(runtime, INSPECT_ACTION, { id: "read:seismic" })).toMatchObject({
      ok: true,
      data: { title: "Seismic members" },
    });
    expect(JSON.stringify(composeInspect(runtime))).toContain(REREAD_ACTION);
    expect(await act(runtime, INSPECT_ACTION, { id: "tag:opendes-pilot-trial" })).toMatchObject({
      ok: true,
      data: { title: "Legal tag · opendes-pilot-trial" },
    });
    const tag = JSON.stringify(composeInspect(runtime));
    expect(tag).toContain("foxtrot, golf, golf2, golf3");
    expect(tag).toContain("The rib does not edit legal tags.");
  });
});

describe("annotations from the inspector", () => {
  test("labelling an id renames it everywhere and changes its item", async () => {
    const runtime = rt();
    expect(buildBrief(briefInputs(runtime)).items.map((i) => i.title)).toContain(
      "An id holding Ops has no name",
    );
    const res = await act(runtime, ANNOTATE_ACTION, {
      id: ORPHAN,
      label: "Reference data loader",
      kind: "historical-actor",
      ...bound(),
    });
    expect(res).toEqual({ ok: true, data: { message: "Saved to the annotations file" } });
    const titles = buildBrief(briefInputs(runtime)).items.map((i) => i.title);
    expect(titles).toContain("Reference data loader still holds Ops");
    expect(composeConsole(runtime)).toContain("Reference data loader");
  });

  test("a form drawn for another instance, or an id nobody lists, is refused", async () => {
    const runtime = rt();
    expect(
      await act(runtime, ANNOTATE_ACTION, {
        id: ORPHAN,
        label: "x",
        ...bound(),
        host: "other.example",
      }),
    ).toMatchObject({
      ok: false,
      error: "This form was drawn for another instance. Refresh and try again.",
    });
    expect(
      await act(runtime, ANNOTATE_ACTION, {
        id: "eeeeeeee-0000-4000-8000-000000000000",
        label: "x",
        ...bound(),
      }),
    ).toMatchObject({ ok: false, error: "That identity is not in the last read." });
  });
});
