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
| `OPENBOT_LOCALES` | The languages offered, comma-separated: `en,el`. English is always offered. Unset offers every language this build has; `en` means English alone and no switcher. |
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

## Tools

| Command | What it says |
| --- | --- |
| `bun run i18n:extract` | Per namespace: how many entries the code asks for, how many have no Greek yet, how many Greek entries nothing asks for any more. `--missing` lists each gap with where it is used (`--ns settings`, `--json`); `--stale` lists the unused Greek. |
| `bun run i18n:guard` | Per file: English a person would see that is not going through a translation (JSX text and text props such as `title`, `aria-label`, `placeholder`). Give a path to list every hit under it. `--mark <paths>` records files that reached zero in `scripts/i18n/translated.json`. |

`app/tests/i18n-catalogs.test.ts` holds the catalogs to the source: no Greek entry nothing asks
for, the English's `{{placeholders}}` and `<tags>` kept, the glossary (`glossary.json`) followed, Greek
spelling (final sigma, `;` for a question, no Latin letters inside Greek words, the informal
register), and every file listed in `translated.json` free of untranslated English and of keys
without Greek. A file goes on that list once somebody has translated it; it never comes off.

`app/tests/i18n-enforce.test.ts` holds every file in `app/src` to the same: no English a person
would see outside a translation, no date or number formatted in the browser's language (use
`intlLocale()`), and no list a person reads sorted the browser's way (use `compareText()`). It is
what catches a raw string brought back by a merge from upstream OpenBot.

Mark text that is code or data rather than prose with `// i18n-ignore` on the line before (or
`{/* i18n-ignore */}` in JSX); text inside `<code>`, `<kbd>` and `<pre>` is skipped already.

## Beyond the web app's own words

- **The server's sentences** (`server` namespace) are read out of `server/src` by
  `scripts/i18n/server-scan.ts`: route bodies (`error`, `message`, `reason`) and refusal messages.
  The server keeps sending English; `client()` translates on the way in, exactly or by pattern
  (`{{0}}` for each value), and keeps the English as `serverMessageOf(error)` for anything that
  compares it. A new sentence on the server fails the catalog test until it has Greek.
- **This deployment's own content** (`content` namespace) is read by `scripts/i18n/content-scan.ts`
  from the templates, skills, stock Bots, catalogue, categories and avatars, and shown through
  `useContentText()`. Third-party text is not ours and shows as written.
- **What the Bot says** follows the person: a Greek interface adds one line to their standing
  instructions (`server/src/i18n/bot-language.ts`); English prompts are unchanged.
- **The server's own few words to a person** with no browser in between (a routine's failure post,
  SMS, the desktop sign-in page, Slack and Teams) are in `server/src/i18n/server-text.ts`.
- **The mobile app** (`mobile/src/i18n/`) has its own small translator and `el.json`, and keeps
  byte copies of `locales.ts`, `schedule-words.ts` and the `server` and `content` catalogs, held to
  their originals by `app/tests/i18n-mobile.test.ts`. After changing one of the originals, copy it
  again: `cp app/src/locales/el/server.json mobile/src/i18n/server.el.json` and so on.

## Greek style

Informal second person singular (εσύ), as on the HyperNoesis platform's Noë Bot pages. Buttons are
action nouns (Αποθήκευση), sentences speak to the person (Δοκίμασε ξανά). Sentence case. Never put
an article or a case ending on an interpolated name; restructure the sentence instead
("Μήνυμα προς {{bot}}").
