/**
 * Typing a character the desktop's keyboard has no key for.
 *
 * The virtual display's keymap is the US layout, so a person typing Greek ("α", "ή"), an accented
 * letter ("é") or a symbol ("€") presses something no key on the display produces.
 *
 * This used to be `xdotool type`'s job, and it typed none of them. xdotool reads its text in the
 * locale it is started in, and it was started with none: in the C locale every byte of a Greek
 * letter is an "Invalid multi-byte sequence", and the whole text was dropped without a word. Given a
 * UTF-8 locale it does better, but not well enough: it binds the character to a spare keycode,
 * sends the press and puts the keycode back at once. An X client turns a keycode into a character
 * when it reads the event, from the keymap as it is by then, so a client slower than xdotool reads
 * an empty key. Chromium's own remote desktop injector says the same of its spare keycodes: a
 * binding can never be taken back, because nobody can know how long an application takes to look
 * the character up.
 *
 * So a character the keymap lacks is bound to a spare keycode and left bound. The next time it is
 * typed the key is already there; when every spare keycode is in use, the one typed longest ago is
 * bound to the new character instead.
 */

/** Characters the US keymap types itself: printable ASCII and the control characters xdotool maps. */
export function isOnUsKeymap(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  return code < 0x7f;
}

/**
 * The X keysym of one character: Latin-1 by its own code point, everything else in the keysym range
 * X keeps for Unicode (`0x01000000` plus the code point), which every toolkit's keysym-to-text
 * conversion understands.
 */
export function keysymOfCharacter(character: string): number {
  const code = character.codePointAt(0) ?? 0;
  if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff)) {
    return code;
  }
  return 0x01000000 + code;
}

/** The text cut into runs the US keymap types, and runs of characters it does not have. */
export function runsOf(
  text: string,
): Array<{ onKeymap: boolean; text: string }> {
  const runs: Array<{ onKeymap: boolean; text: string }> = [];
  for (const character of text) {
    const onKeymap = isOnUsKeymap(character);
    const last = runs.at(-1);
    if (last && last.onKeymap === onKeymap) last.text += character;
    else runs.push({ onKeymap, text: character });
  }
  return runs;
}

/**
 * Which spare keycode holds which keysym.
 *
 * `bind` answers the keycode for a keysym and whether it still has to be written to the display:
 * the keycode it already holds, or a free one, or the one typed longest ago.
 */
export function spareKeycodes(free: readonly number[]) {
  // Insertion order is the order of last use: a keysym typed again moves to the end.
  const bound = new Map<number, number>();
  const unused = [...free];
  return {
    bind(keysym: number): { keycode: number; fresh: boolean } | null {
      const known = bound.get(keysym);
      if (known !== undefined) {
        bound.delete(keysym);
        bound.set(keysym, known);
        return { keycode: known, fresh: false };
      }
      let keycode = unused.shift();
      if (keycode === undefined) {
        const oldest = bound.entries().next();
        if (oldest.done) return null;
        const [oldKeysym, oldKeycode] = oldest.value;
        bound.delete(oldKeysym);
        keycode = oldKeycode;
      }
      bound.set(keysym, keycode);
      return { keycode, fresh: true };
    },
  };
}

/**
 * The keycodes no key uses, from the display's keymap (`keysymsPerKeycode` keysyms for each keycode
 * from `minimum` on), highest first. xdotool takes the lowest empty keycode for its own moment of
 * borrowing, so the few lowest are left to it.
 */
export function emptyKeycodes(
  keysyms: ArrayLike<bigint | number>,
  keysymsPerKeycode: number,
  minimum: number,
  leaveForXdotool = 4,
): number[] {
  const empty: number[] = [];
  const count = Math.floor(keysyms.length / keysymsPerKeycode);
  for (let index = 0; index < count; index++) {
    let isEmpty = true;
    for (let column = 0; column < keysymsPerKeycode; column++) {
      if (Number(keysyms[index * keysymsPerKeycode + column]) !== 0) {
        isEmpty = false;
        break;
      }
    }
    if (isEmpty) empty.push(minimum + index);
  }
  return empty.slice(leaveForXdotool).reverse();
}
