import { describe, expect, it } from "vitest";
import { isSameOrigin } from "../src/lib/http/origin";

const internal = { requestOrigin: "http://localhost:10000" };

describe("isSameOrigin", () => {
  it("allows the public Render URL behind the proxy (Host header)", () => {
    expect(isSameOrigin("https://sedori-bpng.onrender.com", { ...internal, host: "sedori-bpng.onrender.com" })).toBe(true);
  });
  it("allows via X-Forwarded-Host and RENDER_EXTERNAL_URL", () => {
    expect(isSameOrigin("https://a.onrender.com", { ...internal, forwardedHost: "a.onrender.com, proxy" })).toBe(true);
    expect(isSameOrigin("https://a.onrender.com", { ...internal, host: "localhost:10000", publicUrls: ["https://a.onrender.com"] })).toBe(true);
  });
  it("allows same origin and missing Origin", () => {
    expect(isSameOrigin("http://localhost:10000", internal)).toBe(true);
    expect(isSameOrigin(null, internal)).toBe(true);
  });
  it("rejects other sites and junk", () => {
    expect(isSameOrigin("https://evil.example", { ...internal, host: "sedori-bpng.onrender.com", publicUrls: ["https://sedori-bpng.onrender.com"] })).toBe(false);
    expect(isSameOrigin("null", { ...internal, host: "sedori-bpng.onrender.com" })).toBe(false);
    expect(isSameOrigin("https://sedori-bpng.onrender.com.evil.example", { ...internal, host: "sedori-bpng.onrender.com" })).toBe(false);
  });
});
