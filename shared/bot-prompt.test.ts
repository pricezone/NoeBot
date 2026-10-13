import { describe, expect, test } from "bun:test";
import { COMPUTER_GUIDANCE } from "./bot-prompt";

/** The tools the computer contract registers; the guidance may name these and nothing else. */
const CONTRACT = [
  "computer_navigate",
  "computer_read",
  "computer_snapshot",
  "computer_click",
  "computer_type",
  "computer_key",
  "computer_scroll",
  "computer_fill",
  "computer_select",
  "computer_check",
  "computer_upload",
  "computer_hover",
  "computer_dialog",
  "computer_tabs",
  "computer_back",
  "computer_show_screen",
  "computer_request_sign_in",
  "computer_request_secret",
  "computer_request_help",
  "computer_run_command",
  "computer_read_file",
  "computer_write_file",
  "computer_list_files",
  "askChoice",
  "askApproval",
  "ask_person",
];

const flat = COMPUTER_GUIDANCE.replace(/\s+/g, " ");

describe("COMPUTER_GUIDANCE", () => {
  test("keeps paragraph breaks as blank lines instead of collapsing them into spaces", () => {
    expect(COMPUTER_GUIDANCE).toContain("\n\n");
    expect(COMPUTER_GUIDANCE).not.toContain("  ");
  });

  test("keeps each paragraph as one unbroken line of prose", () => {
    for (const paragraph of COMPUTER_GUIDANCE.split("\n\n")) {
      expect(paragraph).not.toContain("\n");
      expect(paragraph.length).toBeGreaterThan(0);
    }
  });

  test("names every tool of the contract, and only tools that exist", () => {
    for (const tool of CONTRACT)
      expect({ tool, named: new RegExp(`\\b${tool}\\b`).test(flat) }).toEqual({
        tool,
        named: true,
      });
    const named = flat.match(/\b(computer_[a-z_]+|ask[A-Z]\w*|ask_\w+)\b/g);
    for (const tool of new Set(named))
      expect({ tool, real: CONTRACT.includes(tool) }).toEqual({
        tool,
        real: true,
      });
  });

  test("is site-agnostic: no one country's services, no default sign-in provider", () => {
    expect(flat).not.toMatch(/gov\.gr|taxisnet|gsis|υπεύθυνη/i);
    expect(flat).not.toMatch(/[Ͱ-Ͽ]/);
  });

  test("works from the page every action returns, snapshotting only without one", () => {
    expect(flat).toContain("Every browser action returns the page");
    for (const field of [
      "snapshotId",
      "elements",
      "`changed`",
      "`dialog`",
      "`opened`",
      "`download`",
    ])
      expect(flat).toContain(field);
    expect(flat).toContain(
      "Call computer_snapshot only when you have no current snapshot",
    );
    expect(flat).toContain("Never invent a ref");
  });

  test("signs in through the private form, never through the chat", () => {
    expect(flat).toContain("open the site's sign-in page first");
    expect(flat).toContain(
      "use the person's stated choice, otherwise the site's main option, otherwise ask",
    );
    expect(flat).toContain("Never ask for usernames, passwords or codes");
    expect(flat).toContain("never refuse government, bank or identity logins");
    expect(flat).toContain(
      "do not ask again in the same turn: say what you need and stop",
    );
  });

  test("carries a form to its preview in one turn and asks before an irreversible submit", () => {
    expect(flat).toContain("final preview in ONE turn");
    expect(flat).toContain("Before an irreversible submit");
    expect(flat).toContain("The question card shows them your screen");
    expect(flat).toContain("never rebuild the page as a generated interface");
    expect(flat).toContain("the option that shares the least data");
  });

  test("keeps its opening and closing lines, and stays shorter than the guidance it replaced", () => {
    expect(COMPUTER_GUIDANCE).toContain(
      "You are a Bot with your own computer, a real web browser the person can watch you use.",
    );
    expect(COMPUTER_GUIDANCE).toContain(
      "Say what you found or did in plain language, briefly.",
    );
    // It is sent on every run: the gov.gr-era text was 5,924 characters.
    expect(COMPUTER_GUIDANCE.length).toBeLessThan(4200);
  });
});
