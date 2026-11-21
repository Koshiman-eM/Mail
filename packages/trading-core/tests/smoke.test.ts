import { describe, expect, it } from "vitest";
import { CORE_VERSION, coreInfo } from "../src/version.js";

describe("coreInfo", () => {
  it("returns name and version", () => {
    expect(coreInfo()).toEqual({ name: "@trading/core", version: CORE_VERSION });
    expect(CORE_VERSION).toBe("0.1.0");
  });
});
