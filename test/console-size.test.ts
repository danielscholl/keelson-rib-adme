import { describe, expect, test } from "bun:test";
import { ACCESS_AREA } from "../src/access/read";
import { CONSOLE_MAX_BYTES, expectHtml } from "../src/boards/console";
import { composeConsole } from "../src/modules/console";
import { SEISMIC_AREA } from "../src/seismic/read";
import { sampleAccess } from "./fixtures/access";
import { sampleSeismic } from "./fixtures/seismic";
import { seededRuntime } from "./harness";

const extra = (n: number) => `eeeeeeee-0000-4000-8000-${String(n).padStart(12, "0")}`;

// The sample cast plus `people` guests, each a viewer on every own-ACL subproject.
function large(people: number) {
  const access = sampleAccess();
  const seismic = sampleSeismic();
  const viewerGroups = Object.keys(seismic.groups).filter((g) =>
    g.endsWith(".viewer@opendes.dataservices.energy"),
  );
  for (let n = 1; n <= people; n++) {
    const id = extra(n);
    access.directory[id] = {
      kind: "user",
      name: `Field Engineer ${String(n).padStart(3, "0")}`,
      mail: `engineer${n}@vendor.example`,
      guest: true,
      inviteState: "Accepted",
    };
    access.groups.users.push({ id, owner: false });
    access.groups.viewers.push({ id, owner: false });
    for (const g of viewerGroups) seismic.groups[g]?.members?.push(id);
  }
  return seededRuntime({ [ACCESS_AREA]: access, [SEISMIC_AREA]: seismic });
}

const bytes = (html: string) => new TextEncoder().encode(html).byteLength;

describe("console size", () => {
  test("a hundred grant holders across every subproject keep the matrix and fit the frame", () => {
    const html = composeConsole(large(100));
    expect(bytes(html)).toBeLessThan(CONSOLE_MAX_BYTES);
    expect(html).toContain('<table class="matrix">');
    expect(html).toContain("Field Engineer 100");
  });

  test("past what the matrix can carry, Seismic lists subprojects and the frame still fits", () => {
    const html = composeConsole(large(200));
    expect(() => expectHtml(html)).not.toThrow();
    expect(html).not.toContain('<table class="matrix">');
    expect(html).toContain("too many to draw as a matrix here");
    expect(html).toContain('data-inspect="sub:alpha"');
    expect(html).toContain("Field Engineer 200");
  });
});
