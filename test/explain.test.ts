import { describe, expect, test } from "bun:test";
import { type CanvasBoardView, expectView } from "@keelson/shared";
import { explanations } from "../src/access/explain";
import { ACCESS_AREA, GROUP_KEYS } from "../src/access/read";
import { composeChange } from "../src/boards/change";
import { composeExplain } from "../src/boards/explain";
import { CHANGE_KEY, EXPLAIN_KEY } from "../src/keys";
import { explainModule } from "../src/modules/explain";
import { bindingOf } from "../src/plan/model";
import type { Runtime } from "../src/runtime";
import { SAMPLE_CLOSURES, sampleAccess } from "./fixtures/access";
import { SAMPLE_PROFILE } from "./fixtures/profile";
import { routeTransport, seededRuntime } from "./harness";

const NOW = new Date("2026-10-02T14:05:00Z");
const binding = bindingOf(SAMPLE_PROFILE);
const oid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const LENA = oid(5);
const BEN = oid(8);
const RACHEL = oid(11);
const DMITRI = oid(12);
const valid = expectView(EXPLAIN_KEY, "board");

// Answers the effective groups read from the sample memberships and closures.
function runtime(phase: "connected" | "signin" = "connected") {
  const read = sampleAccess();
  const { transport, sent } = routeTransport({
    "GET /api/entitlements/v2/members/": (req) => {
      const id = decodeURIComponent(req.url.split("/members/")[1]?.split("/groups")[0] ?? "");
      const held = GROUP_KEYS.filter((k) => read.groups[k].some((m) => m.id === id));
      const groups = [...new Set(held.flatMap((k) => SAMPLE_CLOSURES[k]))];
      return { status: 200, body: { groups: groups.map((email) => ({ email })) } };
    },
  });
  const rt = seededRuntime({ [ACCESS_AREA]: read }, { now: NOW, transport, phase });
  return { rt, sent };
}

async function ask(rt: Runtime, id: string) {
  return explainModule.actions?.["explain-access"]?.(rt, { ...binding, id });
}

function board(rt: Runtime): CanvasBoardView {
  return valid(composeExplain(rt)) as CanvasBoardView;
}

function section<K extends string>(view: CanvasBoardView, kind: K, title?: string) {
  return view.sections.find(
    (s) => s.kind === kind && (title === undefined || ("title" in s && s.title === title)),
  ) as Extract<CanvasBoardView["sections"][number], { kind: K }> | undefined;
}

describe("why 401/403", () => {
  test("Rachel Kim, missing users@: 3 passed, 1 failed, 3 skipped, and a users@ fix", async () => {
    const { rt, sent } = runtime();
    const res = await ask(rt, RACHEL);
    expect(res).toEqual({
      ok: true,
      data: {
        effect: "open-canvas",
        key: EXPLAIN_KEY,
        title: "Why 401/403 · Rachel Kim",
        placement: "side",
      },
    });
    expect(sent.map((r) => r.method)).toEqual(["GET"]);
    expect(decodeURIComponent(sent[0]?.url ?? "")).toContain(`/members/${RACHEL}/groups?type=NONE`);

    const view = board(rt);
    expect(view.title).toBe("Why 401/403 · Rachel Kim");
    expect(view.header?.status).toEqual({ label: "401: not a member of users@", tone: "error" });
    expect(view.header?.chip).toBe("checked 14:05Z · 7 checks");
    const seg = section(view, "segments");
    expect(seg?.title).toBe("rachel.kim@pacrim-energy.example");
    expect(seg?.items.map((i) => [i.label, i.n])).toEqual([
      ["passed", 3],
      ["failed", 1],
      ["skipped", 3],
    ]);
    const checks = section(view, "rows", "Checks, in the order the platform applies them");
    expect(checks?.items.map((r) => r.chip?.label)).toEqual([
      "pass",
      "pass",
      "pass",
      "fail",
      "skipped",
      "skipped",
      "skipped",
    ]);
    const cause = checks?.items[3];
    expect(cause?.text).toBe("Member of users@opendes.dataservices.energy");
    expect(cause?.trailing).toBe("this is the cause");
    expect(cause?.detail).toContain("returned 32 groups where 33 are expected for Editor");
    expect(cause?.detail).toContain("401 before roles are read");
    expect(checks?.items.slice(4).every((r) => r.trailing === "not reached")).toBe(true);

    const fix = section(view, "cards", "Fix")?.items[0];
    expect(fix?.title).toBe("Add Rachel Kim to users@");
    expect(fix?.pill?.label).toBe("1 change");
    expect(fix?.fields?.map((f) => f.value)).toEqual([
      "POST entitlements /groups/users@…/members {email: 0000…0011, role: MEMBER}",
      "GET entitlements /members/0000…0011/groups, expect 33",
    ]);
    // The access tab is a viewer: the fix is described, never planned from here.
    expect(fix?.actions?.map((a) => a.type)).toEqual(["select-person"]);
  });

  test("a pending invitation fails the sign-in check first", async () => {
    const { rt } = runtime();
    await ask(rt, BEN);
    const view = board(rt);
    expect(view.header?.status?.label).toBe("401: invitation not accepted, cannot sign in yet");
    const checks = section(view, "rows", "Checks, in the order the platform applies them");
    expect(checks?.items[0]).toMatchObject({
      chip: { label: "fail" },
      trailing: "this is the cause",
    });
    expect(checks?.items.slice(1).every((r) => r.chip?.label === "skipped")).toBe(true);
    expect(section(view, "cards", "Fix")).toBeUndefined();
    expect(JSON.stringify(section(view, "rows", "Fix"))).toContain("accepts the invitation");
  });

  test("a healthy person fails nothing, and the ACL checks need a record or a subproject", async () => {
    const { rt } = runtime();
    await ask(rt, LENA);
    const view = board(rt);
    expect(view.header?.status).toEqual({ label: "no cause in access", tone: "ok" });
    const checks = section(view, "rows", "Checks, in the order the platform applies them");
    expect(checks?.items.map((r) => r.chip?.label)).toEqual([
      "pass",
      "pass",
      "pass",
      "pass",
      "pass",
      "?",
      "?",
    ]);
    expect(checks?.items[4]?.trailing).toBe("users.datalake.editors · 33 of 33");
    expect(checks?.items[5]?.trailing).toBe("not checked: needs a record id");
    expect(checks?.items[6]?.trailing).toBe("not checked: needs a subproject");
    expect(section(view, "segments")?.items.find((i) => i.label === "failed")?.n).toBe(0);
    expect(section(view, "cards", "Fix")).toBeUndefined();
  });

  test("a duplicate entry is a warning, not the cause", async () => {
    const { rt } = runtime();
    await ask(rt, DMITRI);
    const view = board(rt);
    expect(view.header?.status?.tone).toBe("ok");
    const role = section(view, "rows", "Checks, in the order the platform applies them")?.items[4];
    expect(role).toMatchObject({
      chip: { label: "warn" },
      trailing: "duplicate entry, not the cause",
    });
    expect(section(view, "cards", "Fix")?.items[0]?.title).toBeDefined();
  });

  test("the note is plain text, copy only, and never mentions tokens or minutes", async () => {
    const { rt } = runtime();
    for (const id of [RACHEL, BEN, LENA, DMITRI]) {
      await ask(rt, id);
      const view = board(rt);
      const card = section(view, "cards", "Send to this person")?.items[0];
      expect(card?.fields?.[0]?.copyable).toBe(true);
      expect(card?.footnote).toBe("Copy only. The rib does not send mail.");
      expect(JSON.stringify(view)).not.toMatch(/token|minute/i);
    }
    expect(explanations(rt)[3]?.note).toContain("missing from the base users group");
  });

  test("recent answers keep the last few, newest first, without the one on screen", async () => {
    const { rt } = runtime();
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) await ask(rt, oid(n));
    await ask(rt, RACHEL);
    const recent = board(rt).sections.find(
      (s) => s.kind === "rows" && s.title?.startsWith("Recent answers"),
    );
    if (recent?.kind !== "rows") throw new Error("no recent answers");
    expect(recent.title).toBe("Recent answers · 5");
    expect(recent.items[0]?.text).toBe("Ben Whitaker: invitation not accepted, cannot sign in yet");
    expect(recent.items[0]?.chip?.label).toBe("401");
    expect(recent.items[0]?.trailing).toBe("14:05Z");
    expect(recent.items[0]?.action).toEqual({
      type: "explain-access",
      payload: { ...binding, id: BEN },
    });
    expect(recent.items.some((r) => r.text.startsWith("Rachel Kim"))).toBe(false);
  });

  test("while sign-in is needed it answers from the sweep", async () => {
    const { rt, sent } = runtime("signin");
    const tab = (
      composeChange(rt).sections[0] as { items: { type: string; disabled?: boolean }[] }
    ).items.find((i) => i.type === "explain-access");
    expect(tab?.disabled).toBeUndefined();
    await ask(rt, RACHEL);
    expect(sent).toHaveLength(0);
    const view = board(rt);
    expect(view.header?.status?.label).toBe("401: not a member of users@");
    expect(view.header?.chip).toBe("cached from 14:05Z · 7 checks");
    expect(JSON.stringify(view)).toContain("The last sweep gives 32 effective groups");
  });

  test("a board drawn for another instance or an unknown person is refused", async () => {
    const { rt } = runtime();
    expect(
      await explainModule.actions?.["explain-access"]?.(rt, { ...binding, host: "x", id: RACHEL }),
    ).toMatchObject({ ok: false });
    expect(await ask(rt, "nobody")).toMatchObject({ ok: false });
    expect(explanations(rt)).toHaveLength(0);
  });

  test("every frame passes the board validator, including before any answer", async () => {
    const { rt } = runtime();
    expect(JSON.stringify(board(rt))).toContain("No answer yet");
    for (const id of [RACHEL, BEN, LENA, DMITRI]) {
      await ask(rt, id);
      board(rt);
    }
    expectView(CHANGE_KEY, "board")(composeChange(rt));
    expect(composeExplain(seededRuntime({}, { phase: "firstrun" })).sections).toEqual([]);
  });
});
