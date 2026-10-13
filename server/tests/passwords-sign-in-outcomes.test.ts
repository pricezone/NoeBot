import { describe, expect, test } from "bun:test";
import { SIGN_IN_TOOL_DESCRIPTION as SHARED_DESCRIPTION } from "../../shared/sign-in-guidance";
import type { ComputerGateway } from "../src/computer/gateway";
import { SIGN_IN_TOOL_DESCRIPTION } from "../src/computer/headless-tools";
import type {
  SignInFillInput,
  SignInFillResult,
  SignInProbe,
} from "../src/computer/schema";
import {
  createSignInService,
  signInToolResult,
} from "../src/passwords/service";
import { createMemoryPasswordStore } from "../src/passwords/store";
import type { SignInRequestRecord } from "../src/passwords/types";

/**
 * How each answer the computer reads off the page after a login becomes the request's state, what
 * the person sees, and what the Bot is told: signed in, refused (with the site's words, never the
 * login), a code next, an approval on the phone (waited for, then settled), a security check, and a
 * login that moved on to an identity provider.
 */

const PASSWORD = "Tr0ub4dor&3-never-show-me";
const USERNAME = "alice.private@example.test";
const KEY = Buffer.alloc(32, 7).toString("base64");
const actor = {
  id: "owner",
  userId: "owner",
  initiator: { kind: "person" as const },
};

type Answer = Partial<SignInFillResult>;

function setup(
  options: {
    fills?: Answer[];
    probes?: SignInProbe["check"][];
    approvalWaitMs?: number;
    approvalPollMs?: number;
  } = {},
) {
  const store = createMemoryPasswordStore();
  const fills: SignInFillInput[] = [];
  const helps: string[] = [];
  const answers = [...(options.fills ?? [])];
  const probes = [...(options.probes ?? [])];
  let probing = false;
  const gateway: Pick<ComputerGateway, "signIn" | "requestHelp"> &
    Pick<ComputerGateway, "probeSignIn"> = {
    async signIn(_botId, input) {
      fills.push(input);
      return {
        submitted: true,
        passwordFieldVisible: false,
        url: `${input.origin}/home`,
        ...(answers.shift() ?? { outcome: "signed-in" }),
      };
    },
    async probeSignIn() {
      // The request's own look before asking: a login form. Every later read is the next check.
      if (!probing) {
        probing = true;
        return {
          url: "https://example.com/login",
          origin: "https://example.com",
          host: "example.com",
          form: "login",
        };
      }
      const check = probes.length > 1 ? probes.shift() : probes[0];
      return {
        url: "https://example.com/next",
        origin: "https://example.com",
        host: "example.com",
        form: "none",
        ...(check ? { check } : {}),
      };
    },
    async requestHelp(_botId, _actor, reason) {
      helps.push(reason);
      return {
        holder: "bot",
        request: { id: "control-1" },
      } as unknown as Awaited<ReturnType<ComputerGateway["requestHelp"]>>;
    },
  };
  const resolved: SignInRequestRecord[] = [];
  const service = createSignInService({
    store,
    gateway,
    encryptionKey: KEY,
    onResolved: async (request) => void resolved.push(request),
    approvalWaitMs: options.approvalWaitMs ?? 60_000,
    approvalPollMs: options.approvalPollMs ?? 60_000,
  });
  const ask = () =>
    service.request({
      ownerUserId: "owner",
      botId: "bot",
      site: "https://example.com/login",
      actor,
    });
  return { store, service, fills, helps, resolved, ask };
}

async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 100 && !check(); attempt += 1)
    await new Promise((resolve) => setTimeout(resolve, 10));
}

describe("what the page answered becomes the request's state", () => {
  test("signed in, with a remember-device box left unchecked and said so", async () => {
    const { service, resolved, ask } = setup({
      fills: [{ outcome: "signed-in", rememberDeviceLeftUnchecked: true }],
    });
    const request = await ask();
    const view = await service.submit("owner", request.id, actor, {
      username: USERNAME,
      password: PASSWORD,
    });
    expect(view.status).toBe("signed_in");
    const result = signInToolResult(resolved[0] as SignInRequestRecord);
    expect(result).toMatchObject({ ok: true, outcome: "signed-in" });
    expect(result.result).toContain(
      "'remember this device' box was left unchecked",
    );
  });

  test("a refusal reopens the form with the site's words, never the login, and the Bot hears it at the end", async () => {
    const { service, resolved, ask } = setup({
      fills: [
        {
          outcome: "error",
          passwordFieldVisible: true,
          pageMessage: `No account matches ${USERNAME}`,
        },
      ],
    });
    const request = await ask();
    const failure = await service
      .submit("owner", request.id, actor, {
        username: USERNAME,
        password: PASSWORD,
      })
      .catch((error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      "Wrong password or code. The site says: “No account matches [hidden]”",
    );
    const view = await service.get("owner", request.id);
    expect(view.status).toBe("pending");
    expect(view.attempt).toEqual({
      outcome: "error",
      pageMessage: "No account matches [hidden]",
    });
    await service.cancel("owner", request.id, actor);
    const result = signInToolResult(resolved[0] as SignInRequestRecord);
    expect(result).toMatchObject({
      ok: false,
      status: "cancelled",
      outcome: "error",
      pageMessage: "No account matches [hidden]",
    });
    expect(result.result).toContain("The site refused the last attempt");
    expect(JSON.stringify([view, result])).not.toContain(USERNAME);
  });

  test("a code asked for next ends the request, and the Bot is told to ask again for the code", async () => {
    const { service, store, resolved, ask } = setup({
      fills: [{ outcome: "code-requested" }],
    });
    const request = await ask();
    const view = await service.submit("owner", request.id, actor, {
      username: USERNAME,
      password: PASSWORD,
      save: true,
    });
    expect(view.status).toBe("failed");
    const result = signInToolResult(resolved[0] as SignInRequestRecord);
    expect(result).toMatchObject({ ok: false, outcome: "code-requested" });
    expect(result.result).toContain("Call computer_request_sign_in again");
    // The site took the password, so the save the person asked for happened.
    expect(await store.logins("owner")).toHaveLength(1);
  });

  test("an approval on the phone is waited for, and the request signs in when the page moves on", async () => {
    const { service, resolved, ask } = setup({
      fills: [{ outcome: "push-approval" }],
      probes: [{ outcome: "push-approval" }, { outcome: "signed-in" }],
      approvalPollMs: 5,
    });
    const request = await ask();
    const waiting = await service.submit("owner", request.id, actor, {
      username: USERNAME,
      password: PASSWORD,
    });
    expect(waiting.status).toBe("filling");
    expect(waiting.approvalUntil).toBeDefined();
    expect(waiting.attempt).toEqual({ outcome: "push-approval" });
    await until(() => resolved.length > 0);
    expect(resolved[0]?.status).toBe("signed_in");
    expect(signInToolResult(resolved[0] as SignInRequestRecord)).toMatchObject({
      ok: true,
      outcome: "signed-in",
    });
  });

  test("Continue reads the page at once", async () => {
    const { service, ask } = setup({
      fills: [{ outcome: "push-approval" }],
      probes: [{ outcome: "signed-in" }],
    });
    const request = await ask();
    await service.submit("owner", request.id, actor, {
      username: USERNAME,
      password: PASSWORD,
    });
    const done = await service.continueApproval("owner", request.id, actor);
    expect(done.status).toBe("signed_in");
    await expect(
      service.continueApproval("owner", request.id, actor),
    ).rejects.toThrow(/not waiting/);
  });

  test("no approval in time ends it, and the Bot is told the approval never came", async () => {
    const { service, resolved, ask } = setup({
      fills: [{ outcome: "push-approval" }],
      probes: [{ outcome: "push-approval" }],
      approvalWaitMs: 20,
      approvalPollMs: 5,
    });
    const request = await ask();
    await service.submit("owner", request.id, actor, {
      username: USERNAME,
      password: PASSWORD,
    });
    await until(() => resolved.length > 0);
    const result = signInToolResult(resolved[0] as SignInRequestRecord);
    expect(result).toMatchObject({
      ok: false,
      status: "failed",
      outcome: "push-approval",
    });
    expect(result.result).toContain("no approval came");
  });

  test("a security check hands the person the browser", async () => {
    const { service, helps, resolved, ask } = setup({
      fills: [{ outcome: "captcha" }],
    });
    const request = await ask();
    const view = await service.submit("owner", request.id, actor, {
      username: USERNAME,
      password: PASSWORD,
    });
    expect(view.status).toBe("taken_over");
    expect(view.controlRequestId).toBe("control-1");
    expect(helps[0]).toContain("security check");
    await service.finishTakeover("owner", request.id, actor);
    expect(signInToolResult(resolved[0] as SignInRequestRecord)).toMatchObject({
      ok: true,
      outcome: "signed-in",
    });
  });
});

describe("a login that moves on to another origin", () => {
  test("a typed login continues there, and the request names the origin it went to", async () => {
    const { service, fills, ask } = setup({
      fills: [
        { movedTo: { origin: "https://id.example.net", form: "login" } },
        { outcome: "signed-in" },
      ],
    });
    const request = await ask();
    const view = await service.submit("owner", request.id, actor, {
      username: USERNAME,
      password: PASSWORD,
    });
    expect(fills.map((fill) => fill.origin)).toEqual([
      "https://example.com",
      "https://id.example.net",
    ]);
    expect(fills[1]).toMatchObject({ username: USERNAME, password: PASSWORD });
    expect(view).toMatchObject({
      status: "signed_in",
      origin: "https://id.example.net",
      requestedOrigin: "https://example.com",
    });
  });

  test("a saved login is never typed into the origin it moved to", async () => {
    const { service, store, fills, ask } = setup({
      fills: [{ movedTo: { origin: "https://id.example.net", form: "login" } }],
    });
    const request = await ask();
    const { encryptSecret } = await import("../src/credentials");
    const saved = await store.saveLogin({
      ownerUserId: "owner",
      origin: "https://example.com",
      username: USERNAME,
      encryptedPassword: await encryptSecret(KEY, PASSWORD),
    });
    await expect(
      service.useSaved("owner", request.id, actor, { loginId: saved.id }),
    ).rejects.toThrow(/only typed into the site it was saved for/);
    expect(fills).toHaveLength(1);
    expect((await service.get("owner", request.id)).origin).toBe(
      "https://id.example.net",
    );
  });
});

describe("the words a Bot is given", () => {
  test("one description for both tools, naming no portal or country", () => {
    expect(SIGN_IN_TOOL_DESCRIPTION).toBe(SHARED_DESCRIPTION);
    expect(SIGN_IN_TOOL_DESCRIPTION).not.toMatch(
      /gov\.gr|taxisnet|gsis|[Ͱ-Ͽ]/i,
    );
    expect(SIGN_IN_TOOL_DESCRIPTION).toContain("identity provider");
  });

  test("a page with no form is refused in words for any site", async () => {
    const store = createMemoryPasswordStore();
    const service = createSignInService({
      store,
      encryptionKey: KEY,
      gateway: {
        signIn: async () => ({
          submitted: false,
          passwordFieldVisible: false,
          url: "",
        }),
        requestHelp: async () =>
          ({}) as Awaited<ReturnType<ComputerGateway["requestHelp"]>>,
        probeSignIn: async () => ({
          url: "https://shop.example/",
          origin: "https://shop.example",
          host: "shop.example",
          form: "none",
        }),
      },
    });
    const refusal = await service
      .request({
        ownerUserId: "owner",
        botId: "bot",
        site: "shop.example",
        actor,
      })
      .catch((error: Error) => error.message);
    expect(refusal).toContain('"Sign in" or "Log in"');
    expect(refusal).not.toMatch(/[Ͱ-Ͽ]/);
  });
});
