import { describe, expect, it } from "vitest";

import { scaffoldInfo } from "../../src/scaffold.js";

describe("bootstrap scaffold", () => {
  it("exposes an inert scaffold marker", () => {
    expect(scaffoldInfo).toStrictEqual({
      name: "freebusy-gateway",
      stage: "scaffold"
    });
  });
});
