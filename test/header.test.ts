import { describe, expect, test } from "bun:test";
import { type CanvasBoardView, expectView } from "@keelson/shared";
import { ACCESS_AREA } from "../src/access/read";
import { HEADER_KEY } from "../src/keys";
import { headerModule } from "../src/modules/header";
import { activeSection, SECTION_ACTION, setSection } from "../src/section";
import { sampleAccess } from "./fixtures/access";
import { seededRuntime } from "./harness";

const board = expectView(HEADER_KEY, "board");
type Section = CanvasBoardView["sections"][number];

function header(rt: ReturnType<typeof seededRuntime>): CanvasBoardView {
  const compose = headerModule.composers?.[HEADER_KEY];
  if (!compose) throw new Error("no header composer");
  return board(compose(rt)) as CanvasBoardView;
}

function switcher(view: CanvasBoardView): Extract<Section, { kind: "actions" }> {
  const first = view.sections[0];
  if (first?.kind !== "actions") throw new Error("switcher expected first");
  return first;
}

describe("ADME header", () => {
  test("the switcher lists the three sections with Access selected and its follow-up count", () => {
    const rt = seededRuntime({ [ACCESS_AREA]: sampleAccess() });
    const items = switcher(header(rt)).items;
    expect(items.map((i) => [i.label, i.selected])).toEqual([
      ["Access · 5", true],
      ["Data", false],
      ["Seismic", false],
    ]);
    expect(items.every((i) => i.type === SECTION_ACTION)).toBe(true);
  });

  test("the connection line names the instance, who is signed in and their role", () => {
    const rt = seededRuntime({ [ACCESS_AREA]: sampleAccess() });
    expect(header(rt).sections[1]).toMatchObject({
      kind: "rows",
      items: [
        { text: "Connected to contoso-adme · opendes as ingrid.halvorsen@contoso.example · Admin" },
      ],
    });
  });

  test("switching section swaps the pulse under the switcher", async () => {
    const recomposed: string[][] = [];
    const rt = seededRuntime(
      { [ACCESS_AREA]: sampleAccess() },
      { recompose: (keys) => recomposed.push([...keys]) },
    );
    const act = headerModule.actions?.[SECTION_ACTION];
    expect(await act?.(rt, { section: "data" })).toMatchObject({ ok: true });
    expect(activeSection(rt)).toBe("data");
    expect(recomposed).toHaveLength(1);
    const view = header(rt);
    expect(switcher(view).items.find((i) => i.selected)?.label).toBe("Data");
    expect(view.header?.chip).toContain("opendes ·");
    expect(JSON.stringify(view)).toContain("ACL groups");
  });

  test("an unknown section fails closed", async () => {
    const rt = seededRuntime({});
    const res = await headerModule.actions?.[SECTION_ACTION]?.(rt, { section: "admin" });
    expect(res).toMatchObject({ ok: false });
    expect(activeSection(rt)).toBe("access");
  });

  test("before connecting every section shows the connect journey", () => {
    const rt = seededRuntime({}, { phase: "firstrun" });
    setSection(rt, "seismic");
    const view = header(rt);
    expect(JSON.stringify(view)).toContain("Step 2: pick the instance");
    expect(switcher(view).items.map((i) => i.label)).toEqual(["Access", "Data", "Seismic"]);
    expect(view.sections.some((s) => s.kind === "rows" && s.items[0]?.icon === "⌁")).toBe(false);
  });

  test("a lapsed sign-in shows in the connection line and the sign-in card", () => {
    const rt = seededRuntime({ [ACCESS_AREA]: sampleAccess() }, { phase: "signin" });
    const text = JSON.stringify(header(rt));
    expect(text).toContain("Sign-in needed for contoso-adme · opendes");
    expect(text).toContain("az login");
  });
});
