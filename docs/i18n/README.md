# Interface languages

Noë Bot speaks English and Greek. English is the language every string is written in; Greek is a
catalog of translations of those strings. This page is how the two are kept together.

## What a person sees

- **Choosing.** The account menu has a **Language ›** row whenever the deployment offers more than
  one language; Settings → General has the same choice. Each language is named in itself
  (English, Ελληνικά).
- **Which language wins.** For a signed-in person, the language saved to their account, so it
  follows them between devices; a choice this browser made but could not save yet wins over that,
  and is sent again at the next visit. Otherwise: a choice made in this browser, then the
  deployment's default, then the browser's languages, then English. A language the deployment does
  not offer is skipped at every step. See `app/src/lib/i18n/detect.ts` (`resolveLocale`).
- **Inside a conversation**, the Bot's cards and the avatar's captions follow the language of the
  person's last message, and the interface's language before they have written anything
  (`app/src/lib/i18n/strings.ts`).
- **The first paint** is already in the right language: a small inline script in `app/index.html`
  sets `<html lang>` before anything draws, and the root route waits for the Greek catalog before it
  renders. `app/tests/i18n-detect.test.ts` holds the script to `resolveLocale`.

## Turning a language on

| Setting | Meaning |
| --- | --- |
| `OPENBOT_LOCALES` | The languages offered, comma-separated: `en,el`. English is always offered. Unset means English alone and no switcher. |
| `OPENBOT_DEFAULT_LOCALE` | The language somebody who chose none starts in, when it is offered. |

`?i18n-preview=1` offers every language in one browser before the deployment does, for reviewing a
translation on a live instance; `?i18n-preview=0` stops.

The person's choice is stored as `preferences.locale` on their account (`PATCH
/api/settings/preferences { locale }`), and `/api/me` returns it.

## Writing translatable code

The key is the English text. A Greek translation that is missing reads as the English.

```tsx
import { useTranslation } from "@/lib/i18n";

function SaveButton() {
  const { t } = useTranslation();
  return <Button>{t("Save")}</Button>;
}
```

- **Import from `@/lib/i18n`**, never from `react-i18next` directly, so the instance exists.
- **Interpolation:** `t("Sign in to {{origin}}", { origin })`. Never build a sentence from pieces;
  word order differs between languages.
- **Plurals** carry the English singular at the call site, because English has no catalog:

  ```ts
  t("{{count}} files", { count, defaultValue_one: "{{count}} file" })
  ```

  The Greek catalog holds `"{{count}} files_one"` and `"{{count}} files_other"`.
- **Elements inside a sentence** use `<Trans>` with named tags:

  ```tsx
  <Trans i18nKey="Read the <guide>guide</guide>." components={{ guide: <Link to="/docs" /> }} />
  ```

  Never name a tag after a void HTML element (`link`, `img`, `br`, `input`, `hr`, `meta`…): the
  parser closes it at once and its words fall out of the element.
- **Same English, different Greek:** add a context, `t("Open", { context: "verb" })`; the Greek
  catalog holds `Open_verb`, and English reads plain "Open".
- **Constants built when a module loads** (navigation labels, label maps) keep their English
  values wrapped in `msg("…")`, and are translated where they are drawn: `t(item.label)`.
- **Namespaces** follow the build's route chunks: `common` (the shell, the chat and anything the chat
  chunk imports), `sign`, `settings`, `admin`, `content` (this deployment's own data) and `server`
  (sentences the server sends). `useTranslation("settings")` falls back to `common`.
- **Numbers, dates and times** go through `app/src/lib/i18n/format.ts` (`numberFormat`,
  `dateTimeFormat`, `relativeTimeFormat`, `formatList`, `compareText`), never a bare
  `toLocaleString()`, which would follow the browser instead of the interface.

### Never translate

- Anything the model reads: tool `description`s, `.describe()` texts, prompts, tool results.
- Anything code parses: the markers in `shared/handoff-markers.ts` and `shared/component-markers.ts`,
  `REFUSAL_MARKER`, the `Error:` prefix, and the English patterns `stopped-turn.ts` matches.
- Product and brand names: Noë Bot, Bots, HyperNoesis, Composio, OpenClaw, credits.

## Greek style

Informal second person singular (εσύ), as on the HyperNoesis platform's Noë Bot pages. Buttons are
action nouns (Αποθήκευση), sentences speak to the person (Δοκίμασε ξανά). Sentence case. Never put
an article or a case ending on an interpolated name; restructure the sentence instead
("Μήνυμα προς {{bot}}").
