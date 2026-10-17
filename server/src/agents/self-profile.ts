/**
 * A Bot changing its own name and one-line role.
 *
 * The role is written as the role description and as the title, the line the roster shows under
 * the name, so "General assistant" does not sit stale beside a name chosen for something else. How
 * the Bot works is not in the role (`WORKING_GUIDANCE`), so replacing it loses nothing but the role.
 *
 * A Bot made in one click is "New Bot" until somebody renames it, and the person who just told it
 * what it is for is the last person who wants a form to fill in. So the Bot, once it knows, names
 * itself: through the same validation and the same write as the profile form (`PATCH
 * /api/agents/:agentId`), recorded in the trail as the same `bot.updated` row, and only ever its
 * own profile. The conversation shows the change with an Undo, which goes back through that route.
 *
 * Offered to Bots that run here and not to remote ones: a remote Bot's tools execute through the
 * signed callback, which does not carry this one (`copilot.ts` leaves it out of what they see).
 */

import { z } from "zod";
import {
  SELF_PROFILE_NAME_MAX,
  SELF_PROFILE_ROLE_MAX,
  SELF_PROFILE_TOOL,
  type SelfProfileChange,
  shortenedWordIn,
} from "../../../shared/self-profile";
import { type AuditStore, recordAuditEvent } from "../audit";
import { type GrantedTool, REFUSAL_MARKER } from "../plugins/tools";
import type { RunAssertion } from "./callback-token";
import type { AgentProfileStore } from "./profile-store";
import type { AgentActor } from "./profile-types";
import { parseAgentInput } from "./routes";

export { SELF_PROFILE_TOOL };

const parameters = z.object({
  name: z
    .string()
    .optional()
    .describe(
      `Your new name: one or two whole words in the person's language, never shortened or abbreviated, at most ${SELF_PROFILE_NAME_MAX} characters`,
    ),
  role: z
    .string()
    .optional()
    .describe(
      `Your new role: one line saying what you do for the person, at most ${SELF_PROFILE_ROLE_MAX} characters. It is also the title shown under your name`,
    ),
});

/** A refusal, in the shape every server tool refuses in, so the transcript draws it as one. */
const refuse = (sentence: string) => `${REFUSAL_MARKER} ${sentence}`;

/** Why the store would not take the edit, in words the model can repeat. */
function refusalFor(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  if (name === "AgentNotFoundError")
    return refuse("Nothing was changed: your profile could not be found.");
  if (name === "ProtectedAgentError" || name === "AgentNotManageableError")
    return refuse(
      "Nothing was changed: your name and role are set by whoever manages you, not by you. Suggest them to the person instead.",
    );
  return refuse(
    "Nothing was changed: your profile could not be saved just now. Suggest the name and role to the person instead.",
  );
}

/** A name folded for comparing: no case, no accents, single spaces. */
const folded = (name: string) =>
  name
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

/** The app's own name, in the spellings a Bot reaches for: a Bot called that reads as the app. */
const APP_NAMES = new Set(["noe", "noe bot", "noebot"]);

export function selfProfileTool(options: {
  /** The run doing the renaming, as this deployment resolved it: the Bot and the person it runs as. */
  run: Pick<RunAssertion, "botId" | "actorId" | "runId" | "initiator">;
  store: Pick<AgentProfileStore, "get" | "update"> &
    Partial<Pick<AgentProfileStore, "list">>;
  actorFor: (actorId: string) => Promise<AgentActor>;
  auditStore?: AuditStore;
}): GrantedTool {
  const { run, store, actorFor, auditStore } = options;

  return {
    name: SELF_PROFILE_TOOL,
    ref: `bot/${SELF_PROFILE_TOOL}`,
    description:
      "Change your own name and one-line role, the ones the person sees in the sidebar and in your " +
      "profile. Use it once you know what the person wants you for. A name is one or two whole " +
      "words in their language, never abbreviated or cut short; a role is one line, and it is also " +
      "the title shown under your name. Only your own " +
      "profile changes, and the person sees the change and can undo it.",
    parameters,
    execute: async (args: unknown) => {
      const parsed = parameters.safeParse(args);
      if (!parsed.success)
        return refuse("Nothing was changed: give a name, a role, or both.");
      const name = parsed.data.name?.replace(/\s+/g, " ").trim() || undefined;
      const role = parsed.data.role?.replace(/\s+/g, " ").trim() || undefined;
      if (!name && !role)
        return refuse("Nothing was changed: give a name, a role, or both.");
      if (name && name.length > SELF_PROFILE_NAME_MAX)
        return refuse(
          `Nothing was changed: a name is at most ${SELF_PROFILE_NAME_MAX} characters. Choose one or two whole words and call ${SELF_PROFILE_TOOL} again.`,
        );
      /*
       * The role is the title too, so it must fit the title's limit. Refused rather than cut: a
       * title cut to fit ends mid-word, which is the thing a name is refused for below.
       */
      if (role && role.length > SELF_PROFILE_ROLE_MAX)
        return refuse(
          `Nothing was changed: a role is at most ${SELF_PROFILE_ROLE_MAX} characters, because it is also the title shown under your name. Say it in one shorter line and call ${SELF_PROFILE_TOOL} again.`,
        );
      const shortened = name ? shortenedWordIn(name) : null;
      if (shortened)
        return refuse(
          `Nothing was changed: "${shortened}" is a shortened word, and a name is made of whole words. Write the word out in full (or choose a shorter whole word) and call ${SELF_PROFILE_TOOL} again.`,
        );

      if (name && APP_NAMES.has(folded(name)))
        return refuse(
          `Nothing was changed: "${name}" is the app's own name, and a Bot called that reads as the app. Choose another name and call ${SELF_PROFILE_TOOL} again.`,
        );

      let actor: AgentActor;
      try {
        actor = await actorFor(run.actorId);
      } catch (error) {
        return refusalFor(error);
      }
      if (name && store.list) {
        // Another of the person's Bots by that name is two Bots they cannot tell apart.
        const others = await store.list(actor).catch(() => []);
        const taken = others.find(
          (other) =>
            other.id !== run.botId && folded(other.name) === folded(name),
        );
        if (taken)
          return refuse(
            `Nothing was changed: the person already has a Bot called "${taken.name}". Choose a name of your own and call ${SELF_PROFILE_TOOL} again.`,
          );
      }
      const profile = await store.get(actor, run.botId).catch(() => null);
      if (!profile)
        return refuse("Nothing was changed: your profile could not be found.");
      if (profile.endpoint !== null)
        return refuse(
          "Nothing was changed: only a Bot that runs here can rename itself.",
        );

      /*
       * The form's own validation, on the whole profile as it will be saved: the fields this tool
       * does not touch go back exactly as they are, the way the form sends every field every time.
       */
      const input = parseAgentInput({
        name: name ?? profile.name,
        title: role ?? profile.title,
        roleDescription: role ?? profile.roleDescription,
        visibility: profile.visibility,
      });
      if (!input.ok) return refuse(`Nothing was changed: ${input.error}`);

      let updated: Awaited<ReturnType<typeof store.update>>;
      try {
        updated = await store.update(actor, run.botId, input.value);
      } catch (error) {
        return refusalFor(error);
      }

      /*
       * The row the form's edit writes, with who did it: the Bot, in a run of the person it runs as.
       * Never fatal, as in the route: the change is made, and a trail briefly unavailable is not a
       * reason to tell the Bot it failed.
       */
      if (auditStore) {
        try {
          await recordAuditEvent(auditStore, {
            eventType: "bot.updated",
            targetType: "agent",
            targetId: run.botId,
            actorUserId: run.actorId,
            ...(run.initiator ? { initiator: run.initiator } : {}),
            payload: {
              bot: run.botId,
              name: updated.name,
              visibility: updated.visibility,
              by: "bot",
              run: run.runId,
              ...(updated.name !== profile.name
                ? { previousName: profile.name }
                : {}),
              ...(updated.roleDescription !== profile.roleDescription
                ? { roleChanged: true }
                : {}),
            },
          });
        } catch (error) {
          console.error(
            JSON.stringify({
              type: "bot-audit-write-failed",
              eventType: "bot.updated",
              agentId: run.botId,
              error: String(error),
            }),
          );
        }
      }

      const change: SelfProfileChange = {
        updated: true,
        bot: run.botId,
        name: updated.name,
        role: updated.roleDescription,
        title: updated.title,
        previous: {
          name: profile.name,
          role: profile.roleDescription,
          title: profile.title,
        },
        note: "Your profile now says this. The person sees the change in the conversation and can undo it; carry on with what they asked.",
      };
      return JSON.stringify(change);
    },
  };
}
