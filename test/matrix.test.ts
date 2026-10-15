import { describe, expect, test } from "bun:test";
import { expectView } from "@keelson/shared";
import { ACCESS_AREA } from "../src/access/read";
import { seismicTab } from "../src/boards/console-seismic";
import { briefInputs } from "../src/brief/inputs";
import { seismicMatrix } from "../src/brief/seismic";
import { INSPECT_KEY } from "../src/keys";
import { composeInspect, consoleModule } from "../src/modules/console";
import { SEISMIC_AREA } from "../src/seismic/read";
import { INSPECT_ACTION } from "../src/surfaces";
import { sampleAccess } from "./fixtures/access";
import { groupEmail, sampleSeismic } from "./fixtures/seismic";
import { seededRuntime } from "./harness";

const oid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const INGRID = oid(1);
const MARCUS = oid(4);
const RACHEL = oid(11);
const KARI = "00000000-0000-4000-8000-0000000000ff";

function seismic() {
  const read = sampleSeismic();
  read.groups[groupEmail("delta", "viewer")]?.members?.push(KARI);
  read.groups[groupEmail("alpha", "viewer")]?.members?.push(RACHEL);
  read.directory = {
    [KARI]: { kind: "user", name: "Kari Solberg", mail: "kari@halden-geo.example" },
  };
  const echo = groupEmail("echo", "viewer");
  read.groups[echo] = { error: "Forbidden", refused: true };
  return read;
}

function rt() {
  return seededRuntime({ [ACCESS_AREA]: sampleAccess(), [SEISMIC_AREA]: seismic() });
}

function marks(m: NonNullable<ReturnType<typeof seismicMatrix>>, id: string) {
  const row = m.rows.find((r) => r.id === id);
  return Object.fromEntries((row?.cells ?? []).map((c) => [c.column, c.mark]));
}

describe("seismic matrix", () => {
  test("cells separate explicit grants, default reach, unusable grants and unread groups", () => {
    const m = seismicMatrix(briefInputs(rt()));
    if (!m) throw new Error("matrix expected");
    expect(m.shared).toEqual(["volve", "drogon"]);
    expect(m.columns.map((c) => c.name)).toContain("echo");
    expect(m.columns.find((c) => c.name === "echo")?.unread).toBe(true);
    expect(marks(m, MARCUS)).toMatchObject({
      shared: "D",
      alpha: "V",
      delta: "V",
      bravo: "·",
      echo: "?",
    });
    expect(marks(m, INGRID)).toMatchObject({ alpha: "A", echo: "A" });
    expect(marks(m, KARI)).toMatchObject({ shared: "·", delta: "V!" });
    expect(marks(m, RACHEL)).toMatchObject({ shared: "D*", alpha: "V!" });
    expect(m.rows.find((r) => r.id === KARI)?.sub).toBe("no instance access");
    expect(m.headline).toStartWith("At least ");
    expect(m.signals.map((s) => s.text)[1]).toMatch(/^Members \d+ of \d+ groups read$/);
  });

  test("the tab draws a matrix of bare cells with one pane template per subproject and mark", () => {
    const m = seismicMatrix(briefInputs(rt()));
    if (!m) throw new Error("matrix expected");
    const html = seismicTab(m);
    expect(html).toContain(`data-rid="${MARCUS}"`);
    expect(html).toContain('data-col="alpha"');
    expect(html).toContain('data-inspect="sub:echo"');
    expect(html).toContain("echo ?");
    expect(html).toContain('data-tpl="alpha|V"');
    expect(html).toContain('data-tpl="bravo|·"');
    expect(html).toContain('data-tpl="echo|?"');
    expect(m.templates.filter((t) => t.key === "alpha|V")).toHaveLength(1);
    expect(m.templates.find((t) => t.key === "alpha|V")?.title).toBe("{who} → alpha");
    expect(html).toContain("data-cell-live");
    expect(html).not.toContain("data-cell=");
  });

  test("before the store is read the tab says so instead of drawing an empty matrix", () => {
    const inputs = briefInputs(seededRuntime({ [ACCESS_AREA]: sampleAccess() }));
    expect(seismicMatrix(inputs)).toBeUndefined();
    expect(seismicTab(undefined)).toContain("Seismic members are not read yet.");
  });
});

describe("cell and subproject inspectors", () => {
  const act = (runtime: ReturnType<typeof rt>, payload: unknown) =>
    consoleModule.actions?.[INSPECT_ACTION]?.(runtime, payload);

  test("a held grant offers revoke; a grant to someone without instance access is disabled", async () => {
    const runtime = rt();
    expect(await act(runtime, { id: `cell:${MARCUS}:alpha` })).toMatchObject({
      ok: true,
      data: { key: INSPECT_KEY, title: "Marcus Oyelaran → alpha" },
    });
    const marcus = JSON.stringify(expectView(INSPECT_KEY, "board")(composeInspect(runtime)));
    expect(marcus).toContain("Preview revoke · viewer on alpha");
    expect(marcus).toContain("Preview grant · admin on alpha");
    expect(marcus).toContain('"label":"configured"');

    await act(runtime, { id: `cell:${KARI}:alpha` });
    const kari = expectView(INSPECT_KEY, "board")(composeInspect(runtime));
    if (kari.view !== "board") throw new Error("board expected");
    const verbs = kari.sections.flatMap((x) => (x.kind === "actions" ? x.items : []));
    const grant = verbs.find((v) => v.label === "Preview grant · viewer on alpha");
    expect(grant).toMatchObject({ disabled: true });
    expect(grant?.reason).toContain("holds no usable instance access");
  });

  test("an unread cell offers a re-read; the shared column explains default reach", async () => {
    const runtime = rt();
    await act(runtime, { id: `cell:${MARCUS}:echo` });
    expect(JSON.stringify(composeInspect(runtime))).toContain("Re-read seismic members");
    await act(runtime, { id: `cell:${MARCUS}:shared` });
    const shared = JSON.stringify(composeInspect(runtime));
    expect(shared).toContain("the rib does not plan it");
  });

  test("a column header opens the subproject with its members and the flow", async () => {
    const runtime = rt();
    expect(await act(runtime, { id: "sub:alpha" })).toMatchObject({
      ok: true,
      data: { title: "Subproject · alpha" },
    });
    const view = expectView(INSPECT_KEY, "board")(composeInspect(runtime));
    const text = JSON.stringify(view);
    expect(text).toContain("sd://opendes/alpha");
    expect(text).toContain('"kind":"flow"');
    expect(await act(runtime, { id: "sub:nowhere" })).toMatchObject({ ok: false });
  });
});
