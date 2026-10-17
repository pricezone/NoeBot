import { describe, expect, test } from "bun:test";
import {
  readSelfProfileChange,
  SELF_PROFILE_TOOL,
  shortenedWordIn,
} from "../../shared/self-profile";
import type { AuditEventInput } from "../src/audit";
import { ProtectedAgentError } from "../src/agents/profile-store";
import type {
  AgentActor,
  AgentProfile,
  CreateAgentInput,
} from "../src/agents/profile-types";
import { selfProfileTool } from "../src/agents/self-profile";
import { REFUSAL_MARKER } from "../src/plugins/tools";

/**
 * A Bot changing its own name and one-line role: the profile form's validation and write, the
 * form's audit row, and a refusal that says why when the name is a cut-off word.
 */

const OWNER: AgentActor = { id: "user_owner", role: "user" };

const NEW_BOT: AgentProfile = {
  id: "agent_new",
  name: "New Bot",
  title: "General assistant",
  roleDescription: "Help with whatever takes the most off the person's plate.",
  avatarSeed: "seed",
  avatarColor: null,
  avatarExpression: null,
  visibility: "private",
  ownerUserId: OWNER.id,
  systemOwned: false,
  hidden: false,
  pinned: false,
  deletedAt: null,
  endpoint: null,
  hasAuth: false,
  hasCallbackToken: false,
};

function harness(
  options: {
    profile?: AgentProfile | null;
    updateFails?: Error;
    auditFails?: boolean;
    others?: AgentProfile[];
  } = {},
) {
  let stored = options.profile === undefined ? { ...NEW_BOT } : options.profile;
  const updates: { actor: AgentActor; id: string; input: CreateAgentInput }[] =
    [];
  const audit: AuditEventInput[] = [];
  const tool = selfProfileTool({
    run: {
      botId: NEW_BOT.id,
      actorId: OWNER.id,
      runId: "run-1",
      initiator: { kind: "person" },
    },
    actorFor: async (id) => ({ ...OWNER, id }),
    store: {
      get: async (_actor, id) => (stored && stored.id === id ? stored : null),
      update: async (actor, id, input) => {
        if (options.updateFails) throw options.updateFails;
        updates.push({ actor, id, input });
        if (!stored) throw new Error("no profile");
        stored = { ...stored, ...input };
        return stored;
      },
      list: async () => [
        ...(stored ? [stored] : []),
        ...(options.others ?? []),
      ],
    },
    auditStore: {
      insert: async (event) => {
        if (options.auditFails) throw new Error("trail down");
        audit.push(event);
      },
    },
  });
  return { tool, updates, audit };
}

describe(SELF_PROFILE_TOOL, () => {
  test("renames the Bot through the profile write, the rest of the profile as it was", async () => {
    const { tool, updates, audit } = harness();

    const said = await tool.execute({
      name: "  Quill ",
      role: "Researches topics\nand writes clear drafts.",
    });

    expect(updates).toEqual([
      {
        actor: OWNER,
        id: NEW_BOT.id,
        input: {
          name: "Quill",
          title: "Researches topics and writes clear drafts.",
          roleDescription: "Researches topics and writes clear drafts.",
          visibility: "private",
          endpoint: undefined,
          auth: undefined,
        },
      },
    ]);
    expect(readSelfProfileChange(said)).toEqual({
      updated: true,
      bot: NEW_BOT.id,
      name: "Quill",
      role: "Researches topics and writes clear drafts.",
      title: "Researches topics and writes clear drafts.",
      previous: {
        name: NEW_BOT.name,
        role: NEW_BOT.roleDescription,
        title: NEW_BOT.title,
      },
      note: expect.stringContaining("undo"),
    });
    // The form's row, saying the Bot did it in its owner's run.
    expect(audit).toEqual([
      {
        eventType: "bot.updated",
        targetType: "agent",
        targetId: NEW_BOT.id,
        actorUserId: OWNER.id,
        initiator: { kind: "person" },
        payload: {
          bot: NEW_BOT.id,
          name: "Quill",
          visibility: "private",
          by: "bot",
          run: "run-1",
          previousName: "New Bot",
          roleChanged: true,
        },
      },
    ]);
  });

  test("changes only the role when only the role is given", async () => {
    const { tool, updates } = harness();
    await tool.execute({ role: "Keeps an eye on the build." });
    expect(updates[0]?.input).toMatchObject({
      name: NEW_BOT.name,
      title: "Keeps an eye on the build.",
      roleDescription: "Keeps an eye on the build.",
    });
  });

  test("leaves the title alone when only the name is given", async () => {
    const { tool, updates } = harness();
    await tool.execute({ name: "Quill" });
    expect(updates[0]?.input).toMatchObject({
      name: "Quill",
      title: NEW_BOT.title,
      roleDescription: NEW_BOT.roleDescription,
    });
  });

  test("refuses a role too long to be the title, rather than cutting it", async () => {
    const { tool, updates } = harness();
    const said = await tool.execute({ name: "Quill", role: "R".repeat(121) });
    expect(said).toStartWith(REFUSAL_MARKER);
    expect(said).toContain("at most 120 characters");
    expect(said).toContain("title");
    expect(updates).toEqual([]);
    // Exactly the limit fits.
    await tool.execute({ role: "R".repeat(120) });
    expect(updates[0]?.input.title).toBe("R".repeat(120));
  });

  test("refuses a name cut short, says which word, and changes nothing", async () => {
    const { tool, updates, audit } = harness();

    const said = await tool.execute({
      name: "Διεκπ.",
      role: "Διεκπεραιώνει εργασίες.",
    });

    expect(said).toStartWith(REFUSAL_MARKER);
    expect(said).toContain('"Διεκπ."');
    expect(said).toContain("in full");
    expect(said).toContain(SELF_PROFILE_TOOL);
    expect(updates).toEqual([]);
    expect(audit).toEqual([]);
  });

  test("refuses a name ending in an ellipsis, and one longer than the form allows", async () => {
    const { tool, updates } = harness();
    expect(await tool.execute({ name: "Research…" })).toStartWith(
      REFUSAL_MARKER,
    );
    expect(await tool.execute({ name: "Q".repeat(81) })).toContain("80");
    expect(updates).toEqual([]);
  });

  test("refuses the app's own name, however it is spelled, and changes nothing", async () => {
    for (const name of ["Noë", "noe", "Noë Bot", "NOE  BOT"]) {
      const { tool, updates } = harness();
      const said = await tool.execute({
        name,
        role: "Researches energy markets",
      });
      expect(String(said)).toContain("the app's own name");
      expect(updates).toEqual([]);
    }
  });

  test("refuses the name of another of the person's Bots, but not its own", async () => {
    const other: AgentProfile = {
      ...NEW_BOT,
      id: "agent_other",
      name: "Noé Research",
    };
    const taken = harness({ others: [other] });
    const said = await taken.tool.execute({ name: "noe research" });
    expect(String(said)).toContain('already has a Bot called "Noé Research"');
    expect(taken.updates).toEqual([]);

    const same = harness();
    await same.tool.execute({ name: "New Bot", role: "Writes reports" });
    expect(same.updates).toHaveLength(1);
  });

  test("refuses a call with nothing in it", async () => {
    const { tool, updates } = harness();
    expect(await tool.execute({})).toContain("give a name, a role, or both");
    expect(await tool.execute({ name: "   " })).toContain(
      "give a name, a role, or both",
    );
    expect(await tool.execute("Quill")).toStartWith(REFUSAL_MARKER);
    expect(updates).toEqual([]);
  });

  test("refuses for a Bot it may not edit, without a row", async () => {
    const { tool, audit } = harness({
      updateFails: new ProtectedAgentError(NEW_BOT.id),
    });
    const said = await tool.execute({ name: "Quill" });
    expect(said).toStartWith(REFUSAL_MARKER);
    expect(said).toContain("whoever manages you");
    expect(audit).toEqual([]);
  });

  test("refuses for a Bot that runs somewhere else", async () => {
    const { tool, updates } = harness({
      profile: { ...NEW_BOT, endpoint: "https://agent.example/ag-ui" },
    });
    expect(await tool.execute({ name: "Quill" })).toContain(
      "only a Bot that runs here",
    );
    expect(updates).toEqual([]);
  });

  test("a trail that is briefly down does not undo or deny the rename", async () => {
    const { tool, updates } = harness({ auditFails: true });
    const said = await tool.execute({ name: "Quill" });
    expect(readSelfProfileChange(said)?.name).toBe("Quill");
    expect(updates).toHaveLength(1);
  });
});

describe("a whole name", () => {
  test("is refused when its last word is cut off", () => {
    expect(shortenedWordIn("Διεκπ.")).toBe("Διεκπ.");
    expect(shortenedWordIn("Research Asst.")).toBe("Asst.");
    expect(shortenedWordIn("Writer...")).toBe("Writer...");
    expect(shortenedWordIn("Quill…")).toBe("Quill…");
  });

  test("is whole when its words are, initialisms included", () => {
    expect(shortenedWordIn("Quill")).toBeNull();
    expect(shortenedWordIn("Διεκπεραιωτής")).toBeNull();
    expect(shortenedWordIn("Research Partner")).toBeNull();
    expect(shortenedWordIn("J.A.R.V.I.S.")).toBeNull();
  });

  test("a change is read back from the result however it was encoded, and a refusal is not one", () => {
    const change = {
      updated: true,
      bot: "b",
      name: "Quill",
      role: "Writes.",
      title: "Writes.",
      previous: { name: "New Bot", role: "Helps.", title: "General assistant" },
      note: "",
    };
    expect(readSelfProfileChange(JSON.stringify(change))).toEqual(change);
    expect(
      readSelfProfileChange(JSON.stringify(JSON.stringify(change))),
    ).toEqual(change);
    expect(readSelfProfileChange(`${REFUSAL_MARKER} Nothing.`)).toBeNull();
    expect(readSelfProfileChange(undefined)).toBeNull();
  });
});
