import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { createTemplateRoutes } from "../src/agents/templates";
import type { AgentProfile } from "../src/agents/profile-types";
import type { AppVariables } from "../src/auth/guards";
import type { TenantTemplate } from "../src/tenant-package";

/**
 * `/api/bot-templates`: the templates as the Agents tab lists them, and Add, which makes a
 * private Bot for the person out of one — prompt, avatar and skills — on the package's authority.
 */

function signedIn(
  role: "user" | "admin" = "user",
): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    context.set("actor", {
      id: "user-1",
      email: "person@openbot.test",
      role,
    } as never);
    await next();
  };
}

const TEMPLATE: TenantTemplate = {
  id: "research-desk",
  name: "Research Desk",
  title: "Briefings",
  creator: "Noë Bot Team",
  categories: ["From Noë Bot Team", "Operations"],
  summary: "Reads around a question.",
  description: "A longer description.",
  instructions: "You are Research Desk.",
  avatar: { color: "#ff2056", expression: "attentive" },
  skills: ["research-public-web", "check-a-claim"],
  apps: ["parallel", "55647425"],
  routines: [{ name: "Morning brief", summary: "Weekdays at 08:00." }],
  featured: true,
};

function harness(input: { grantFails?: string } = {}) {
  const created: unknown[] = [];
  const avatars: unknown[] = [];
  const granted: { slug: string; agentId: string; by: string }[] = [];
  const profile = (overrides: Partial<AgentProfile> = {}): AgentProfile =>
    ({
      id: "agent-new",
      name: TEMPLATE.name,
      title: TEMPLATE.title,
      roleDescription: TEMPLATE.summary,
      avatarSeed: "agent-new",
      avatarColor: null,
      avatarExpression: null,
      visibility: "private",
      endpoint: "https://managed.example/agent",
      ...overrides,
    }) as AgentProfile;
  const store = {
    create: async (_actor: unknown, request: unknown) => {
      created.push(request);
      return profile();
    },
    setAvatar: async (_actor: unknown, id: string, choice: unknown) => {
      avatars.push({ id, choice });
      return profile({
        avatarColor: TEMPLATE.avatar.color,
        avatarExpression: TEMPLATE.avatar.expression,
      });
    },
  };
  const routes = createTemplateRoutes({
    templates: [TEMPLATE],
    store: store as never,
    requireUser: signedIn(),
    grantSkill: async (slug, agentId, by) => {
      if (slug === input.grantFails) throw new Error("skill is gone");
      granted.push({ slug, agentId, by });
    },
    installedApps: async () => new Set(["parallel"]),
    dto: (_actor, agent) => ({ id: agent.id, name: agent.name, builtIn: true }),
  });
  const app = new Hono().route("/api/bot-templates", routes);
  return {
    created,
    avatars,
    granted,
    request: (path: string, init?: RequestInit) =>
      app.request(`http://openbot.example/api/bot-templates${path}`, init),
  };
}

describe("listing templates", () => {
  test("expands the apps to what the page draws, and says which are already here", async () => {
    const { request } = harness();
    const response = await request("");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      templates: Record<string, unknown>[];
    };
    expect(body.templates).toHaveLength(1);
    expect(body.templates[0]).toMatchObject({
      id: "research-desk",
      creator: "Noë Bot Team",
      featured: true,
      skills: ["research-public-web", "check-a-claim"],
      apps: [
        {
          key: "parallel",
          title: "Parallel Search",
          installed: true,
          kind: "catalogue",
        },
        { key: "55647425", title: "Treg", installed: false, kind: "plugin" },
      ],
      routines: [{ name: "Morning brief", summary: "Weekdays at 08:00." }],
    });
  });
});

describe("adding a template", () => {
  test("makes a private built-in Bot from the instructions, with the avatar and the skills", async () => {
    const { created, avatars, granted, request } = harness();
    const response = await request("/research-desk/add", { method: "POST" });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      agent: { id: "agent-new", name: "Research Desk", builtIn: true },
      skills: ["research-public-web", "check-a-claim"],
    });
    expect(created).toEqual([
      {
        name: "Research Desk",
        title: "Briefings",
        roleDescription: "Reads around a question.",
        visibility: "private",
        systemPrompt: "You are Research Desk.",
      },
    ]);
    expect(avatars).toEqual([
      {
        id: "agent-new",
        choice: { avatarColor: "#ff2056", avatarExpression: "attentive" },
      },
    ]);
    expect(granted).toEqual([
      {
        slug: "research-public-web",
        agentId: "agent-new",
        by: "person@openbot.test",
      },
      {
        slug: "check-a-claim",
        agentId: "agent-new",
        by: "person@openbot.test",
      },
    ]);
  });

  test("a skill that could not be granted is left out, and the Bot still arrives", async () => {
    const { granted, request } = harness({ grantFails: "check-a-claim" });
    const response = await request("/research-desk/add", { method: "POST" });
    expect(response.status).toBe(201);
    expect((await response.json()).skills).toEqual(["research-public-web"]);
    expect(granted.map((grant) => grant.slug)).toEqual(["research-public-web"]);
  });

  test("an unknown template is a 404", async () => {
    const { created, request } = harness();
    expect((await request("/nope/add", { method: "POST" })).status).toBe(404);
    expect(created).toEqual([]);
  });
});

/**
 * Applying a template to a Bot that already exists: the job (title, instructions, skills), the face
 * and the name only where the person has not chosen their own, the same access as editing the Bot,
 * and a `bot.updated` row naming the template.
 */
function applying(
  input: {
    bot?: Partial<AgentProfile> | null;
    role?: "user" | "admin";
    grantFails?: string;
  } = {},
) {
  const updates: { id: string; input: Record<string, unknown> }[] = [];
  const granted: string[] = [];
  const audit: { eventType: string; payload: unknown; actor?: string }[] = [];
  const bot: AgentProfile | null =
    input.bot === null
      ? null
      : ({
          id: "agent-1",
          name: "New Bot",
          title: "General assistant",
          roleDescription: "Help with whatever.",
          avatarSeed: "agent-1",
          avatarColor: null,
          avatarExpression: null,
          visibility: "private",
          ownerUserId: "user-1",
          systemOwned: false,
          deletedAt: null,
          endpoint: null,
          ...input.bot,
        } as AgentProfile);
  const store = {
    get: async () => bot,
    update: async (
      _actor: unknown,
      id: string,
      request: Record<string, unknown>,
    ) => {
      updates.push({ id, input: request });
      return { ...bot, ...request, id } as AgentProfile;
    },
  };
  const routes = createTemplateRoutes({
    templates: [TEMPLATE],
    store: store as never,
    requireUser: signedIn(input.role),
    grantSkill: async (slug) => {
      if (slug === input.grantFails) throw new Error("skill is gone");
      granted.push(slug);
    },
    installedApps: async () => new Set(),
    dto: (_actor, agent) => ({ id: agent.id, name: agent.name }),
    auditStore: {
      insert: async (event) =>
        void audit.push({
          eventType: event.eventType,
          payload: event.payload,
          ...(event.actorUserId ? { actor: event.actorUserId } : {}),
        }),
    },
  });
  const app = new Hono().route("/api/bot-templates", routes);
  return {
    updates,
    granted,
    audit,
    apply: (template = "research-desk", agent = "agent-1") =>
      app.request(
        `http://openbot.example/api/bot-templates/${template}/apply/${agent}`,
        { method: "POST" },
      ),
  };
}

describe("applying a template to an existing Bot", () => {
  test("a default-named Bot with no chosen avatar takes the whole template", async () => {
    const { updates, granted, audit, apply } = applying();
    const response = await apply();
    expect(response.status).toBe(200);
    expect(updates).toEqual([
      {
        id: "agent-1",
        input: {
          name: "Research Desk",
          title: "Briefings",
          roleDescription: "You are Research Desk.",
          visibility: "private",
          avatarColor: "#ff2056",
          avatarExpression: "attentive",
        },
      },
    ]);
    expect(granted).toEqual(["research-public-web", "check-a-claim"]);
    expect((await response.json()).applied).toEqual({
      name: "Research Desk",
      renamed: true,
      title: "Briefings",
      instructions: true,
      avatar: true,
      skills: ["research-public-web", "check-a-claim"],
      failedSkills: [],
    });
    expect(audit).toEqual([
      {
        eventType: "bot.updated",
        actor: "user-1",
        payload: {
          bot: "agent-1",
          actor: "person@openbot.test",
          name: "Research Desk",
          visibility: "private",
          template: "research-desk",
          renamed: true,
          avatar: true,
          skills: ["research-public-web", "check-a-claim"],
        },
      },
    ]);
  });

  test("the Greek default name counts as the default too", async () => {
    const { updates, apply } = applying({ bot: { name: "Νέος Bot" } });
    expect((await apply()).status).toBe(200);
    expect(updates[0]?.input.name).toBe("Research Desk");
  });

  test("a name and an avatar the person chose are kept", async () => {
    const { updates, apply } = applying({
      bot: { name: "Ada", avatarColor: "#2563eb", avatarExpression: null },
    });
    const response = await apply();
    expect(response.status).toBe(200);
    expect(updates[0]?.input).toEqual({
      name: "Ada",
      title: "Briefings",
      roleDescription: "You are Research Desk.",
      visibility: "private",
    });
    const { applied } = await response.json();
    expect(applied.renamed).toBe(false);
    expect(applied.avatar).toBe(false);
  });

  test("visibility is never changed by a template", async () => {
    const { updates, apply } = applying({ bot: { visibility: "public" } });
    expect((await apply()).status).toBe(200);
    expect(updates[0]?.input.visibility).toBe("public");
  });

  test("a skill that could not be granted is reported, and the rest still apply", async () => {
    const { granted, audit, apply } = applying({ grantFails: "check-a-claim" });
    const response = await apply();
    expect(response.status).toBe(200);
    expect(granted).toEqual(["research-public-web"]);
    expect((await response.json()).applied.failedSkills).toEqual([
      "check-a-claim",
    ]);
    expect(audit[0]?.payload).toMatchObject({
      skills: ["research-public-web"],
      failedSkills: ["check-a-claim"],
    });
  });

  test("somebody else's Bot is refused, and nothing is written", async () => {
    const { updates, granted, audit, apply } = applying({
      bot: { ownerUserId: "someone-else", visibility: "public" },
    });
    const response = await apply();
    expect(response.status).toBe(403);
    expect(updates).toEqual([]);
    expect(granted).toEqual([]);
    expect(audit).toEqual([]);
  });

  test("an administrator may apply one to somebody else's Bot", async () => {
    const { updates, apply } = applying({
      bot: { ownerUserId: "someone-else" },
      role: "admin",
    });
    expect((await apply()).status).toBe(200);
    expect(updates).toHaveLength(1);
  });

  test("a Bot the package ships is protected, even from an administrator", async () => {
    const { updates, apply } = applying({
      bot: { systemOwned: true, ownerUserId: null },
      role: "admin",
    });
    expect((await apply()).status).toBe(403);
    expect(updates).toEqual([]);
  });

  test("a Bot the person cannot see, and a template that is not here, are 404s", async () => {
    const hidden = applying({ bot: null });
    expect((await hidden.apply()).status).toBe(404);
    const missing = applying();
    expect((await missing.apply("nope")).status).toBe(404);
    expect(missing.updates).toEqual([]);
  });
});
