import { Hono, type MiddlewareHandler } from "hono";
import type { AppVariables } from "../auth/guards";
import type { TenantTemplate } from "../tenant-package";
import type { AgentProfileStore } from "./profile-store";
import type { AgentActor, AgentProfile } from "./profile-types";
import {
  findMarketplaceItems,
  type MarketplaceSources,
  type MarketplaceViewer,
  marketplaceItem,
  rankTemplates,
} from "./suggestions";

/**
 * The finders over HTTP, at `/api/suggestions`, for the browser.
 *
 * The same rankings a Bot's `find_bot_templates` and `find_marketplace_items` answer with, so a card
 * the Bot put up and anything the app asks agree about what fits. The offer card reads one item from
 * here to draw it: the Bot names an item by id, and what the card shows — its name, what adding it
 * does now, where to connect it — is this deployment's word, never the model's.
 *
 * Every Marketplace read is for a Bot the person can see, because whether an item is listed depends
 * on what that Bot already holds, and that is not something to answer about somebody else's Bot.
 */
export type SuggestionRouteDeps = {
  templates: readonly TenantTemplate[];
  marketplace: MarketplaceSources;
  store: Pick<AgentProfileStore, "get">;
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
};

/** Who is looking, for which Bot, as the Marketplace finder reads it. */
export function marketplaceViewerOf(
  actor: AgentActor,
  bot: Pick<AgentProfile, "id" | "ownerUserId">,
): MarketplaceViewer {
  return {
    actor: { id: actor.id, isAdmin: actor.role === "admin" },
    bot: { id: bot.id, ownerUserId: bot.ownerUserId },
  };
}

export function createSuggestionRoutes(deps: SuggestionRouteDeps) {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.get("/templates", deps.requireUser, (context) =>
    context.json({
      templates: rankTemplates(
        context.req.query("query") ?? "",
        deps.templates,
      ),
    }),
  );

  /** The Bot a Marketplace read is for, or null when the person cannot see it. */
  const viewerFor = async (actor: AgentActor, agentId: string | undefined) => {
    if (!agentId?.trim()) return null;
    const bot = await deps.store.get(actor, agentId.trim());
    return bot ? marketplaceViewerOf(actor, bot) : null;
  };

  routes.get("/marketplace", deps.requireUser, async (context) => {
    const viewer = await viewerFor(
      context.var.actor,
      context.req.query("agentId"),
    );
    if (!viewer) return context.json({ error: "Agent not found." }, 404);
    return context.json({
      items: await findMarketplaceItems(
        context.req.query("query") ?? "",
        deps.marketplace,
        viewer,
      ),
    });
  });

  routes.get("/marketplace/:id", deps.requireUser, async (context) => {
    const viewer = await viewerFor(
      context.var.actor,
      context.req.query("agentId"),
    );
    if (!viewer) return context.json({ error: "Agent not found." }, 404);
    const item = await marketplaceItem(
      context.req.param("id"),
      deps.marketplace,
      viewer,
    );
    if (!item) {
      return context.json(
        { error: "That is not something the Marketplace offers here." },
        404,
      );
    }
    return context.json({ item });
  });

  return routes;
}
