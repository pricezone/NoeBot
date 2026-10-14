import { expect, test } from "bun:test";
import { keysIn, parse, untranslatedIn } from "../../scripts/i18n/scan";

/**
 * What the i18n tools read out of source: which keys code asks for, in which namespace, and which
 * English a person would see without a translation.
 */

const source = `
import { i18n, msg, useTranslation } from "@/lib/i18n";
const LABEL = msg("Usage & Billing");
export function Card({ count }: { count: number }) {
  const { t } = useTranslation("settings");
  return (
    <section title="Raw title" aria-label={t("Card")}>
      <h2>{t("Notifications")}</h2>
      <p>{t("{{count}} files", { count, defaultValue_one: "{{count}} file" })}</p>
      <button>{t("Open", { context: "verb" })}</button>
      <Trans i18nKey="Read the <guide>guide</guide>." components={{ guide: <a /> }} />
      <p>Untranslated words here</p>
      {"Also untranslated"}
      {" "}
      <code>npm install</code>
      {/* i18n-ignore */}
      <span>Ignored on purpose</span>
      <input placeholder="Type here" />
    </section>
  );
}
function Plain() {
  const { t } = useTranslation();
  return <p>{t("Shell word")}{i18n.t("Outside a hook", { ns: "admin" })}</p>;
}
`;

const file = "app/src/components/example.tsx";
const parsed = parse(file, source);

test("keys carry their namespace, plural and context", () => {
  const keys = keysIn(file, parsed).map(
    ({ key, namespace, plural, context }) => ({
      key,
      namespace,
      plural,
      ...(context ? { context } : {}),
    }),
  );
  expect(keys).toEqual([
    { key: "Usage & Billing", namespace: "common", plural: false },
    { key: "Card", namespace: "settings", plural: false },
    { key: "Notifications", namespace: "settings", plural: false },
    { key: "{{count}} files", namespace: "settings", plural: true },
    { key: "Open", namespace: "settings", plural: false, context: "verb" },
    {
      key: "Read the <guide>guide</guide>.",
      namespace: "settings",
      plural: false,
    },
    { key: "Shell word", namespace: "common", plural: false },
    { key: "Outside a hook", namespace: "admin", plural: false },
  ]);
});

test("untranslated English is text and text props, never code, spaces or ignored lines", () => {
  expect(
    untranslatedIn(file, parsed).map(({ where, text }) => `${where}: ${text}`),
  ).toEqual([
    "title: Raw title",
    "text: Untranslated words here",
    "text: Also untranslated",
    "placeholder: Type here",
  ]);
});
