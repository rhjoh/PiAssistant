import { describe, expect, it } from "vitest";
import {
  rememberToolLabel,
  toolLabelForCallId,
} from "./tool-call-cache.js";

describe("tool-call-cache", () => {
  it("remembers labels by toolCallId", () => {
    rememberToolLabel("call_1", "$ ls -la");
    expect(toolLabelForCallId("call_1")).toBe("$ ls -la");
  });

  it("ignores empty toolCallIds", () => {
    rememberToolLabel("", "whatever");
    expect(toolLabelForCallId("call_1")).toBe("$ ls -la");
  });

  it("returns undefined for unknown ids", () => {
    expect(toolLabelForCallId("call_unknown")).toBeUndefined();
  });

  it("overwrites and evicts oldest entries beyond the cap", () => {
    for (let i = 0; i < 2500; i++) {
      rememberToolLabel(`call_${i}`, `label_${i}`);
    }
    // Most recent survives.
    expect(toolLabelForCallId("call_2499")).toBe("label_2499");
    // The map is capped at 2000, so the first ~500 entries were evicted.
    expect(toolLabelForCallId("call_1")).toBeUndefined();
  });
});
