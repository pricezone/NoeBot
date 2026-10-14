# Prompt: 17 more interface languages for Noë Bot

Paste everything below the line into a Claude Code session opened on this repository
(`pricezone/NoeBot`, our own repo, a fork of CopilotKit/OpenBot). It was written on 2026-10-14,
after Greek shipped, and records what the Greek work taught us. Check the paths it names before you
rely on them; the code may have moved.

---

Add 17 interface languages to Noë Bot, next to English and Greek: Czech, Danish, Dutch, Finnish,
French, German, Hungarian, Italian, Polish, Portuguese, Spanish, Swedish, Norwegian Bokmål,
Russian, Ukrainian, Turkish and Romanian. Every surface that speaks Greek today must speak each new
language just as completely: the web app (admin included), the server's sentences, our own
content, what the Bot says, the Expo mobile client, and the Tauri desktop launcher with its tray
menu. English and Greek must not change.

## What already exists

Greek is complete and on by default. The work behind it means nearly every string already goes
through a translation, so most of this task is (1) turning code that assumes exactly two languages
into code for nineteen, and (2) writing seventeen sets of catalogs.

Read these first:

- `docs/i18n/README.md`: the conventions, the tools, what is never translated, Greek style.
- `docs/i18n/glossary.json`: `keep` (names that stay as they are in every language), `exact` and
  `forbidden` (Greek only today).
- `shared/i18n/locales.ts`: the one language list. The mobile and desktop packages keep byte copies
  of it.
- `app/src/lib/i18n/`: the runtime (`index.ts`, `loaders.ts`, `detect.ts`, `set-locale.ts`,
  `format.ts`, `server-messages.ts`, `content.ts`, `strings.ts`).
- `scripts/i18n/`: `scan.ts` (keys and untranslated text), `extract.ts`, `server-scan.ts`,
  `content-scan.ts`, `desktop-scan.ts`, `source.ts`.
- Tests: `app/tests/i18n-*.test.ts*` and `server/tests/{bot-language,server-text,health}.test.ts`.

How it works, in short:

- **English text is the key.** There is no English catalog. A missing translation shows the English.
- **Plurals:** `t("{{count}} files", { count, defaultValue_one: "{{count}} file" })`.
- **Context:** `t("Connected", { context: "heading" })` gives the key `Connected_heading`.
- **Constants built when a module loads** are marked `msg("…")` and translated where they are shown.
- **Namespaces:** `common`, `sign`, `settings`, `admin`, `content` (our own data, through
  `useContentText`) and `server` (server sentences, translated on the client exactly or by a
  `{{0}}` pattern).
- **Where the language comes from:** the person's choice is saved in `users.preferences.locale`.
  `OPENBOT_LOCALES` lists the languages a deployment offers; unset, it offers every language in
  `LOCALES`. `OPENBOT_DEFAULT_LOCALE` names the deployment's default, and `?i18n-preview=1` shows
  every language in one browser.

## Settle these with the owner before writing code

Ask these together, each with the recommendation shown, and record the answers in
`docs/i18n/README.md`.

1. **Variants and codes.**
   - Portuguese: European (`pt`, `pt-PT`) or Brazilian (`pt-BR`)? Recommend European, for a
     European customer base.
   - Spanish: Spain (`es-ES`) or neutral Latin American? Recommend `es-ES`.
   - Norwegian: `nb`, with the browser tags `no` and `nn` read as `nb` too.
2. **Register.** Greek uses the informal εσύ. Recommend informal wherever consumer software normally
   uses it: de du, nl je, da/sv/nb du, fi sinä, it tu, es tú, pt tu, ro tu, tr sen, hu te, cs ty,
   pl ty. Recommend formal where informal reads as rude in software: fr vous, ru вы, uk ви.
3. **Release.** The owner reviewed the Greek personally but cannot review 17 languages. Recommend:
   - land every language complete, but outside the default offer;
   - add a `RELEASED_LOCALES` list (en, el to begin with), so that an unset `OPENBOT_LOCALES`
     offers only released languages;
   - make the others reachable through `?i18n-preview=1` or an explicit `OPENBOT_LOCALES`;
   - release each language after a native speaker has reviewed it.
4. **Order in the switcher.** Recommend English first, then the others by their own names
   (autonyms) under a root collation, each written in its own language and script.
5. **The language of chat cards and avatar captions.** These follow the language of the person's
   last message, which is detected today by script alone (`anim/intent.ts` `languageOf`: Greek
   letters mean Greek, anything else means English). Recommend:
   - Greek script means `el`;
   - Cyrillic means `uk` when the message contains і, ї, є or ґ, and `ru` otherwise;
   - Latin script means the interface language when that is a Latin-script language, and English
     otherwise;
   - no message yet means the interface language.
6. **The platform.** The HyperNoesis platform (`packages/i18n/src/config.ts` in HyperNoesisAI)
   speaks only `en` and `el`, so its sign-in handoff only ever sets those two. New languages reach a
   person through their browser's language or the switcher. Translating the platform is a separate
   task. Confirm that it is out of scope.

## Phase 1: generalize the plumbing (still English and Greek only)

Every Greek-only assumption becomes a per-language one. `LOCALES` stays `["en", "el"]` throughout
this phase, and nothing a person sees changes. All existing tests must still pass. These are the
known places; also grep for `"el"`, `el-GR`, `Greek` and `UiLanguage`:

| Where | Today | Becomes |
| --- | --- | --- |
| `shared/i18n/locales.ts` (+ `mobile/src/i18n/locales.ts`, `desktop/src/i18n/locales.ts` copies) | `LOCALES`, `LOCALE_LABELS` | Add the per-language data in one place: the Intl locale (`INTL_LOCALE`), the language's English name for prompts, its plural categories (from `Intl.PluralRules(…).resolvedOptions().pluralCategories`), `RELEASED_LOCALES`, and `normalizeLocale` aliases (`no`/`nn` → `nb`). |
| `app/index.html` (second inline script) | `tag === "el"` | Checks a language list inlined in the script; `app/tests/i18n-detect.test.ts` must hold that list to `LOCALES`. |
| `app/src/lib/i18n/loaders.ts`, `index.ts` | `EL_CATALOGS`, `language === "el"` | A loader per language and namespace. Bun has no `import.meta.glob`, so write an explicit map, and test that every language × namespace file exists. Each catalog is its own lazy chunk. |
| `app/src/lib/i18n/format.ts`, `mobile/src/i18n/index.ts` `intlLocale` | `el` → `el-GR`, else `en-US` | Read from `INTL_LOCALE`. Keep exactly `en-US` for English, and check `hourCycle` per language. |
| `app/src/lib/i18n/strings.ts` | `UiLanguage = "en" \| "el"`, EN/EL tables | Per-language tables (or `common` keys), with the TypeScript compiler still holding every table to the English shape. Detection follows decision 5. |
| `app/src/components/noe-bot/anim/catalog.ts`, `anim/intent.ts` | `Lang = "en" \| "el"`, caption `LABELS`, English and Greek keyword rules | Captions for every language. Keyword rules for new languages may stay absent (fall back to English rules); say so in a comment. |
| `shared/i18n/schedule-words.ts` (+ mobile copy), `components/routines/routines-list.tsx` | `scheduleInGreek` | `scheduleIn(locale, words)` driven by per-language word tables. `server/tests/schedule-words.test.ts` must cover every language. |
| `shared/first-turn.ts` | `FIRST_TURN_COPY` en/el; line 92 `locale === "el" ? " Write it all in Greek…"` | Copy for every language; the instruction names the language through the English-name map. English stays byte-identical. |
| `server/src/i18n/bot-language.ts` | `GUIDANCE.el` | One sentence built from the English name ("This person's interface is in German…"). English returns `null`, so English prompts stay byte-identical. |
| `server/src/i18n/server-text.ts` | `TABLES.el` | A table per language. `server/tests/server-text.test.ts` checks every language's placeholders. |
| `server/src/delivery/twilio.ts` | passes `Locale` for anything not `en` | Map only to the locales Twilio Verify supports, from Twilio's current docs; omit the rest. |
| `server/src/channels/titler.ts`, `server/src/auth/native-browser.ts`, `server/src/i18n/deployment-locale.ts` | Greek examples, `en`/`el` | Check they handle any language. |
| `scripts/i18n/source.ts` `catalogEntriesFor`, `greekCatalogs` | `_one`/`_other` only, Greek only | Per-language catalogs and per-language plural suffixes: cs, pl, ru and uk need `_one`/`_few`/`_many`/`_other`; ro needs `_one`/`_few`/`_other`; fr, it, es and pt need `_one`/`_many`/`_other`. `extract.ts` takes `--locale`. |
| `mobile/src/i18n/index.ts` `plural()`, `desktop/src/i18n/index.ts`, server plurals | return only `one` or `other` | Return every CLDR category. Hermes may lack `Intl.PluralRules`. Check on a device, and ship a small rule table for these 19 languages if it does. |
| `app/tests/i18n-catalogs.test.ts` | "Greek catalogs", "Greek spelling", glossary Greek | Generic checks run for every language: NFC, non-empty values, placeholders and `<tags>` kept, no stale keys, identical-to-English only for `keep` names. Then a rule module per language (see below). |
| `docs/i18n/glossary.json` | `exact`/`forbidden` hold Greek | `exact` and `forbidden` per language. `keep` stays shared. |
| `app/src/components/language-options.tsx`, `app-sidebar/language-row.tsx` | A two-option radiogroup in a popover | Handles 19 options: a scrollable list with a max height that stays inside the viewport at 390 px, typing a letter to jump, and focus on the ticked option when it opens. |
| `app/src/components/settings/language-preference.tsx` | Select | Check it with 19 options. |
| `mobile/app/index.tsx` | Radio `Pressable`s above Sign out | A list screen or picker. |
| `desktop/src/LanguageSwitch.tsx` | A row of buttons, one per language | A select. |
| `desktop/src-tauri/src/ui_locale.rs` | `enum UiLocale { En, El }`, menu texts | One variant per language, with `parse` aliases and menu texts. Cargo is not installed locally; the Desktop workflow in CI builds it. Format to rustfmt (it wants `.map_err(…)` on its own line after a call). |
| Mobile and desktop catalogs (`el.json`, `server.el.json`, `content.el.json`, `native.el.json`) | Bundled Greek | One set per language. Load them lazily if the bundle grows noticeably. The copy tests in `app/tests/i18n-mobile.test.ts` cover every language. |
| JS case changes on displayed text (`toUpperCase()` in `account-menu.tsx`, `account-section.tsx`, `agent-dialog.tsx`, `question-card.tsx`, `voice-call-widget.tsx`, `anim/catalog.ts`, …) | Locale-blind | Use `toLocaleUpperCase(intlLocale())` where a person reads the result: Turkish i becomes İ. Add an enforcement test alongside the `toLocale*` and `localeCompare` ones. |

Also in this phase:

- Generalize the build check so no language's catalog bytes land in the English entry chunk.
- Confirm that the Inter font import (`@fontsource-variable/inter`) serves the latin-ext and
  cyrillic subsets through `unicode-range`.
- Make the `<html lang>` value drive CSS `text-transform: uppercase` correctly; that is how Turkish
  İ and the Dutch IJ come out right.

## Phase 2: the glossary

For each language, draft `exact` equivalents for the terms the Greek glossary fixes, using the
product's own vocabulary:

- **Navigation:** Chat, New chat, Settings, Log out, Apps, Connected accounts.
- **Features:** Routines, Skills, Approvals, Computer, Marketplace, Template, Plugin,
  Responsibility.
- **Account and admin:** Usage & Billing, Admin.
- **Language and theme:** Language, Theme, Dark/Light/System.
- **Actions:** Try again, Cancel, Save, Delete, Dismiss, Enable, Disable, Add, Remove, Install.
- **Choose the grammatical gender of "Bot"** in each language and write it down; agreement depends
  on it.

Add a `forbidden` entry for any known bad machine translation. "Bots", "Noë Bot", "HyperNoesis",
"Composio", "OpenClaw" and "credits" stay as they are (`keep`).

## Phase 3: translate, one language per commit

A language enters `LOCALES` only in the commit that makes it complete everywhere. A push to `main`
publishes the image that every instance pulls within the hour, and a language in `LOCALES` with
gaps would show English holes. Each language's commit carries everything for that language:

- the 6 web namespaces (about 3,200 entries today: common ≈1,470, server ≈720, admin ≈460,
  settings ≈315, content ≈190, sign ≈14);
- the mobile catalog (≈160) and its copies of the server and content catalogs;
- the desktop catalogs (≈185 UI and ≈185 native problem sentences);
- the TypeScript tables:
  - chat cards,
  - avatar captions,
  - first-turn copy,
  - server-text,
  - schedule words,
  - the Bot-language name;
- the Rust tray texts;
- the glossary entries.

This is fan-out work: about 4,000 entries per language and about 70,000 in all. Run it as a
workflow:

- **Translators:** one agent per language and namespace. Give each one the English keys
  (`bun scripts/i18n/extract.ts --missing --ns <ns> --locale <xx> --json`, which lists every place a
  key is used), the glossary, the register, the gender of "Bot", the rules below, and the matching
  Greek entries as a cross-check on meaning.
- **Reviewer:** one more agent per language. It reads the merged catalogs for consistent terms,
  unnatural word order and wrong register, back-translates a sample of 100 into English and flags
  any whose meaning drifted, and checks the length limits.

Rules for every translator (from the Greek work):

- **Translate the meaning, not the words.** Use sentence case, never Title Case. Buttons are short
  action phrases in the form that language's software uses (German "Speichern", French
  "Enregistrer"). Sentences address the person in the agreed register.
- **Keep every `{{placeholder}}`, every `<tag>…</tag>` and the ellipsis "…"** exactly as they are.
  Keep leading and trailing spaces (" · answer from {{answeredBy}}").
- **Never inflect an interpolated name.** No case ending, article or suffix on `{{name}}`, `{{bot}}`,
  `{{title}}` and the like. Restructure instead: "Message to {{bot}}" becomes a construction where
  the name stands alone, for example after a colon. This matters most for Czech, Polish, Russian,
  Ukrainian, Finnish, Hungarian and Turkish, where names take case suffixes.
- **Keys that carry a `context`** (`Usage & Billing_menu`, `Connected_heading`) need the form for
  that context. Read the usage locations `extract` gives.
- **Plurals:** write every category the language has. The `{{count}}` placeholder stays in each
  form.
- **Length:** respect `// i18n: max N` notes. Sidebar rows hold about 24 characters, menu rows 28,
  dialog navigation 20, small buttons 18. German, Finnish and Hungarian run long, so prefer a
  shorter synonym; never change styles to fit.
- **Brand and product names stay as they are:** the `keep` list, plus Google Drive, Notion,
  Parallel Search, Slack, Microsoft Teams, Composio.
- **Typography:** use each language's own quotation marks (de „…“, fr « … » with non-breaking
  spaces, pl/ro „…”, ru/uk «…», cs „…“) and keep URLs and code untouched.

Language rule modules for the catalog test, one per language, in the spirit of "Greek spelling":

- **All languages:** no letters of another script inside a word (Latin inside Cyrillic, and the
  reverse).
- **Register check:** the pronouns of the register that was not chosen (for example German "Sie"
  and "Ihr…" as forms of address, French "tu", Russian "ты").
- **Typography:** the quotation-mark style above, and French non-breaking spaces before `: ; ! ?`.
- **Turkish:** no dotless/dotted i mistakes in the glossary terms.
- **Ukrainian:** no Russian-only letters (ы, э, ъ, ё).
- **Russian:** none of і, ї, є, ґ.

## Phase 4: verify each language before it is released

- **Gate:** `bun run format:check && bun run lint && bun run typecheck && bun test app/tests &&
  bun run build`. Also run the server tests, the agent-computer tests, the mobile typecheck
  (`npm run --prefix mobile typecheck`) and the desktop tests (`cd desktop && bun test`). Run tests
  from the repo root: the app tests need its preload. About 100 server failures from the missing
  `TEST_DATABASE_URL` are the known baseline.
- **Untranslated-text guard:** `app/tests/i18n-enforce.test.ts` must stay green. It catches JSX
  text, text props, `…Label` and `…Description` props, literals in either branch of a
  `?:`, `??` or `&&`, template literals, and label maps both at module level and inside
  components. Mark real code or data with `// i18n-ignore`.
- **Smoke tests per language:** render the sidebar, account menu, search palette, composer,
  Settings General, `/sign`, the Marketplace list and the approvals inbox. Assert glossary labels,
  and that no run of two or more English words appears outside `keep` names.
- **Live check** on the canary instance `s3a8cac305e5` with `?i18n-preview=1`, using the
  chrome-devtools tools at 1440×900 and 390×844:
  - Sweep the main screens in de, fi and hu (longest text), ru and uk (Cyrillic), tr (case
    changes) and fr (punctuation spacing). Spot-check the rest.
  - Look for clipped or overflowing text and leftover English.
  - The Bot answers in the language and a new Bot greets in it; chat cards follow the conversation;
    dates and numbers are local ("12.480" in German, "12 480" in French).
  - Sign-in handoff: the helper is `.e2e-noebot.ts` in
    `/Users/constadean/repos/HyperNoesisAI-noebot-vps`. Run it there, then open the URL within its
    60 seconds in an isolated context.
  - After an instance update, hard-reload: the app keeps the capabilities it loaded and will not
    show new languages until then.
- **Mobile:** Expo dev client on the Android emulator. Check the language list, titles and counted
  plurals (Polish 2, 5 and 22; Russian 1, 2, 5 and 21).
- **Desktop:** tray menu texts per language after `set_ui_locale`.
- **Performance:** the English entry chunk does not grow, and each language loads only its own
  chunks.

## Still English by design

Leave these as they are, and keep them out of every language's coverage counts:

- template names, which are proper names;
- descriptions the model reads (tool descriptions, `.describe()`, prompts, the gallery's
  component descriptions in Admin → Components);
- each Bot's `roleDescription` and instructions;
- third-party text: Composio's directory, the Cursor plugin index, MCP tool descriptions;
- the desktop launcher's native approval dialogs (Rust);
- what code parses: the markers in `shared/handoff-markers.ts` and `shared/component-markers.ts`,
  `REFUSAL_MARKER`, the `Error:` prefix, and the patterns in `stopped-turn.ts`.

## Working rules

- **Where to work:** in a worktree off `origin/main`. Another session commits to this repository
  too; check `git status -sb` before every commit.
- **Commits:** one per language after the plumbing. Commit and push verified work to `main` without
  asking. End each message with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **When finished, report:** each language's coverage, what was verified live and what was not,
  and the open owner decisions.
