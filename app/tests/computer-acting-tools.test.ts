import { afterEach, describe, expect, test } from "bun:test";
import {
  browserStepDetails,
  groupBrowserSteps,
} from "../src/components/channels/browser-activity";
import type { VisibleChatItem } from "../src/components/channels/chat-messages";
import { browsingStepsFor } from "../src/lib/computers/browsing-steps";
import { callComputer } from "../src/lib/computers/call";

/**
 * The app's end of acting on any site: what the Bot is told when an element would not take an
 * action (and what fits instead), the new tools as lines in the Activity list, and as browsing steps
 * in the transcript.
 */

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function serverAnswering(status: number, body: unknown) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

describe("what the Bot is told when an action did not work", () => {
  test("an element problem carries the problem, the tool that fits and the options", async () => {
    serverAnswering(422, {
      error: "e2 is a drop-down list. Use computer_select.",
      problem: "wrong_tool",
      useTool: "computer_select",
      options: ["Small", "Large"],
    });
    const outcome = await callComputer("bot", "/click", { method: "POST" });
    expect(outcome).toMatchObject({
      ok: false,
      problem: "wrong_tool",
      useTool: "computer_select",
      options: ["Small", "Large"],
    });
    // Not stale: a fresh snapshot would not help.
    expect(outcome.staleRefs).toBeUndefined();
  });

  test("a covered element carries the banner's buttons", async () => {
    serverAnswering(422, {
      error: "e9 is covered by a cookie banner.",
      problem: "covered",
      coveredBy: {
        label: "div.cookie",
        consent: true,
        buttons: [{ name: "Reject all", ref: "e12" }],
      },
    });
    const outcome = await callComputer("bot", "/click", { method: "POST" });
    expect(outcome.coveredBy).toEqual({
      label: "div.cookie",
      consent: true,
      buttons: [{ name: "Reject all", ref: "e12" }],
    });
  });

  test("a page paused on a dialog says so, and is not stale refs", async () => {
    serverAnswering(409, {
      error: "A confirm dialog is open.",
      dialog: { type: "confirm", message: "Delete?" },
    });
    const outcome = await callComputer("bot", "/click", { method: "POST" });
    expect(outcome.dialog).toEqual({ type: "confirm", message: "Delete?" });
    expect(outcome.staleRefs).toBeUndefined();
  });

  test("a site that failed says which way", async () => {
    serverAnswering(502, {
      error: "That address does not exist.",
      siteError: { problem: "dns", code: "net::ERR_NAME_NOT_RESOLVED" },
    });
    const outcome = await callComputer("bot", "/navigate", { method: "POST" });
    expect(outcome.siteError).toEqual({
      problem: "dns",
      code: "net::ERR_NAME_NOT_RESOLVED",
    });
  });
});

describe("the new tools in the Activity list", () => {
  const page = { url: "https://shop.example/order", title: "Order" };

  test("a choice names the drop-down and the option, a tick the box", () => {
    expect(
      browsingStepsFor(
        "computer_select",
        { ref: "e2", option: "Large" },
        { ok: true, element: { name: "Size" }, chosen: "Large", page },
      ),
    ).toEqual([{ kind: "type", subject: "Size", output: "", detail: "Large" }]);
    expect(
      browsingStepsFor(
        "computer_check",
        { ref: "e3", checked: true },
        { ok: true, element: { name: "Gift wrap" }, checked: true, page },
      ),
    ).toEqual([
      { kind: "click", subject: "Gift wrap", output: "", detail: "ticked" },
    ]);
  });

  test("a fill lists each field by its label and NEVER what went into it", () => {
    const steps = browsingStepsFor(
      "computer_fill",
      { fields: [{ ref: "e1", text: "my secret answer" }] },
      {
        ok: true,
        filled: [
          { index: 0, ref: "e1", kind: "text", element: { name: "Answer" } },
          {
            index: 1,
            ref: "e2",
            kind: "option",
            chosen: "Pro",
            element: { name: "Plan" },
          },
          { index: 2, ref: "e3", kind: "checked", element: { name: "Agree" } },
        ],
        failed: { index: 3, ref: "e4", error: "e4 is disabled." },
        afterwards: undefined,
        page,
      },
    );
    expect(steps).toEqual([
      { kind: "type", subject: "Answer", output: "" },
      { kind: "type", subject: "Plan", output: "", detail: "Pro" },
      { kind: "click", subject: "Agree", output: "" },
      {
        kind: "issue",
        subject: "A field could not be filled in",
        output: "e4 is disabled.",
      },
    ]);
    expect(JSON.stringify(steps)).not.toContain("my secret answer");
  });

  test("a refused field in a fill is an issue marked as a refusal", () => {
    expect(
      browsingStepsFor(
        "computer_fill",
        {},
        {
          ok: true,
          filled: [],
          refused: { index: 0, ref: "e3", reason: "Field 0 was refused." },
        },
      ),
    ).toEqual([
      {
        kind: "issue",
        subject: "A field was not filled in",
        output: "Field 0 was refused.",
        refused: true,
      },
    ]);
  });

  test("an action that opened a tab, downloaded a file or met a check says so", () => {
    expect(
      browsingStepsFor(
        "computer_click",
        { ref: "e5" },
        {
          ok: true,
          element: { name: "Download statement" },
          url: page.url,
          page: {
            ...page,
            title: "Help",
            opened: { url: "https://help.example/start" },
            download: { path: "Downloads/statement.pdf", bytes: 2048 },
          },
          challenge: { reason: "A CAPTCHA appeared.", requestId: "r1" },
        },
      ),
    ).toEqual([
      { kind: "click", subject: "Download statement", output: "" },
      {
        kind: "page",
        subject: "Help",
        output: "",
        detail: "help.example, in a new tab",
      },
      {
        kind: "write_file",
        subject: "Downloads/statement.pdf",
        output: "2048 bytes, downloaded",
      },
      {
        kind: "issue",
        subject: "Met a check on shop.example",
        output: "A CAPTCHA appeared.",
      },
    ]);
  });

  test("a dialog answered, a step back and a tab switch each say where they left the Bot", () => {
    expect(
      browsingStepsFor(
        "computer_dialog",
        { accept: true },
        {
          ok: true,
          accepted: true,
          dialog: { type: "confirm", message: "Empty the basket?" },
        },
      ),
    ).toEqual([
      { kind: "click", subject: "Empty the basket?", output: "", detail: "OK" },
    ]);
    expect(
      browsingStepsFor("computer_back", {}, { ok: true, wentBack: true, page }),
    ).toEqual([
      { kind: "page", subject: "Order", output: "", detail: "shop.example" },
    ]);
    expect(
      browsingStepsFor(
        "computer_back",
        {},
        { ok: true, wentBack: false, page },
      ),
    ).toEqual([]);
    expect(
      browsingStepsFor(
        "computer_tabs",
        { action: "switch", index: 1 },
        { ok: true, switched: 1, page },
      ),
    ).toEqual([
      { kind: "page", subject: "Order", output: "", detail: "shop.example" },
    ]);
    expect(
      browsingStepsFor("computer_tabs", { action: "list" }, { ok: true, page }),
    ).toEqual([]);
  });

  test("failures are issues, refusals marked", () => {
    expect(
      browsingStepsFor(
        "computer_upload",
        { path: "cv.pdf" },
        { ok: false, refused: true, reason: "Files may not leave." },
      ),
    ).toEqual([
      {
        kind: "issue",
        subject: "Could not upload a file",
        output: "Files may not leave.",
        refused: true,
      },
    ]);
  });
});

describe("the new tools in the transcript", () => {
  const step = (
    id: string,
    name: string,
  ): Extract<VisibleChatItem, { kind: "tool" }> => ({
    kind: "tool",
    id,
    toolCall: { id, type: "function", function: { name, arguments: "{}" } },
    result: '{"ok":true}',
  });

  test("group with the other browsing steps, each with its own label", () => {
    const names = [
      ["computer_fill", "Filled in form"],
      ["computer_select", "Chose option"],
      ["computer_check", "Ticked box"],
      ["computer_upload", "Uploaded file"],
      ["computer_hover", "Hovered"],
      ["computer_dialog", "Answered dialog"],
      ["computer_tabs", "Switched tab"],
      ["computer_back", "Went back"],
    ] as const;
    const items = [
      step("nav", "computer_navigate"),
      ...names.map(([name]) => step(name, name)),
    ];
    const grouped = groupBrowserSteps(items);
    expect(grouped).toHaveLength(1);
    const first = grouped[0];
    if (first?.kind !== "browser") throw new Error("expected a browser row");
    expect(
      first.steps.slice(1).map((entry) => browserStepDetails(entry).label),
    ).toEqual(names.map(([, label]) => label));
  });
});
