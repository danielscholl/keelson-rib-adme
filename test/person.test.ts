import { describe, expect, test } from "bun:test";
import { expectView } from "@keelson/shared";
import { ACCESS_AREA, type AccessRead, GROUP_KEYS } from "../src/access/read";
import { composeAttention, SELECT_PERSON_ACTION } from "../src/boards/access";
import { SIGNIN_REASON } from "../src/boards/connection";
import { composePeople, PEOPLE_VIEW_ACTION } from "../src/boards/people";
import {
  ACCEPT_EXTRAS_ACTION,
  composePerson,
  REFRESH_PERSON_ACTION,
  shortGroup,
} from "../src/boards/person";
import { ATTENTION_KEY, PEOPLE_KEY, PERSON_KEY, PRINCIPALS_KEY } from "../src/keys";
import { accessModule } from "../src/modules/access";
import { Store } from "../src/store";
import { Tracker, trackerFile } from "../src/tracker";
import { SAMPLE_APPS, SAMPLE_CLOSURES, sampleAccess } from "./fixtures/access";
import { SAMPLE_PROFILE } from "./fixtures/profile";
import { routeTransport, seededRuntime } from "./harness";

const D = "@opendes.dataservices.energy";
const GOLF = `data.sdms.opendes.golf.0f1e2d3c4b5a.viewer${D}`;
const ECHO = `data.sdms.opendes.echo.6a7b8c9d0e1f.admin${D}`;
const person = expectView(PERSON_KEY, "board");

function idOf(read: AccessRead, name: string): string {
  const id = Object.entries(read.directory).find(([, e]) => e.name === name)?.[0];
  if (!id) throw new Error(`${name} is not in the cast`);
  return id;
}

// Entitlements answers the per-person read with the closures of the groups held,
// plus any one-off groups granted directly.
function setup(opts: { extra?: Record<string, string[]>; status?: number; store?: Store } = {}) {
  const read = sampleAccess();
  const extra = opts.extra ?? {};
  const recomposed: string[][] = [];
  const routes = routeTransport({
    "GET /api/entitlements/v2/members/": (req) => {
      if (opts.status) return { status: opts.status, body: { message: "Forbidden" } };
      const id = decodeURIComponent(req.url.split("/members/")[1]?.split("/groups")[0] ?? "");
      const held = GROUP_KEYS.filter((k) => read.groups[k].some((m) => m.id === id));
      const emails = [
        ...new Set([...held.flatMap((k) => SAMPLE_CLOSURES[k]), ...(extra[id] ?? [])]),
      ];
      return {
        status: 200,
        body: {
          desId: id,
          memberEmail: id,
          groups: emails.map((email) => ({ name: email.split("@")[0], email, description: "" })),
        },
      };
    },
  });
  const rt = seededRuntime(
    { [ACCESS_AREA]: read },
    {
      transport: routes.transport,
      recompose: (keys) => recomposed.push([...keys]),
      ...(opts.store ? { store: opts.store } : {}),
    },
  );
  const act = (type: string, payload: unknown) => accessModule.actions?.[type]?.(rt, payload);
  return { rt, read, sent: routes.sent, recomposed, act };
}

function board(view: ReturnType<typeof composePerson>) {
  const parsed = person(view);
  if (parsed.view !== "board") throw new Error("board expected");
  const columns = parsed.sections[0];
  if (columns?.kind !== "columns") throw new Error("columns expected");
  const [left, right] = columns.columns.map((c) => c.sections);
  const find = (sections: typeof left, title: string) =>
    sections?.find((s) => s.title?.startsWith(title));
  return { parsed, left: left ?? [], right: right ?? [], find };
}

describe("person inspector", () => {
  test("Rachel Kim draws the spec's checks from a routed per-person read", async () => {
    const { rt, read, sent, act } = setup();
    const rachel = idOf(read, "Rachel Kim");
    const res = await act(SELECT_PERSON_ACTION, { id: rachel.toUpperCase() });
    expect(res).toEqual({
      ok: true,
      data: {
        effect: "open-canvas",
        key: PERSON_KEY,
        title: "Person · Rachel Kim",
        placement: "side",
      },
    });
    expect(sent.map((r) => r.url)).toEqual([
      `https://${SAMPLE_PROFILE.host}/api/entitlements/v2/members/${rachel}/groups?type=NONE`,
    ]);

    const { parsed, left, right, find } = board(composePerson(rt));
    expect(parsed.header?.status).toEqual({ label: "401 on every call", tone: "error" });
    expect(parsed.header?.chip).toBe("rachel.kim@pacrim-energy.example · measured 14:05Z");

    const checks = find(right, "Access checks");
    if (checks?.kind !== "rows") throw new Error("checks expected");
    expect(checks.items.map((r) => [r.chip?.label, r.text, r.trailing])).toEqual([
      ["pass", "Entra account exists", undefined],
      ["pass", "Invitation accepted", "2026-09-29"],
      ["pass", "In roster group 9d3a…5e42", undefined],
      ["fail", "Member of users@opendes.dataservices.energy", "not a member"],
      ["pass", "Member of users.datalake.editors", "MEMBER, by object id"],
      ["warn", "Effective groups", "32 of 33 expected for Editor"],
    ]);

    const odd = find(right, "Beyond or short of the role");
    if (odd?.kind !== "rows") throw new Error("rows expected");
    expect(odd.items).toEqual([
      {
        chip: { label: "gap", tone: "error" },
        text: "users",
        trailing: "expected for the role, not held",
      },
    ]);
    const grid = find(right, "Effective groups");
    if (grid?.kind !== "grid") throw new Error("grid expected");
    expect(grid.title).toBe("Effective groups · 32");
    expect(grid.cells[0]).toEqual({ label: "editors" });
    expect(grid.cells.at(-1)).toEqual({ label: "19 more" });
    expect(grid.cells).toHaveLength(14);

    const identity = find(left, "Identity");
    if (identity?.kind !== "cards") throw new Error("identity expected");
    const card = identity.items[0];
    expect(card).toMatchObject({ edge: "error", pill: { label: "401", tone: "error" } });
    expect(card?.fields).toEqual([
      { label: "Object id", value: rachel, copyable: true },
      { label: "Mail", value: "rachel.kim@pacrim-energy.example", copyable: true },
      { label: "Other mails", value: "rkim@pacrim-energy.example", copyable: true },
      { label: "Kind", value: "guest" },
      { label: "Entra state", value: "Accepted 2026-09-29", tone: "ok" },
      { label: "Created", value: "2026-09-28" },
      { label: "Roster group", value: "in 9d3a…5e42" },
    ]);
    expect(JSON.stringify(find(left, "Same home identity"))).toContain(
      "rkim@pacrim-energy.example resolves to this account",
    );
    const planned = left.find((s) => s.kind === "actions");
    if (planned?.kind !== "actions") throw new Error("actions expected");
    // The inspector reads only: no verb plans a change.
    expect(planned.items.map((a) => a.type)).toEqual(["explain-access"]);
    expect(JSON.stringify(find(right, "History"))).toContain("Accepted the invitation");
  });

  test("the cohort and pass end come from the tracker", async () => {
    const { rt, read, act } = setup();
    rt.tracker.importCsv("rachel.kim@pacrim-energy.example,Pilot,2026-10-28", rt.now());
    await act(SELECT_PERSON_ACTION, { id: idOf(read, "Rachel Kim") });
    const text = JSON.stringify(person(composePerson(rt)));
    expect(text).toContain('{"label":"Cohort","value":"Pilot"}');
    expect(text).toContain('{"label":"Pass ends","value":"26 d · 2026-10-28"}');
  });

  test("selecting recomposes the inspector first and marks the person in the lists", async () => {
    const { rt, read, recomposed, act } = setup();
    const rachel = idOf(read, "Rachel Kim");
    await act(SELECT_PERSON_ACTION, { id: rachel });
    expect(recomposed).toEqual([[PERSON_KEY], [PEOPLE_KEY, ATTENTION_KEY, PRINCIPALS_KEY]]);
    const roster = expectView(PEOPLE_KEY, "board")(composePeople(rt));
    const rows =
      roster.view === "board"
        ? roster.sections.flatMap((s) => (s.kind === "rows" ? s.items : []))
        : [];
    expect(rows.find((r) => r.text === "Rachel Kim")).toMatchObject({
      action: { type: SELECT_PERSON_ACTION, payload: { id: rachel } },
      selected: true,
    });
    expect(rows.find((r) => r.text === "Ben Whitaker")?.selected).toBeUndefined();
    const attention = JSON.stringify(expectView(ATTENTION_KEY, "board")(composeAttention(rt)));
    expect(attention).toContain(
      `"action":{"type":"select-person","payload":{"id":"${rachel}"}},"selected":true`,
    );
  });

  test("a missing or unknown id is refused and opens nothing", async () => {
    const { rt, sent, act } = setup();
    expect(await act(SELECT_PERSON_ACTION, {})).toEqual({
      ok: false,
      error: "Pick a person to open.",
    });
    expect(await act(SELECT_PERSON_ACTION, { id: "ffffffff-0000-4000-8000-000000000000" })).toEqual(
      {
        ok: false,
        error: "That person is not in the last read of entitlements. Refresh and pick again.",
      },
    );
    expect(sent).toEqual([]);
    expect(JSON.stringify(person(composePerson(rt)))).toContain(
      "Pick a person on the ADME Access tab.",
    );
    expect(
      await act(REFRESH_PERSON_ACTION, { id: "ffffffff-0000-4000-8000-000000000000" }),
    ).toMatchObject({
      ok: false,
    });
  });

  test("an application opens with its app id and no invitation check", async () => {
    const { rt, act } = setup();
    const app = SAMPLE_APPS[2];
    const res = await act(SELECT_PERSON_ACTION, { id: app?.id });
    expect(res).toMatchObject({ data: { title: "Application · contoso-adme-tier-editor" } });
    const { parsed, right, find } = board(composePerson(rt));
    expect(parsed.header?.status).toEqual({ label: "ok", tone: "ok" });
    const checks = find(right, "Access checks");
    expect(JSON.stringify(checks)).not.toContain("Invitation");
    expect(JSON.stringify(checks)).toContain("MEMBER, by app id");
  });

  test("a baseline turns extras into baseline and survives a tracker reload", async () => {
    const store = new Store(undefined);
    const read = sampleAccess();
    const lena = idOf(read, "Lena Fischer");
    const { rt, act } = setup({ extra: { [lena]: [GOLF] }, store });
    await act(SELECT_PERSON_ACTION, { id: lena });

    let view = board(composePerson(rt));
    expect(view.parsed.header?.status).toEqual({ label: "1 extra group", tone: "warn" });
    const odd = view.find(view.right, "Beyond or short of the role");
    if (odd?.kind !== "rows") throw new Error("rows expected");
    expect(odd.items[0]).toEqual({
      chip: { label: "extra", tone: "info" },
      text: "sdms.golf.viewer",
      trailing: "held beyond the role",
    });
    expect(JSON.stringify(view.right)).toContain("34 of 33 expected for Editor · 1 extra");

    expect(await act(ACCEPT_EXTRAS_ACTION, { id: lena })).toEqual({
      ok: true,
      data: { message: "Lena Fischer: 1 group in the baseline" },
    });
    rt.tracker = new Tracker(store, trackerFile(SAMPLE_PROFILE));
    expect(rt.tracker.baselineOf(lena)).toEqual([GOLF]);

    view = board(composePerson(rt));
    expect(view.parsed.header?.status).toEqual({ label: "ok", tone: "ok" });
    expect(view.find(view.right, "Beyond or short of the role")).toBeUndefined();
    const grid = view.find(view.right, "Effective groups");
    if (grid?.kind !== "grid") throw new Error("grid expected");
    expect(grid.cells[0]).toEqual({
      label: "sdms.golf.viewer",
      badge: { text: "baseline", tone: "neutral" },
    });
    expect(JSON.stringify(view.right)).toContain("34 of 33 expected for Editor · 1 baseline");
    expect(JSON.stringify(view.find(view.right, "History"))).toContain(
      "Accepted 1 extra group as baseline",
    );
    expect(JSON.stringify(view.right)).not.toContain(ACCEPT_EXTRAS_ACTION);
    expect(await act(ACCEPT_EXTRAS_ACTION, { id: lena })).toMatchObject({ ok: false });
  });

  test("a new extra counts again while the baseline stays accepted", async () => {
    const read = sampleAccess();
    const lena = idOf(read, "Lena Fischer");
    const extra = { [lena]: [GOLF] };
    const { rt, act } = setup({ extra });
    await act(SELECT_PERSON_ACTION, { id: lena });
    await act(ACCEPT_EXTRAS_ACTION, { id: lena });
    extra[lena] = [GOLF, ECHO];
    expect(await act(REFRESH_PERSON_ACTION, { id: lena })).toEqual({ ok: true });
    const view = board(composePerson(rt));
    expect(view.parsed.header?.status).toEqual({ label: "1 extra group", tone: "warn" });
    const odd = view.find(view.right, "Beyond or short of the role");
    expect(JSON.stringify(odd)).toContain('"text":"sdms.echo.admin"');
    const grid = view.find(view.right, "Effective groups");
    if (grid?.kind !== "grid") throw new Error("grid expected");
    expect(grid.cells[0]).toEqual({
      label: "sdms.golf.viewer",
      badge: { text: "baseline", tone: "neutral" },
    });
  });

  test("a tracker file written before baselines still parses", () => {
    const store = new Store(undefined);
    const name = trackerFile(SAMPLE_PROFILE);
    store.write(name, {
      cohorts: [{ name: "Pilot", created: "2026-09-28", passEnds: "2026-10-28" }],
      members: { "lena.fischer@rheinseis.example": "Pilot" },
      events: [{ at: "2026-09-28T09:00:00Z", text: "Imported 1 person into Pilot" }],
    });
    const tracker = new Tracker(store, name);
    expect(tracker.unreadable).toBe(false);
    expect(tracker.cohorts).toHaveLength(1);
    expect(tracker.baselineOf("anyone")).toEqual([]);
    expect(tracker.eventsFor("anyone")).toEqual([]);
  });

  test("the roles matrix offers an Open person form listing the people shown", async () => {
    const { rt, read, act } = setup();
    await act(PEOPLE_VIEW_ACTION, { view: "matrix" });
    const view = expectView(PEOPLE_KEY, "board")(composePeople(rt));
    const form = view.view === "board" ? view.sections.at(-1) : undefined;
    if (form?.kind !== "actions") throw new Error("form expected");
    const open = form.items[0];
    expect(open).toMatchObject({
      type: SELECT_PERSON_ACTION,
      label: "Open person",
      submitLabel: "Open",
    });
    const options = open?.fields?.[0]?.options ?? [];
    expect(options).toHaveLength(32);
    expect(options).toContainEqual({
      value: idOf(read, "Rachel Kim"),
      label: "Rachel Kim",
      hint: "rachel.kim@pacrim-energy.example",
    });
  });

  test("sign-in needed keeps the last read, says cached, and pauses the refresh", async () => {
    const { rt, read, sent, act } = setup();
    const rachel = idOf(read, "Rachel Kim");
    await act(SELECT_PERSON_ACTION, { id: rachel });
    rt.status = { ...rt.status, phase: "signin", error: "expired" };
    expect(await act(SELECT_PERSON_ACTION, { id: rachel })).toMatchObject({ ok: true });
    expect(sent).toHaveLength(1);
    const { parsed, right, find } = board(composePerson(rt));
    expect(parsed.header?.status).toEqual({ label: "sign-in needed", tone: "error" });
    expect(parsed.header?.chip).toBe("rachel.kim@pacrim-energy.example · cached from 14:05Z");
    expect(find(right, "Effective groups")?.title).toBe("Effective groups · 32");
    expect(JSON.stringify(right)).toContain(
      `{"type":"refresh-person","label":"Re-read groups","payload":{"id":"${rachel}"},"disabled":true,"reason":"${SIGNIN_REASON}"}`,
    );
    expect(await act(REFRESH_PERSON_ACTION, { id: rachel })).toEqual({
      ok: false,
      error: SIGNIN_REASON,
    });
  });

  test("a refused per-person read falls back to the role groups and says so", async () => {
    const { rt, read, act } = setup({ status: 403 });
    await act(SELECT_PERSON_ACTION, { id: idOf(read, "Rachel Kim") });
    const { right, find } = board(composePerson(rt));
    expect(JSON.stringify(right)).toContain(
      "The per-person read failed at 14:05Z: effective groups",
    );
    expect(find(right, "Effective groups")?.title).toBe(
      "Effective groups · 32 · computed from role groups",
    );
  });

  test("not connected draws no sections", () => {
    const first = seededRuntime({}, { phase: "firstrun" });
    expect(person(composePerson(first))).toEqual({ view: "board", sections: [] });
  });

  test("group names shorten to what the grid can hold", () => {
    expect(shortGroup(`users${D}`)).toBe("users");
    expect(shortGroup(`users.datalake.editors${D}`)).toBe("editors");
    expect(shortGroup(`service.storage.viewer${D}`)).toBe("storage.viewer");
    expect(shortGroup(GOLF)).toBe("sdms.golf.viewer");
  });
});
