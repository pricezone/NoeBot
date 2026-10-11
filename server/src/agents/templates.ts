import { Hono, type MiddlewareHandler } from "hono";
import { type AuditStore, recordAuditEvent } from "../audit";
import type { AppVariables } from "../auth/guards";
import { catalogueEntry } from "../plugins/catalogue";
import { pluginIndexEntry } from "../plugins/plugin-index";
import type { TenantTemplate } from "../tenant-package";
import type { AgentProfileStore } from "./profile-store";
import type { AgentActor, AgentProfile } from "./profile-types";

/**
 * Bot templates: the Bots a person starts from, as the Agents tab lists them.
 *
 * Read off the loaded tenant package and never off a table, because a template is content the
 * package ships — the way its skills and its stock coworkers are — and a deployment that edits the
 * file gets the edit on the next boot. Adding one is the one write: a private Bot for the person,
 * with the template's instructions as its prompt, its avatar as chosen, and its package skills
 * granted. The routines and the apps are told on the template's page and not set up, because a
 * Bot schedules its own routines and a person connects their own apps.
 *
 * Mounted at `/api/bot-templates` rather than under `/api/agents`, where `GET /:agentId` is
 * registered first and would read `templates` as a Bot's id.
 */

/** One app a template names, as the page draws it: whether it is already here, and its mark. */
export type TemplateApp = {
  key: string;
  title: string;
  logoUrl: string | null;
  /** Whether this deployment already has it: enabled, connected or installed by somebody. */
  installed: boolean;
  /** Where to send somebody to add it: the Marketplace, searched by name. */
  kind: "catalogue" | "plugin";
};

export type TemplateRouteDeps = {
  templates: readonly TenantTemplate[];
  store: AgentProfileStore;
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
  /**
   * Grant a package skill to the new Bot, on the package's authority.
   *
   * The generic grant route refuses a member attaching a workspace skill to their own Bot; here
   * the package wrote both the skill and the template that names it, which is the reason the
   * package may seed skills onto its stock coworkers at all. The same reasoning, one Bot later.
   */
  grantSkill: (slug: string, agentId: string, by: string) => Promise<void>;
  /** Whether an app is already here: a server row for a catalogue key, or an installed plugin. */
  appInstalled: (key: string) => Promise<boolean>;
  /** The Bot as `/api/agents` answers it, so a template's Bot is the same shape as any other. */
  dto: (actor: AgentActor, agent: AgentProfile) => Record<string, unknown>;
  auditStore?: AuditStore;
};

export function createTemplateRoutes(deps: TemplateRouteDeps) {
  const routes = new Hono<{ Variables: AppVariables }>();

  const appFor = async (key: string): Promise<TemplateApp> => {
    const entry = catalogueEntry(key);
    if (entry) {
      return {
        key,
        title: entry.title,
        logoUrl: null,
        installed: await deps.appInstalled(key),
        kind: "catalogue",
      };
    }
    const plugin = pluginIndexEntry(key);
    return {
      key,
      title: plugin?.displayName ?? key,
      logoUrl: plugin?.logoUrl ?? null,
      installed: await deps.appInstalled(key),
      kind: "plugin",
    };
  };

  /** Every template, with its skills and apps expanded to what the page draws. */
  routes.get("/", deps.requireUser, async (context) => {
    const templates = await Promise.all(
      deps.templates.map(async (template) => ({
        id: template.id,
        name: template.name,
        title: template.title,
        creator: template.creator,
        categories: template.categories,
        summary: template.summary,
        description: template.description,
        instructions: template.instructions,
        avatar: template.avatar,
        skills: template.skills,
        apps: await Promise.all(template.apps.map(appFor)),
        routines: template.routines,
        featured: template.featured,
      })),
    );
    return context.json({ templates });
  });

  /**
   * Add a template: a private Bot of the person's, from it.
   *
   * The Bot is created the way `POST /api/agents` creates one with no endpoint — built in, running
   * on the instructions — then given the avatar and the skills. A skill the package no longer
   * ships is skipped rather than failing the Bot: the package validated the template against its
   * skills at boot, so that is a race with an edit, not a state to refuse over.
   */
  routes.post("/:id/add", deps.requireUser, async (context) => {
    const template = deps.templates.find(
      (candidate) => candidate.id === context.req.param("id"),
    );
    if (!template) {
      return context.json(
        { error: `${context.req.param("id")} is not a Bot template here.` },
        404,
      );
    }
    const actor = context.var.actor;
    const by = actor.email ?? actor.id;

    let agent = await deps.store.create(actor, {
      name: template.name,
      title: template.title,
      roleDescription: template.summary,
      visibility: "private",
      systemPrompt: template.instructions,
    });
    agent = await deps.store.setAvatar(actor, agent.id, {
      avatarColor: template.avatar.color,
      avatarExpression: template.avatar.expression,
    });
    const granted: string[] = [];
    for (const slug of template.skills) {
      try {
        await deps.grantSkill(slug, agent.id, by);
        granted.push(slug);
      } catch (error) {
        console.error(
          JSON.stringify({
            type: "template-skill-not-granted",
            template: template.id,
            skill: slug,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }

    if (deps.auditStore) {
      await recordAuditEvent(deps.auditStore, {
        eventType: "bot.created",
        targetType: "agent",
        targetId: agent.id,
        actorUserId: actor.id,
        payload: {
          bot: agent.id,
          actor: by,
          name: template.name,
          visibility: "private",
          hasKey: false,
          template: template.id,
          skills: granted,
        },
      }).catch(() => undefined);
    }

    return context.json(
      { agent: deps.dto(actor, agent), skills: granted },
      201,
    );
  });

  return routes;
}
