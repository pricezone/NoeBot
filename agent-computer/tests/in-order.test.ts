import { expect, test } from "bun:test";
import { inOrder } from "../src/in-order";

test("a slow message does not let the one after it overtake", async () => {
  const applied: string[] = [];
  const apply = inOrder(async (key: string) => {
    // The key's "down" waits on the page, as describing it for a recording does; its "up" does not.
    if (key.endsWith("down")) await Bun.sleep(30);
    applied.push(key);
  });

  await Promise.all([
    apply("e down"),
    apply("e up"),
    apply("m down"),
    apply("m up"),
  ]);

  expect(applied).toEqual(["e down", "e up", "m down", "m up"]);
});

test("one that fails is its caller's to see, and the next still runs", async () => {
  const applied: string[] = [];
  const apply = inOrder(async (item: string) => {
    if (item === "bad") throw new Error("refused");
    applied.push(item);
  });

  const failed = apply("bad");
  const next = apply("good");

  await expect(failed).rejects.toThrow("refused");
  await next;
  expect(applied).toEqual(["good"]);
});
