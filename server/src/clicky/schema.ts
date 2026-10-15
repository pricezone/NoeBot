import { z } from "zod";
import {
  CLICKY_MODES,
  CLICKY_OVERLAY_LIMIT,
  CLICKY_TEXT_LIMIT,
  type ClickyCommand,
  type ClickyOverlay,
  type ClickyTrigger,
} from "../../../shared/clicky";
import { COMPUTER_GUIDE_PERSON_STEP_LIMIT } from "../../../shared/clicky-tools";

/**
 * What a client may send Clicky, checked strictly before it reaches the state machine.
 *
 * The protocol's types live in `shared/clicky.ts`, which has no dependencies; these are their zod
 * twins. Strict objects, so a field nobody defined is a 400 rather than something quietly carried
 * along, and every number that lands on the screen is a finite fraction of it.
 */

const unit = z.number().min(0).max(1);
const point = z.strictObject({ x: unit, y: unit });
const id = z.string().trim().min(1).max(100);
const label = z.string().trim().min(1).max(200);
const text = z.string().max(CLICKY_TEXT_LIMIT);

const overlay = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("pointer"),
    id,
    at: point,
    label: label.optional(),
    approximate: z.boolean().optional(),
  }),
  z.strictObject({
    kind: z.literal("marker"),
    id,
    at: point,
    index: z.number().int().min(0).max(99),
    label: label.optional(),
  }),
  z.strictObject({
    kind: z.literal("highlight"),
    id,
    rect: z
      .strictObject({ x: unit, y: unit, width: unit, height: unit })
      .refine((rect) => rect.x + rect.width <= 1 && rect.y + rect.height <= 1, {
        message: "A highlight must fit on the screen.",
      }),
    label: label.optional(),
  }),
  z.strictObject({
    kind: z.literal("caption"),
    id,
    at: point.optional(),
    text: z.string().trim().min(1).max(500),
  }),
]) satisfies z.ZodType<ClickyOverlay>;

/**
 * A client opens Clicky for the person only. The Bot needing them (a handover, a sign-in, a secret,
 * a challenge) is something the server says, from its own events: a client that could claim one
 * could put a "Noë Bot needs you" with any words on the person's screen.
 */
const trigger = z.strictObject({
  kind: z.literal("person"),
  reason: z.string().trim().max(500).optional(),
}) satisfies z.ZodType<ClickyTrigger>;

export const clickyCommandSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("wake") }),
  z.strictObject({ type: z.literal("sleep") }),
  z.strictObject({ type: z.literal("listen"), active: z.boolean() }),
  z.strictObject({ type: z.literal("ask"), text }),
  z.strictObject({ type: z.literal("show_me") }),
  z.strictObject({ type: z.literal("next") }),
  z.strictObject({ type: z.literal("back") }),
  z.strictObject({ type: z.literal("repeat") }),
  z.strictObject({
    type: z.literal("approve"),
    proposalId: id,
    scope: z.enum(["once", "session", "task"]),
  }),
  z.strictObject({ type: z.literal("deny"), proposalId: id }),
  z.strictObject({ type: z.literal("stop") }),
  z.strictObject({ type: z.literal("pause") }),
  z.strictObject({ type: z.literal("resume") }),
  z.strictObject({ type: z.literal("retry") }),
  z.strictObject({ type: z.literal("set_mode"), mode: z.enum(CLICKY_MODES) }),
  z.strictObject({ type: z.literal("activate"), trigger }),
  z.strictObject({
    type: z.literal("overlay.set"),
    overlays: z.array(overlay).max(CLICKY_OVERLAY_LIMIT),
  }),
  z.strictObject({ type: z.literal("overlay.clear") }),
  z.strictObject({ type: z.literal("save_notes") }),
]) satisfies z.ZodType<ClickyCommand>;

/** `POST /:botId/clicky/guide`: the Bot's walkthrough, one short line per step and what to point at. */
export const clickyGuideSchema = z.strictObject({
  goal: z.string().trim().min(1).max(200),
  steps: z
    .array(
      z.strictObject({
        say: z.string().trim().min(1).max(300),
        ref: z
          .string()
          .regex(/^[A-Za-z0-9_-]{1,64}$/)
          .optional(),
      }),
    )
    .min(1)
    .max(COMPUTER_GUIDE_PERSON_STEP_LIMIT),
});

export type ClickyGuideInput = z.output<typeof clickyGuideSchema>;

/** A parsed body or the reason it was refused, for a 400. */
export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

export function parseClickyCommand(body: unknown): Parsed<ClickyCommand> {
  const parsed = clickyCommandSchema.safeParse(body);
  if (parsed.success) return { ok: true, value: parsed.data };
  return { ok: false, error: describeIssue(parsed.error) };
}

export function parseClickyGuide(body: unknown): Parsed<ClickyGuideInput> {
  const parsed = clickyGuideSchema.safeParse(body);
  if (parsed.success) return { ok: true, value: parsed.data };
  return { ok: false, error: describeIssue(parsed.error) };
}

/** The first problem, where it is, in a sentence: enough for the person writing the client. */
function describeIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  const where = issue?.path.length ? issue.path.join(".") : "the body";
  return `Clicky could not read ${where}: ${issue?.message ?? "invalid"}.`;
}
