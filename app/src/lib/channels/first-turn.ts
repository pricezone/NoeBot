/**
 * The first-turn frame's reader, re-exported from the one place it is declared.
 *
 * A Bot made in one click opens its conversation with a message the deployment wrote for it, and
 * `shared/` is where the server builds that message too. Kept beside `routine-firing.ts` for the
 * same reason: the browser imports through `@/`, and the path to `shared/` is written down once.
 */
export { isFirstTurn } from "../../../../shared/first-turn";
