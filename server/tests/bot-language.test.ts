import { expect, test } from "bun:test";
import {
  FIRST_TURN_COPY,
  FIRST_TURN_GREETING,
  frameFirstTurn,
  isFirstTurn,
} from "../../shared/first-turn";
import {
  interfaceLanguageGuidance,
  interfaceLocaleOf,
  withInterfaceLanguage,
} from "../src/i18n/bot-language";

/**
 * A Bot answers in the language the person's interface speaks, and an English person's prompts are
 * exactly what they were.
 */

test("English adds nothing, byte for byte", () => {
  expect(interfaceLanguageGuidance("en")).toBeNull();
  expect(interfaceLanguageGuidance(null)).toBeNull();
  expect(withInterfaceLanguage("Call me Sam.", "en")).toBe("Call me Sam.");
  expect(withInterfaceLanguage(null, null)).toBeNull();
});

test("Greek adds one line after the person's own words, or stands alone", () => {
  const line = interfaceLanguageGuidance("el") ?? "";
  expect(line).toContain("Answer in Greek");
  expect(withInterfaceLanguage("Call me Sam.", "el")).toBe(
    `Call me Sam.\n\n${line}`,
  );
  expect(withInterfaceLanguage(null, "el")).toBe(line);
  expect(withInterfaceLanguage("   ", "el")).toBe(line);
});

test("the person's own choice wins, then the deployment's default, else English", async () => {
  const greekDeployment = {
    OPENBOT_LOCALES: "en,el",
    OPENBOT_DEFAULT_LOCALE: "el",
  };
  expect(await interfaceLocaleOf(async () => "el", {})).toBe("el");
  expect(await interfaceLocaleOf(async () => "en", greekDeployment)).toBe("en");
  expect(await interfaceLocaleOf(async () => null, greekDeployment)).toBe("el");
  expect(await interfaceLocaleOf(async () => null, {})).toBeNull();
  // A default the deployment does not offer is no default.
  expect(
    await interfaceLocaleOf(async () => null, { OPENBOT_DEFAULT_LOCALE: "el" }),
  ).toBeNull();
  // A failed read is the default, never a failed run.
  expect(
    await interfaceLocaleOf(
      () => Promise.reject(new Error("down")),
      greekDeployment,
    ),
  ).toBe("el");
});

test("the first turn greets in Greek, and is still recognised as the first turn", () => {
  expect(frameFirstTurn("en")).toBe(frameFirstTurn());
  expect(frameFirstTurn()).toContain(FIRST_TURN_GREETING);
  const greek = frameFirstTurn("el");
  expect(isFirstTurn(greek)).toBe(true);
  expect(greek).toContain(FIRST_TURN_COPY.el.greeting);
  expect(greek).toContain(FIRST_TURN_COPY.el.question);
  for (const option of FIRST_TURN_COPY.el.options)
    expect(greek).toContain(`"${option}"`);
  expect(greek).not.toContain(FIRST_TURN_GREETING);
});
