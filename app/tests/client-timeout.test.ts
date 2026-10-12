import { describe, expect, test } from "bun:test";
import { withTimeout } from "@/lib/client";

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("withTimeout", () => {
  test("aborts after the deadline, with the caller's sentence as the reason", async () => {
    const signal = withTimeout(10, "Bot templates took too long to load.");
    expect(signal.aborted).toBe(false);
    await tick(30);
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBeInstanceOf(Error);
    expect((signal.reason as Error).message).toBe(
      "Bot templates took too long to load.",
    );
  });

  test("aborts as soon as the outer signal does, with the outer reason", async () => {
    const outer = new AbortController();
    const signal = withTimeout(10_000, "too long", outer.signal);
    outer.abort(new Error("the query was cancelled"));
    expect(signal.aborted).toBe(true);
    expect((signal.reason as Error).message).toBe("the query was cancelled");
  });

  test("an outer signal that is already aborted aborts at once", () => {
    const outer = new AbortController();
    outer.abort(new Error("gone"));
    const signal = withTimeout(10_000, "too long", outer.signal);
    expect(signal.aborted).toBe(true);
    expect((signal.reason as Error).message).toBe("gone");
  });

  test("neither firing leaves the signal alone", async () => {
    const outer = new AbortController();
    const signal = withTimeout(10_000, "too long", outer.signal);
    await tick(20);
    expect(signal.aborted).toBe(false);
  });
});
