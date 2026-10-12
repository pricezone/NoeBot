# Noë Bot animations

The character every avatar, icon and chat indicator in the app draws is the 14 × 12 pixel Noë Bot
from the design handoff "Noe Bot Terminal Animation" (claude.ai/design project
`6679ec14-c827-45a8-b314-417e216c326a`, `design_handoff_noe_bot_avatar/`). The engine that draws it
lives in `app/src/components/noe-bot/anim/` and is a port of the design's film sources
(`noe-bot-film.jsx`, `noe-bot-film-hd.jsx`); the rule tables are the design's `avatar-map.json`,
copied verbatim.

## Engine

| File | What it holds |
|---|---|
| `pixels.ts` | the 18 brand-sheet faces as half-block rows, ears, hands, legs, idle motion |
| `exprs.ts` | the 35 newer faces (hole grids + per-frame effects), dizzy and cool, `FACES` for all 55 |
| `acts.ts` | the 20 actions and 9 states, their face cues, and `SEQUENCES` (loop lengths, segments) |
| `bot-frame.ts` | `renderBotFrame({animation, t, …})` — one frame as a pure function of time |
| `catalog.ts` | animation ids (`face:<id>`, `action:<id>`, `state:<id>`, `boot`, `rest`), labels (en/el), face groups |
| `palette.ts` | the design's inks, and the avatar palette (face in the scheme's ink on its background) |
| `clock.ts` | one shared `requestAnimationFrame` clock for every sprite on the page |
| `noe-bot-sprite.tsx` | the React sprite: cells joined into paths, `viewBox="-1 -2 16 16"` |
| `director.ts`, `tool-map.ts`, `intent.ts` | the chat indicator's state machine and its classifiers |

Size rules (from the design): under 24 px a still; 24–47 px terminal mode (whole cells, 12 fps,
face + ears + blink, no props); 48 px and up HD with props. `NoeBotFace` and `NoeBotAvatar` apply
them; a roster avatar only moves while the Bot is busy or under the pointer, a large one (bot panel,
cards, the picker) whenever it is on screen. `prefers-reduced-motion` shows a still plus the label.

## Chat indicator

`ChatActivityIndicator` sits under the last message for the whole turn. `useAvatarDirector` turns
the transcript's signals (busy, waiting on the first token, the tool in flight, streaming text, the
person's last words, how the turn stopped) into a phase, an animation and a label:

- a 600 ms tone reaction to the message, then the intent's sequence while the model thinks, pensive
  after 4 s;
- the running tool's animation from `tool-map.ts` (the truthful signal), with a breather every 6 s
  after 12 s on one loop and the over-caffeinated state after 30 s;
- `action:type` while the reply streams, `face:pleading` while the Bot waits for the person;
- `state:success` → `face:happy` when the turn ends, or the outcome of how it stopped.

Every animation shows for at least 1.2 s; a tool name must stay for 250 ms to be believed. Labels
follow the language of the person's message (Greek script → Greek).

## Changing a Bot's look

Click the avatar in the bot panel, on the Bot's page or in Manage › Profile (`AvatarChooser`):
every face in the design's groups on the Bot's colour, then the palette. `shared/avatar.ts` lists
what the server accepts (`AVATAR_EXPRESSIONS`, the 55) and what a seed may pick
(`SEED_EXPRESSIONS`, the original fifteen names in their original order).
