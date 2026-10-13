import {
  afterEach,
  beforeEach,
  expect,
  type Mock,
  spyOn,
  test,
} from "bun:test";
import { warmComputer } from "@/lib/computers/use-computer-sleep";

/*
 * The Bot's browser is started while the person is still writing, so the first step of a turn does
 * not pay for a cold launch. Once a minute per Bot at most, and a failure is never surfaced.
 */
let fetchSpy: Mock<typeof fetch>;
const asked: string[] = [];
beforeEach(() => {
  asked.length = 0;
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (url: Parameters<typeof fetch>[0]) => {
        asked.push(String(url));
        return Response.json({ warm: true, launched: true, ms: 900 });
      },
      { preconnect: () => undefined },
    ),
  );
});
afterEach(() => fetchSpy.mockRestore());

test("asks the computer to start the browser, once a minute per Bot", () => {
  expect(warmComputer("warm-bot", 1_000_000)).toBe(true);
  expect(warmComputer("warm-bot", 1_030_000)).toBe(false);
  expect(warmComputer("other-bot", 1_030_000)).toBe(true);
  expect(warmComputer("warm-bot", 1_061_000)).toBe(true);
  expect(asked).toEqual([
    "/api/computers/warm-bot/warm",
    "/api/computers/other-bot/warm",
    "/api/computers/warm-bot/warm",
  ]);
});

test("no Bot, no request", () => {
  expect(warmComputer("", 5_000_000)).toBe(false);
  expect(asked).toEqual([]);
});
