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
| `palette.ts` | the design's inks; `THEMED_PALETTE` + `THEMED_INK_CLASS` for a coloured Noë Bot on the page (body `currentColor`, props in theme greys) |
| `use-eye-shift.ts` | the pointer's pull on the eyes: `follow: "hover"` (avatars, 1.5 s linger) or `"page"` (the deploy form's mascot) |
| `clock.ts` | one shared `requestAnimationFrame` clock for every sprite on the page |
| `noe-bot-sprite.tsx` | the React sprite: cells joined into paths, `viewBox="-1 -2 16 16"` |
| `director.ts`, `tool-map.ts`, `intent.ts` | the chat indicator's state machine and its classifiers |

Size rules (from the design): under 24 px a still; 24–47 px terminal mode (whole cells, 12 fps,
face + ears + blink, no props); 48 px and up HD with props. `NoeBotFace` and `NoeBotAvatar` apply
them (an avatar is a still only under 16 px, so a roster face can look at the pointer); a roster
avatar only moves while the Bot is busy or under the pointer, a large one (bot panel, cards, the
picker) whenever it is on screen. `prefers-reduced-motion` shows a still plus the label.

**No disc.** Every Noë Bot is the character alone, standing on the page: the Bot's colour (the
stored `avatarColor`, or the seed's) paints the body, the eye holes show whatever is behind, and the
character fills the avatar's box. The two colours that vanish into one theme's page — near-black on
dark, light grey on light — get a one-pixel outline there only (`hairlineClassName(colour,
"outline")`); the colour itself is never swapped.

**Eyes that look.** `renderBotFrame`'s `eyeShift` moves the eye holes (and the props that are eyes —
hearts, stars, shades) by whole cells inside the eye region; a glance is not a change of face, so it
never flashes. Avatars follow a hovering pointer and keep watching it for 1.5 s after it leaves; the
www deploy form's mascot follows the pointer anywhere on the page. Touch and reduced motion: none.

## Chat indicator

`ChatActivityIndicator` sits under the last message for the whole turn, like Grok's status row: the
Bot's own character in its colour, a 32 px box (2 px per cell), inline with the label, with nothing
behind it. The animation is the director's, in HD with its props; the label starts 24 px after the
box, the room the props on the right need. `useAvatarDirector` turns
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
every face in the design's groups drawn in the Bot's colour, then the palette, which recolours the
character itself. `shared/avatar.ts` lists
what the server accepts (`AVATAR_EXPRESSIONS`, the 55) and what a seed may pick
(`SEED_EXPRESSIONS`, the original fifteen names in their original order).

## Fidelity notes

- `action:search` in HD holds the lens in the right hand at `(14.5 + sweep, 7.9 − crouch − lift·2.2)`,
  from the HD film's `props`. The terminal film also carries a dead `oldProps` with `ox = oy = 0`;
  copying it once pinned the lens to the top-left of the head. The study, type, game and music HD
  branches were audited against `noe-bot-film-hd.jsx` and match.
