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
    appInstalled: async (key) => key === "parallel",
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
