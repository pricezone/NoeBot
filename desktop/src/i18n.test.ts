import { afterEach, expect, test } from "bun:test";
import {
  getLocale,
  i18n,
  localizeNative,
  resetLocaleForTests,
  setLocale,
} from "./i18n";

/** The launcher's translator: English by default, Greek on request, native sentences by pattern. */

afterEach(() => {
  globalThis.localStorage?.removeItem("openbot-launcher-locale");
  resetLocaleForTests();
});

test("English is the key, with nothing to look up", () => {
  expect(getLocale()).toBe("en");
  expect(i18n.t("Start OpenBot")).toBe("Start OpenBot");
  expect(localizeNative("The Bot could not answer.")).toBe(
    "The Bot could not answer.",
  );
});

test("Greek is looked up, and a native sentence built with values matches its pattern", () => {
  setLocale("el");
  expect(i18n.t("Start OpenBot")).toBe("Εκκίνηση του OpenBot");
  expect(i18n.t("Signed in to {{name}}.", { name: "OpenAI" })).toBe(
    "Συνδέθηκες στο OpenAI.",
  );
  expect(
    localizeNative("The installed package langgraph is missing from bot."),
  ).toBe("Το εγκατεστημένο πακέτο langgraph λείπει από το bot.");
  expect(localizeNative("Something new happened.")).toBe(
    "Something new happened.",
  );
});
