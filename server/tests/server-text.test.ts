import { expect, test } from "bun:test";
import { SERVER_TEXT_EL, serverText } from "../src/i18n/server-text";

/** The few sentences the server writes with no browser in between, in Greek and in English. */

const placeholders = (text: string) =>
  [...text.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]).sort();

test("every Greek sentence keeps its English's values", () => {
  expect(
    Object.entries(SERVER_TEXT_EL).filter(
      ([english, greek]) =>
        placeholders(english).join() !== placeholders(greek).join(),
    ),
  ).toEqual([]);
});

test("English is the key, with its values filled in", () => {
  expect(
    serverText(null, "This routine failed: {{reason}}", { reason: "timeout" }),
  ).toBe("This routine failed: timeout");
  expect(serverText("en", "Done.")).toBe("Done.");
});

test("Greek is looked up, and its values filled in untranslated", () => {
  expect(
    serverText("el", "This routine failed: {{reason}}", { reason: "timeout" }),
  ).toBe("Αυτή η ρουτίνα απέτυχε: timeout");
});

test("a sentence with no Greek yet reads as its English", () => {
  expect(serverText("el", "Something new.")).toBe("Something new.");
});
