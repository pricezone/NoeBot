import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { type AppVariables, requireAdmin } from "../auth/guards";
import {
  DecisionConflictError,
  openDecisionSchema,
  type WaitingDecisionStore,
} from "./decisions";
import type { ApprovalService } from "./service";
import {
  ApprovalNotFoundError,
  ApprovalRefusedError,
  ApprovalUnavailableError,
  RULE_BEHAVIOURS,
} from "./types";

const pattern = z.string().trim().min(1).max(300);
/** An action class: which Bot, which tool or app, which kind of effect, and which target. */
const ruleInput = z.strictObject({
  botId: pattern.default("*"),
  toolRef: pattern,
  effect: pattern.default("*"),
  scope: pattern.default("*"),
  behaviour: z.enum(RULE_BEHAVIOURS),
});
const hostCommands = z.enum(["ask", "allow", "never"]);
/** A change to a saved rule: any of its fields, and at least one. */
const ruleChange = z
  .strictObject({
    botId: pattern,
    toolRef: pattern,
    effect: pattern,
    scope: pattern,
    behaviour: z.enum(RULE_BEHAVIOURS),
  })
  .partial()
  .refine(
    (input) => Object.keys(input).length > 0,
    "Change at least one field.",
  );

import { HeadlessToolSuspension } from "../computer/headless-tools";

/**
 * The request body as JSON, with a body that is not JSON answered as the caller's mistake.
 *
 * Caught here, at the one place a request body is parsed, rather than by matching `SyntaxError` in
 * the error handler: that class is also what a JSON parse of a bad *response* throws, deep inside a
 * handler, and matching it there disguised a failing upstream as a malformed request.
 */
async function readBody(context: {
  req: { json: () => Promise<unknown> };
}): Promise<unknown> {
  try {
    return await context.req.json();
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new ApprovalRefusedError("Supply a valid request.");
    throw error;
  }
}

export function createApprovalRoutes(
  service: ApprovalService,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", requireUser);
  routes.onError((error, context) => {
    if (error instanceof ApprovalNotFoundError)
      return context.json({ error: error.message }, 404);
    // Not a mistake: answered already, or the asking tab is gone and the answer must go as a message.
    if (error instanceof DecisionConflictError)
      return context.json({ error: error.message, reason: error.reason }, 409);
    if (error instanceof ApprovalRefusedError || error instanceof z.ZodError)
      return context.json({ error: error.message }, 400);
    // The gate could not reach the conversation service. Not the request's fault, and the same
    // request a moment later may go through, which is what 503 tells a caller.
    if (error instanceof ApprovalUnavailableError)
      return context.json({ error: error.message }, 503);
    /*
     * Logged, because nothing else will be: this used to answer any `SyntaxError` with "Supply a
     * valid request." and 400, on the theory that only a malformed body throws one. A client's
     * `JSON.parse` of a malformed answer from the conversation service throws exactly the same
     * class, and for a day every click a Bot made during a service wobble was reported back as the
     * browser's own mistake, with no line in any log. A malformed body is now caught where the
     * body is read (`readBody` below), so a `SyntaxError` arriving here is a fault to record.
     */
    console.error({
      error: "approval_route_failed",
      context: {
        path: context.req.path,
        name: error instanceof Error ? error.name : "unknown",
        message: error instanceof Error ? error.message : String(error),
      },
      timestamp: new Date().toISOString(),
    });
    return context.json({ error: "The approval could not be processed." }, 500);
  });
  routes.get("/", async (context) =>
    context.json(await service.inbox(context.var.actor.id)),
  );
  routes.post("/computer/:botId", async (context) => {
    try {
      return context.json({
        result: await service.frontendAction(
          context.var.actor.id,
          context.req.param("botId"),
          await readBody(context),
        ),
      });
    } catch (error) {
      if (error instanceof HeadlessToolSuspension)
        return context.json(
          {
            waiting: true,
            approvalId: error.waiting.requestId,
            reason: error.message,
          },
          202,
        );
      throw error;
    }
  });
  routes.patch("/preferences", async (context) => {
    const input = z
      .strictObject({
        enabled: z.boolean().optional(),
        autoReview: z.boolean().optional(),
        hostCommands: hostCommands.optional(),
      })
      .parse(await readBody(context));
    if (!service.store.policy) {
      if (input.enabled === undefined)
        throw new ApprovalRefusedError("Choose whether to ask first.");
      await service.store.setEnabled(context.var.actor.id, input.enabled);
      return context.json({ enabled: input.enabled });
    }
    return context.json(
      await service.setPreferences(context.var.actor.id, input),
    );
  });
  routes.post("/rules", async (context) =>
    context.json(
      {
        rule: await service.createRule(
          context.var.actor.id,
          ruleInput.parse(await readBody(context)),
        ),
      },
      201,
    ),
  );
  routes.patch("/rules/:id", async (context) =>
    context.json({
      rule: await service.updateRule(
        context.var.actor.id,
        context.req.param("id"),
        ruleChange.parse(await readBody(context)),
      ),
    }),
  );
  /** Team rules and settings. Members read them as locked rows in the inbox; only admins change them. */
  routes.patch("/team", async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    const input = z
      .strictObject({
        enforceAutoReview: z.boolean().optional(),
        customRulesEnabled: z.boolean().optional(),
        hostCommandsCap: hostCommands.optional(),
      })
      .parse(await readBody(context));
    return context.json(
      await service.setTeamSettings(context.var.actor.id, input),
    );
  });
  routes.post("/team/rules", async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    return context.json(
      {
        rule: await service.createTeamRule(
          context.var.actor.id,
          ruleInput.parse(await readBody(context)),
        ),
      },
      201,
    );
  });
  routes.patch("/team/rules/:id", async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    return context.json({
      rule: await service.updateTeamRule(
        context.var.actor.id,
        context.req.param("id"),
        ruleChange.parse(await readBody(context)),
      ),
    });
  });
  routes.delete("/team/rules/:id", async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    await service.revokeTeamRule(context.var.actor.id, context.req.param("id"));
    return context.json({ revoked: true });
  });
  /*
   * Answered in the conversation, not here: an option picked on the question's card, or words
   * typed in reply. The screen knows the thread and the question's words, not the saved question's
   * id, so the questions are found by those, among the caller's own.
   */
  routes.post("/questions/answered", async (context) => {
    const input = z
      .strictObject({
        threadId: z.string().trim().min(1).max(200),
        questions: z.array(z.string().trim().min(1).max(6000)).min(1).max(20),
        response: z.string().trim().min(1).max(6000),
      })
      .parse(await readBody(context));
    return context.json(
      await service.answerQuestionsInConversation(context.var.actor.id, input),
    );
  });
  routes.post("/questions/:id/respond", async (context) => {
    const input = z
      .strictObject({ response: z.string().trim().min(1).max(6000) })
      .parse(await readBody(context));
    return context.json(
      await service.answerQuestion(
        context.var.actor.id,
        context.req.param("id"),
        input.response,
      ),
    );
  });
  /*
   * Decision cards a run is waiting on, one record per card, the person's own only. The tab running
   * the turn opens and heartbeats its card; any tab may answer it; the running tab closes it. See
   * `decisions.ts`.
   */
  const decisions = (): WaitingDecisionStore => {
    if (!service.decisions)
      throw new ApprovalRefusedError(
        "Waiting questions are unavailable in this deployment.",
      );
    return service.decisions;
  };
  const toolCallId = (value: string) =>
    z.string().trim().min(1).max(200).parse(value);
  routes.get("/decisions", async (context) => {
    const channelId = context.req.query("channelId")?.trim();
    return context.json({
      decisions: await decisions().list(
        context.var.actor.id,
        channelId ? { channelId } : {},
      ),
    });
  });
  routes.post("/decisions", async (context) =>
    context.json(
      {
        decision: await decisions().open(
          context.var.actor.id,
          openDecisionSchema.parse(await readBody(context)),
        ),
      },
      201,
    ),
  );
  routes.get("/decisions/:toolCallId", async (context) =>
    context.json({
      decision: await decisions().get(
        context.var.actor.id,
        toolCallId(context.req.param("toolCallId")),
      ),
    }),
  );
  routes.post("/decisions/:toolCallId/heartbeat", async (context) =>
    context.json({
      decision: await decisions().heartbeat(
        context.var.actor.id,
        toolCallId(context.req.param("toolCallId")),
      ),
    }),
  );
  routes.post("/decisions/:toolCallId/answer", async (context) => {
    const input = z
      .strictObject({ answer: z.unknown() })
      .parse(await readBody(context));
    return context.json({
      decision: await decisions().answer(
        context.var.actor.id,
        toolCallId(context.req.param("toolCallId")),
        input.answer,
      ),
    });
  });
  routes.post("/decisions/:toolCallId/close", async (context) => {
    const input = z
      .strictObject({ answer: z.unknown().optional() })
      .parse(await readBody(context));
    return context.json({
      decision: await decisions().close(
        context.var.actor.id,
        toolCallId(context.req.param("toolCallId")),
        input.answer,
      ),
    });
  });
  routes.post("/:id/decision", async (context) => {
    const input = z
      .strictObject({
        decision: z.enum(["allow_once", "allow_always", "deny", "handled"]),
      })
      .parse(await readBody(context));
    const request = await service.decide(
      context.var.actor.id,
      context.req.param("id"),
      input.decision,
    );
    return context.json({ id: request.id, status: request.status });
  });
  routes.delete("/rules/:id", async (context) => {
    await service.revoke(context.var.actor.id, context.req.param("id"));
    return context.json({ revoked: true });
  });
  return routes;
}
