/**
 * The Bot's side of Clicky: what a Bot may call to have Clicky show the person something.
 *
 * Names and model-facing descriptions only, shared so the server's in-run tools
 * (`server/src/computer/headless-tools.ts`) and the browser's (`app/src/lib/copilot/computer-tools.tsx`)
 * say exactly the same thing; each side builds its own zod schema from these. Model-facing text is
 * never translated.
 */

export const COMPUTER_GUIDE_PERSON_TOOL = "computer_guide_person";

export const COMPUTER_GUIDE_PERSON_DESCRIPTION =
  "Show the person, on your computer's screen, exactly where to look and what to do, as short steps " +
  "with Show me how (the on-screen guide) pointing at each element. Use it when the person has to do something on the screen " +
  "themselves (sign in, enter a code, pick a file, confirm a payment) or asks how to do something. It " +
  "draws on the person's view only: it does not click, type or change the page, and the person may " +
  "ignore it.";

export const COMPUTER_GUIDE_PERSON_GOAL_DESCRIPTION =
  "What the person is doing, in a few words in their language, e.g. 'Sign in to your bank'.";

export const COMPUTER_GUIDE_PERSON_STEPS_DESCRIPTION =
  "One to eight steps, in order. Each says what to do in one short sentence in the person's language " +
  "and names the element from your latest snapshot to point at, when there is one.";

export const COMPUTER_GUIDE_PERSON_SAY_DESCRIPTION =
  "The step, in one short sentence, e.g. 'Type your user ID here.'";

export const COMPUTER_GUIDE_PERSON_REF_DESCRIPTION =
  "The ref of the element this step is about, from your latest snapshot. Leave it out when the step is not about one element.";

/** The optional field `computer_request_help` gains, so Clicky can point while the person helps. */
export const POINT_AT_FIELD = "point_at";

export const POINT_AT_DESCRIPTION =
  "The ref of the element the person should use first, from your latest snapshot, so Show me how can point at it. Leave it out when there is no such element.";

export const COMPUTER_GUIDE_PERSON_STEP_LIMIT = 8;
