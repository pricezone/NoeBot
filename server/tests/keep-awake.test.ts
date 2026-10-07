import { describe, expect, test } from "bun:test";
import {
  BROWSER_BUSY_MS,
  type BusySignals,
  isBusy,
  startKeepAwake,
} from "../src/keep-awake";

const idle: BusySignals = {
  recentTurns: 0,
  leasedWork: 0,
  browserLastUsedAt: null,
};

describe("whether a Bot is working", () => {
  const now = Date.parse("2026-10-08T10:00:00Z");

  test("nothing running, nothing leased, no browser: idle", () => {
    expect(isBusy(idle, now)).toBe(false);
  });

  test("a background turn or held work is work in progress", () => {
    expect(isBusy({ ...idle, recentTurns: 1 }, now)).toBe(true);
    expect(isBusy({ ...idle, leasedWork: 2 }, now)).toBe(true);
  });

  test("a browser used in the last few minutes is a Bot still at it; an hour ago is not", () => {
    expect(
      isBusy({ ...idle, browserLastUsedAt: new Date(now - 60_000) }, now),
    ).toBe(true);
    expect(
      isBusy(
        { ...idle, browserLastUsedAt: new Date(now - BROWSER_BUSY_MS - 1) },
        now,
      ),
    ).toBe(false);
  });
});

describe("keeping the machine awake", () => {
  test("asks for its own public health page while busy, and nothing while idle", async () => {
    const asked: string[] = [];
    let busy = true;
    const keeper = startKeepAwake({
      publicUrl: "https://bot.example.fly.dev/",
      signals: async () => (busy ? { ...idle, recentTurns: 1 } : idle),
      intervalMs: 60_000,
      fetchImpl: async (url) => {
        asked.push(url);
        return new Response("ok");
      },
      log: () => undefined,
    });
    try {
      expect(await keeper.tick()).toBe(true);
      busy = false;
      expect(await keeper.tick()).toBe(false);
      expect(asked).toEqual(["https://bot.example.fly.dev/health"]);
    } finally {
      keeper.stop();
    }
  });

  test("a signal it cannot read keeps the machine up rather than sleeping through a task", async () => {
    let asked = 0;
    const keeper = startKeepAwake({
      publicUrl: "https://bot.example.fly.dev",
      signals: async () => {
        throw new Error("database unreachable");
      },
      fetchImpl: async () => {
        asked += 1;
        return new Response("ok");
      },
      log: () => undefined,
    });
    try {
      expect(await keeper.tick()).toBe(true);
      expect(asked).toBe(1);
    } finally {
      keeper.stop();
    }
  });
});
