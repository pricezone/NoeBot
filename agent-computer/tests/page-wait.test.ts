import { expect, test } from "bun:test";
import { readWait, waitForPageText } from "../src/page-wait";

test("a read asks to wait only when it names the words, and never past the cap", () => {
  expect(readWait(new URLSearchParams())).toBeUndefined();
  expect(readWait(new URLSearchParams({ waitFor: "  " }))).toBeUndefined();
  expect(readWait(new URLSearchParams({ waitFor: "Hello" }))).toEqual({
    text: "Hello",
    timeoutMs: 15_000,
  });
  expect(
    readWait(new URLSearchParams({ waitFor: "Hello", timeoutMs: "90000" })),
  ).toEqual({ text: "Hello", timeoutMs: 20_000 });
});

test("answers the moment the words appear, however they are spaced or cased", async () => {
  let clock = 0;
  const texts = ["Loading...", "Loading...", "Hello   world!"];
  const result = await waitForPageText(
    async () => ({ text: texts.shift() ?? "Hello world!" }),
    { text: "hello world", timeoutMs: 15_000 },
    {
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    },
  );
  expect(result.found).toBe(true);
  expect(result.ms).toBe(500);
  expect(result.extract.text).toBe("Hello   world!");
});

test("says the words never came once the time is up", async () => {
  let clock = 0;
  const result = await waitForPageText(
    async () => ({ text: "Still loading" }),
    { text: "Done", timeoutMs: 1_000 },
    {
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    },
  );
  expect(result.found).toBe(false);
  expect(result.ms).toBe(1_000);
});
