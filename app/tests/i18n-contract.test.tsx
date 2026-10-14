import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { Trans } from "react-i18next";
import { i18n, msg } from "@/lib/i18n";
import { resetI18nForTests } from "@/lib/i18n/set-locale";

/**
 * What the app relies on i18next to do, pinned, so an upgrade that changes any of it fails here
 * rather than as English or a raw key somewhere in the interface.
 *
 * The convention: the key is the English text, there is no English catalog, and plurals carry their
 * English singular at the call site. See `src/lib/i18n/index.ts`.
 */

const NS = "contract-test";

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  i18n.addResourceBundle("el", NS, {
    "Open the file: report.pdf.": "Άνοιξε το αρχείο: report.pdf.",
    "{{count}} files_one": "{{count}} αρχείο",
    "{{count}} files_other": "{{count}} αρχεία",
    Open_verb: "Άνοιξε",
    Open: "Ανοιχτό",
    "Not translated yet": "",
    "Read the <guide>guide</guide>.": "Διάβασε τον <guide>οδηγό</guide>.",
  });
});
afterEach(async () => {
  cleanup();
  await resetI18nForTests();
});
afterAll(() => {
  i18n.removeResourceBundle("el", NS);
  GlobalRegistrator.unregister();
});

test("a key is its own English, dots and colons included, with no English catalog", () => {
  expect(i18n.t("Open the file: report.pdf.", { ns: NS })).toBe(
    "Open the file: report.pdf.",
  );
  expect(i18n.t("Nobody translated this. Not yet: soon.")).toBe(
    "Nobody translated this. Not yet: soon.",
  );
});

test("English plurals take their singular from the call site", () => {
  const files = (count: number) =>
    i18n.t("{{count}} files", {
      ns: NS,
      count,
      defaultValue_one: "{{count}} file",
    });
  expect(files(1)).toBe("1 file");
  expect(files(2)).toBe("2 files");
  expect(files(0)).toBe("0 files");
});

test("Greek reads its catalog, with Greek plural forms, and the English context base", async () => {
  await i18n.changeLanguage("el");
  expect(i18n.t("Open the file: report.pdf.", { ns: NS })).toBe(
    "Άνοιξε το αρχείο: report.pdf.",
  );
  const files = (count: number) =>
    i18n.t("{{count}} files", {
      ns: NS,
      count,
      defaultValue_one: "{{count}} file",
    });
  expect(files(1)).toBe("1 αρχείο");
  expect(files(5)).toBe("5 αρχεία");
  expect(i18n.t("Open", { ns: NS, context: "verb" })).toBe("Άνοιξε");
  expect(i18n.t("Open", { ns: NS })).toBe("Ανοιχτό");
});

test("a missing or empty Greek value falls back to the English, never to a blank or a key", async () => {
  await i18n.changeLanguage("el");
  expect(i18n.t("Not translated yet", { ns: NS })).toBe("Not translated yet");
  expect(i18n.t("Nothing in any catalog says this.", { ns: NS })).toBe(
    "Nothing in any catalog says this.",
  );
  // A context nobody translated reads as the base English in English.
  await i18n.changeLanguage("en");
  expect(i18n.t("Open", { ns: NS, context: "state" })).toBe("Open");
});

test("interpolated values are not escaped twice", () => {
  expect(i18n.t("Shared with {{who}}", { who: "Ana & Bo <3" })).toBe(
    "Shared with Ana & Bo <3",
  );
});

test("Trans places elements by name, in both languages", async () => {
  const draw = () =>
    render(
      <p data-testid="line">
        <Trans
          i18n={i18n}
          ns={NS}
          i18nKey="Read the <guide>guide</guide>."
          components={{ guide: <a href="/guide">guide</a> }}
        />
      </p>,
    );
  const english = draw();
  expect(english.getByTestId("line").textContent).toBe("Read the guide.");
  expect(english.getByRole("link").getAttribute("href")).toBe("/guide");
  expect(english.getByRole("link").textContent).toBe("guide");
  cleanup();

  await i18n.changeLanguage("el");
  const greek = draw();
  expect(greek.getByTestId("line").textContent).toBe("Διάβασε τον οδηγό.");
  expect(greek.getByRole("link").textContent).toBe("οδηγό");
});

/*
 * Tags are parsed as HTML, so a tag named after a void element (link, img, br, input, hr, meta…)
 * closes at once and loses its words: `<link>guide</link>` draws an empty anchor and the word
 * beside it. Name tags after what they wrap instead (`<guide>`, `<docs>`).
 */
test("a tag named after a void HTML element loses its words, which is why tags never are", () => {
  const view = render(
    <p data-testid="line">
      <Trans
        i18n={i18n}
        i18nKey="Read the <link>guide</link>."
        components={{ link: <a href="/guide">guide</a> }}
      />
    </p>,
  );
  expect(view.getByRole("link").textContent).toBe("");
});

test("Trans reuses one named tag as often as the sentence needs it", () => {
  const view = render(
    <p data-testid="line">
      <Trans
        i18n={i18n}
        i18nKey="Ask about <code>tool.name</code>, <code>intent</code> and <code>page.host</code>."
        components={{ code: <code /> }}
      />
    </p>,
  );
  const codes = [...view.getByTestId("line").querySelectorAll("code")].map(
    (code) => code.textContent,
  );
  expect(codes).toEqual(["tool.name", "intent", "page.host"]);
  expect(view.getByTestId("line").textContent).toBe(
    "Ask about tool.name, intent and page.host.",
  );
});

test("msg marks a key without translating it", () => {
  expect(msg("Usage & Billing")).toBe("Usage & Billing");
});
