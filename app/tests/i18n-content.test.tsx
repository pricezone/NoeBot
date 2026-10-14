import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, render } from "@testing-library/react";
import { useContentText } from "@/lib/i18n/content";
import { ensureLocale, resetI18nForTests } from "@/lib/i18n/set-locale";
import { scanContent } from "../../scripts/i18n/content-scan";
import { ROOT } from "../../scripts/i18n/source";

/**
 * This deployment's own content says itself in the interface's language where it is drawn; what is
 * not ours (a third-party summary, a skill somebody wrote) is shown as written.
 */

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
});
afterEach(async () => {
  cleanup();
  await resetI18nForTests();
});
afterAll(() => {
  GlobalRegistrator.unregister();
});

function Shown({ text }: { text: string }) {
  const content = useContentText();
  return <p data-testid="shown">{content(text)}</p>;
}

test("in English our content is shown as it is written", () => {
  const view = render(<Shown text="Everyday Work" />);
  expect(view.getByTestId("shown").textContent).toBe("Everyday Work");
});

test("in Greek our content is translated, and anything else is left as written", async () => {
  await act(() => ensureLocale("el"));
  const ours = render(<Shown text="Everyday Work" />);
  const theirs = render(<Shown text="Manage issues in Jira." />);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(ours.getAllByTestId("shown")[0]?.textContent).toBe(
    "Καθημερινή δουλειά",
  );
  expect(theirs.getAllByTestId("shown")[1]?.textContent).toBe(
    "Manage issues in Jira.",
  );
});

test("the content scan reads templates, skills, Bots, the catalogue, categories and faces", () => {
  const keys = new Set(scanContent(ROOT).map((key) => key.key));
  for (const expected of [
    "Briefings",
    "Research the public web",
    "Everyday Work",
    "Files in the Drive of whoever is asking.",
    "From Noë Bot Team",
    "Light gray",
    "In love",
    "Affection",
    "Routines",
    "Parallel Search (API key)",
  ])
    expect(keys.has(expected)).toBe(true);
  // A template's name is a proper name, and a catalogue title that is a product's name reads the
  // same in Greek.
  expect(keys.has("Research Desk")).toBe(false);
  expect(keys.has("Google Drive")).toBe(false);
});
