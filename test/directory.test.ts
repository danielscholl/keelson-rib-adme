import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Annotations, annotationsFile, keyOf, parseKey } from "../src/directory/annotations";
import { Directory, searchText } from "../src/directory/index";
import { Store } from "../src/store";
import { SAMPLE_APPS, sampleAccess } from "./fixtures/access";
import { SAMPLE_PROFILE } from "./fixtures/profile";

const TENANT = SAMPLE_PROFILE.tenantId;
const NOW = new Date("2026-10-02T14:05:00Z");
const LOADER = "aaaaaaaa-0000-4000-8000-00000000beef";
const RACHEL = "00000000-0000-4000-8000-000000000011";

function directory(annotations: Record<string, unknown> = {}) {
  return new Directory({
    tenant: TENANT,
    entries: [sampleAccess().directory],
    annotations: annotations as never,
    admeAppId: SAMPLE_PROFILE.admeAppId,
    signedInAs: "ingrid.halvorsen@contoso.example",
  });
}

describe("identity keys", () => {
  test("a key is the tenant, the identifier type and the value", () => {
    const key = keyOf({ tenant: TENANT.toUpperCase(), type: "object", value: RACHEL });
    expect(key).toBe(`object:${TENANT}:${RACHEL}`);
    expect(parseKey(key)).toEqual({ type: "object", tenant: TENANT, value: RACHEL });
    expect(parseKey("mail:x:y")).toBeUndefined();
  });

  test("an email resolves to the object id that holds it, so email is never the key", () => {
    const d = directory();
    const byMail = d.resolve("Rachel.Kim@pacrim-energy.example");
    expect(byMail.id).toBe(RACHEL);
    expect(byMail.key).toBe(`object:${TENANT}:${RACHEL}`);
    expect(byMail.name).toBe("Rachel Kim");
    expect(byMail.org.name).toBe("Pacrim Energy");
  });

  test("applications key by app id and groups by their email", () => {
    const d = directory();
    const app = SAMPLE_APPS[1];
    expect(d.resolve(app?.id ?? "").kind).toBe("app");
    expect(d.resolve(SAMPLE_PROFILE.admeAppId).root).toBe(true);
    const group = d.resolve("users.data.root@opendes.dataservices.energy");
    expect(group).toMatchObject({ kind: "group", name: "users.data.root", type: "group" });
  });
});

describe("labels and annotations", () => {
  test("an id nothing names shows a short id and counts as unresolved", () => {
    const d = directory();
    expect(d.resolve(LOADER)).toMatchObject({
      kind: "unknown",
      name: "aaaa…beef",
      nameSource: "id",
    });
    expect(d.unresolved(LOADER)).toBe(true);
  });

  test("a label names an id the directory cannot, and follows it everywhere", () => {
    const d = directory({
      [`object:${TENANT}:${LOADER}`]: {
        label: "Reference data loader",
        kind: "historical-actor",
        source: { from: "handbook", at: "2026-10-01" },
      },
    });
    expect(d.resolve(LOADER)).toMatchObject({
      name: "Reference data loader",
      nameSource: "label",
      historical: true,
    });
    expect(d.unresolved(LOADER)).toBe(false);
  });

  test("the directory name leads over a label, and the label stays as context", () => {
    const d = directory({
      [`object:${TENANT}:${RACHEL}`]: {
        label: "Someone else",
        organization: "Pacific Rim Energy",
        formerAddresses: ["rachel@oldco.example"],
        source: { from: "operator", at: "2026-10-01" },
      },
    });
    const r = d.resolve(RACHEL);
    expect(r.name).toBe("Rachel Kim");
    expect(r.org).toEqual({
      name: "Pacific Rim Energy",
      domain: "pacrim-energy.example",
      from: "annotation",
    });
    expect(d.resolve("rachel@oldco.example").id).toBe(RACHEL);
    expect(searchText(r)).toContain("rachel@oldco.example");
    expect(searchText(r)).toContain(RACHEL);
  });

  test("saving writes one file per instance with its source, and empty fields clear it", () => {
    const dir = mkdtempSync(join(tmpdir(), "adme-dir-"));
    const store = new Store(dir);
    const name = annotationsFile(SAMPLE_PROFILE);
    const a = new Annotations(store, name);
    const key = `object:${TENANT}:${LOADER}`;
    expect(
      a.set(key, { label: "Loader", formerAddresses: "a@b.example, c@d.example" }, NOW),
    ).toEqual({
      ok: true,
    });
    const saved = JSON.parse(readFileSync(join(dir, name), "utf8"));
    expect(saved.entries[key]).toEqual({
      label: "Loader",
      formerAddresses: ["a@b.example", "c@d.example"],
      source: { from: "operator", at: "2026-10-02" },
    });
    expect(a.set(key, { formerAddresses: "not an address" }, NOW)).toEqual({
      ok: false,
      error: "not is not an email address",
    });
    expect(a.set(key, { label: "" }, NOW)).toEqual({ ok: true });
    expect(new Annotations(store, name).get(key)).toBeUndefined();
  });

  test("a file that does not parse is never overwritten", () => {
    const dir = mkdtempSync(join(tmpdir(), "adme-dir-"));
    const name = annotationsFile(SAMPLE_PROFILE);
    writeFileSync(join(dir, name), "{ not json");
    const a = new Annotations(new Store(dir), name);
    expect(a.unreadable).toBe(true);
    expect(a.set(`object:${TENANT}:${LOADER}`, { label: "x" }, NOW)).toMatchObject({ ok: false });
    expect(readFileSync(join(dir, name), "utf8")).toBe("{ not json");
  });
});
