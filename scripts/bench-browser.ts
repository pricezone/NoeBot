/**
 * How long Noë Bot takes to do small browser tasks, end to end, through the real app.
 *
 *   BASE_URL=https://bot.example STORAGE_STATE=./state.json bun run bench:browser
 *   bun run bench:browser --dry-run            # print the plan, open nothing
 *   bun run bench:browser --tasks=dropdown,iframe --timeout=300 --out=bench.json --headed
 *
 * For each task it opens a new conversation with the default Bot (`/channel/new`), sends the prompt,
 * and waits for the turn to finish. Recorded per task: the wall time from send to final answer, the
 * number of tool calls the Bot made, and whether the final answer contains the expected fact. The
 * result is printed as a short table and written as JSON.
 *
 * STORAGE_STATE is a Playwright storage state of a signed-in session (cookies for BASE_URL); make
 * one with `context.storageState({ path })` after signing in by hand. Chromium comes from
 * CHROMIUM_PATH, defaulting to the Chrome for Testing build Playwright installed on this machine.
 *
 * The tasks run against https://the-internet.herokuapp.com, a public practice site, so they reach
 * nothing of anybody's. Run it against a deployment you own: every task is a real Bot turn.
 */

type Task = {
  id: string;
  prompt: string;
  /** The fact a correct final answer contains. */
  expect: RegExp;
};

const SITE = "https://the-internet.herokuapp.com";

export const TASKS: readonly Task[] = [
  {
    id: "dropdown",
    prompt: `Open ${SITE}/dropdown in your browser, select "Option 2" in the dropdown, then tell me which option is selected now.`,
    expect: /option\s*2/i,
  },
  {
    id: "checkboxes",
    prompt: `Open ${SITE}/checkboxes in your browser, make sure both checkboxes are checked, then tell me how many checkboxes are checked.`,
    expect: /\b(2|two|both)\b/i,
  },
  {
    id: "js-alerts",
    prompt: `Open ${SITE}/javascript_alerts in your browser, click "Click for JS Confirm", accept the dialog, then tell me the exact result text the page shows.`,
    expect: /you clicked:?\s*ok/i,
  },
  {
    id: "windows",
    prompt: `Open ${SITE}/windows in your browser, click "Click Here", then tell me the heading of the page that opens.`,
    expect: /new window/i,
  },
  {
    id: "iframe",
    prompt: `Open ${SITE}/iframe in your browser and tell me the text inside the editor's content area.`,
    expect: /your content goes here/i,
  },
  {
    id: "dynamic-loading",
    prompt: `Open ${SITE}/dynamic_loading/2 in your browser, click Start, wait until loading finishes, then tell me the text that appears.`,
    expect: /hello world/i,
  },
];

const DEFAULT_CHROMIUM =
  "/Users/constadean/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";

type Options = {
  dryRun: boolean;
  headed: boolean;
  tasks: Task[];
  timeoutMs: number;
  out: string;
  baseUrl?: string;
  storageState?: string;
  chromium: string;
};

export function parseOptions(
  argv: readonly string[],
  environment: Record<string, string | undefined>,
): Options {
  const flag = (name: string) =>
    argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const wanted = flag("tasks")
    ?.split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  const unknown = wanted?.filter((id) => !TASKS.some((task) => task.id === id));
  if (unknown?.length)
    throw new Error(
      `Unknown task: ${unknown.join(", ")}. Known: ${TASKS.map((task) => task.id).join(", ")}.`,
    );
  const seconds = Number(flag("timeout") ?? 240);
  if (!Number.isFinite(seconds) || seconds <= 0)
    throw new Error("--timeout is a number of seconds.");
  const baseUrl = environment.BASE_URL?.trim().replace(/\/+$/, "");
  const storageState = environment.STORAGE_STATE?.trim();
  return {
    // No target means there is nothing to run against, so the plan is all there is to show.
    dryRun: argv.includes("--dry-run") || !baseUrl || !storageState,
    headed: argv.includes("--headed"),
    tasks: wanted
      ? TASKS.filter((task) => wanted.includes(task.id))
      : [...TASKS],
    timeoutMs: seconds * 1000,
    out: flag("out") ?? "bench-browser.json",
    ...(baseUrl ? { baseUrl } : {}),
    ...(storageState ? { storageState } : {}),
    chromium: environment.CHROMIUM_PATH?.trim() || DEFAULT_CHROMIUM,
  };
}

export type TaskResult = {
  task: string;
  ok: boolean;
  wallMs: number;
  toolCalls: number;
  tools: string[];
  answer: string;
  error?: string;
};

type StoredCall = { name?: string; function?: { name?: string } };
type StoredMessage = {
  id?: string;
  role?: string;
  content?: unknown;
  toolCalls?: StoredCall[];
};

const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .map((part) =>
            part && typeof part === "object" && "text" in part
              ? String((part as { text: unknown }).text ?? "")
              : "",
          )
          .join("")
      : "";

/** What the turn after the last user message did: its tool calls and its final words. */
export function summarizeTurn(messages: readonly StoredMessage[]): {
  tools: string[];
  answer: string;
  finished: boolean;
} {
  const lastUser = messages.map((message) => message.role).lastIndexOf("user");
  const turn = messages.slice(lastUser + 1);
  const tools = turn.flatMap((message) =>
    message.role === "assistant"
      ? (message.toolCalls ?? []).map(
          (call) => call.name ?? call.function?.name ?? "unknown",
        )
      : [],
  );
  const last = turn.at(-1);
  const answer = [...turn]
    .reverse()
    .find(
      (message) =>
        message.role === "assistant" && textOf(message.content).trim(),
    );
  return {
    tools,
    answer: answer ? textOf(answer.content).trim() : "",
    // A turn is over when it ends on words, not on a tool call or a tool result.
    finished:
      last?.role === "assistant" &&
      !(last.toolCalls?.length ?? 0) &&
      textOf(last.content).trim().length > 0,
  };
}

function printPlan(options: Options) {
  console.info(
    `bench:browser plan (${options.dryRun ? "dry run" : "live"}): ${options.tasks.length} task(s), timeout ${options.timeoutMs / 1000}s each`,
  );
  console.info(`  target   ${options.baseUrl ?? "(BASE_URL not set)"}`);
  console.info(
    `  session  ${options.storageState ?? "(STORAGE_STATE not set)"}`,
  );
  console.info(`  chromium ${options.chromium}`);
  for (const task of options.tasks)
    console.info(
      `  - ${task.id}: ${task.prompt}\n      expects ${task.expect}`,
    );
  if (options.dryRun)
    console.info(
      "Nothing was opened. Set BASE_URL and STORAGE_STATE (and drop --dry-run) to run it.",
    );
}

export function table(results: readonly TaskResult[]): string {
  const rows = results.map((result) => [
    result.task,
    result.ok ? "yes" : "no",
    `${(result.wallMs / 1000).toFixed(1)}s`,
    String(result.toolCalls),
    result.error ? `error: ${result.error}` : result.answer.slice(0, 60),
  ]);
  const header = ["task", "correct", "wall", "tools", "answer"];
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => row[column]?.length ?? 0)),
  );
  const line = (cells: string[]) =>
    cells.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join("  ");
  return [line(header), ...rows.map(line)].join("\n");
}

async function runTask(
  context: import("playwright-core").BrowserContext,
  options: Options & { baseUrl: string },
  task: Task,
): Promise<TaskResult> {
  const page = await context.newPage();
  const started = performance.now();
  try {
    await page.goto(`${options.baseUrl}/channel/new`, {
      waitUntil: "domcontentloaded",
    });
    const box = page.locator("textarea").last();
    await box.waitFor({ state: "visible", timeout: 30_000 });
    await box.fill(task.prompt);
    const sentAt = performance.now();
    await box.press("Enter");
    // The channel is created on first send; its id is in the address from then on.
    await page.waitForURL(/\/channel\/(?!new)[^/?#]+/, { timeout: 60_000 });
    const channelId = new URL(page.url()).pathname.split("/").at(-1) ?? "";
    const channel = await page.evaluate(async (id) => {
      const response = await fetch(`/api/channels/${id}`, {
        credentials: "include",
      });
      const body = (await response.json()) as {
        channel?: { threadId?: string; agentIds?: string[] };
      };
      return body.channel ?? {};
    }, channelId);
    if (!channel.threadId) throw new Error("The channel has no thread.");
    const deadline = sentAt + options.timeoutMs;
    let quietSince: number | undefined;
    let last = { tools: [] as string[], answer: "", finished: false };
    while (performance.now() < deadline) {
      await page.waitForTimeout(1_500);
      const running = await page
        .locator('[data-testid="composer-stop"]')
        .isVisible()
        .catch(() => false);
      const messages = await page.evaluate(
        async ({ threadId, agentId }) => {
          const response = await fetch(
            `/api/copilotkit/threads/${encodeURIComponent(threadId)}/messages?agentId=${encodeURIComponent(agentId)}`,
            { credentials: "include" },
          );
          if (!response.ok) return [];
          const body = (await response.json()) as { messages?: unknown };
          return Array.isArray(body.messages) ? body.messages : [];
        },
        { threadId: channel.threadId, agentId: channel.agentIds?.[0] ?? "" },
      );
      last = summarizeTurn(messages as StoredMessage[]);
      // Finished words with nothing running, still true three seconds later: the turn is over.
      if (last.finished && !running) {
        quietSince ??= performance.now();
        if (performance.now() - quietSince >= 3_000) break;
      } else quietSince = undefined;
    }
    const ended = quietSince ?? performance.now();
    return {
      task: task.id,
      ok: last.finished && task.expect.test(last.answer),
      wallMs: Math.round(ended - sentAt),
      toolCalls: last.tools.length,
      tools: last.tools,
      answer: last.answer,
      ...(last.finished ? {} : { error: "did not finish before the timeout" }),
    };
  } catch (error) {
    return {
      task: task.id,
      ok: false,
      wallMs: Math.round(performance.now() - started),
      toolCalls: 0,
      tools: [],
      answer: "",
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await page.close().catch(() => undefined);
  }
}

async function main() {
  const options = parseOptions(process.argv.slice(2), process.env);
  printPlan(options);
  if (options.dryRun || !options.baseUrl || !options.storageState) return;
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({
    executablePath: options.chromium,
    headless: !options.headed,
  });
  const results: TaskResult[] = [];
  try {
    const context = await browser.newContext({
      storageState: options.storageState,
      baseURL: options.baseUrl,
    });
    for (const task of options.tasks) {
      const result = await runTask(
        context,
        { ...options, baseUrl: options.baseUrl },
        task,
      );
      results.push(result);
      console.info(
        `${task.id}: ${result.ok ? "correct" : "NOT correct"} in ${(result.wallMs / 1000).toFixed(1)}s with ${result.toolCalls} tool call(s)`,
      );
    }
  } finally {
    await browser.close();
  }
  const report = {
    baseUrl: options.baseUrl,
    at: new Date().toISOString(),
    results,
    summary: {
      correct: results.filter((result) => result.ok).length,
      tasks: results.length,
      medianWallMs:
        [...results].sort((a, b) => a.wallMs - b.wallMs)[
          Math.floor(results.length / 2)
        ]?.wallMs ?? 0,
      toolCalls: results.reduce((sum, result) => sum + result.toolCalls, 0),
    },
  };
  await Bun.write(options.out, `${JSON.stringify(report, null, 2)}\n`);
  console.info(`\n${table(results)}\n\nWritten to ${options.out}`);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
