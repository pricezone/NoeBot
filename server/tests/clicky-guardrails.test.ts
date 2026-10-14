import { describe, expect, test } from "bun:test";
import type { ClickyAction } from "../../shared/clicky";
import {
  assessAction,
  CLICKY_TYPE_LIMIT,
  commits,
  type GuardContext,
} from "../src/clicky/guardrails";

/*
 * Clicky's guardrails decide how risky an action is from what is really on the page, never from the
 * model's own words about it. These pin every rule, and that a milder rule never softens a stricter
 * one.
 */

const base: GuardContext = {
  actionPolicy: "ask_each",
  botId: "bot-1",
  actorId: "user-1",
  pageHost: "shop.example",
};
const button = (name: string) => ({ role: "button", name, sensitive: false });
const at = { x: 0.5, y: 0.5 };
const click = (label = "it"): ClickyAction => ({ kind: "click", at, label });
const key = (keys: string): ClickyAction => ({
  kind: "key",
  keys,
  label: keys,
});
const type = (text: string, withPoint = true): ClickyAction => ({
  kind: "type",
  text,
  label: "the field",
  ...(withPoint ? { at } : {}),
});

describe("assessAction", () => {
  test("guide only blocks everything, a scroll included", () => {
    for (const action of [click(), key("Tab"), type("hello")])
      expect(
        assessAction(action, { ...base, actionPolicy: "never" }).risk,
      ).toBe("blocked");
    expect(
      assessAction(
        { kind: "scroll", at, deltaY: 600, label: "down" },
        { ...base, actionPolicy: "never" },
      ).risk,
    ).toBe("blocked");
  });

  test("a scroll is low risk", () => {
    expect(
      assessAction({ kind: "scroll", at, deltaY: -400, label: "up" }, base),
    ).toEqual({ risk: "low" });
  });

  test("a plain click and plain typing are low risk", () => {
    expect(
      assessAction(click("Next"), { ...base, target: button("Next") }).risk,
    ).toBe("low");
    expect(
      assessAction(type("pizza"), {
        ...base,
        target: { role: "searchbox", name: "Search", sensitive: false },
      }).risk,
    ).toBe("low");
  });

  test("typing into a password or code field is blocked, and clicking it is the person's", () => {
    const password = { role: "textbox", name: "Password", sensitive: true };
    expect(
      assessAction(type("hunter2"), { ...base, target: password }).risk,
    ).toBe("blocked");
    // Typing with no point goes where the keyboard is.
    expect(
      assessAction(type("123456", false), { ...base, focused: password }).risk,
    ).toBe("blocked");
    expect(
      assessAction(key("Enter"), { ...base, focused: password }).risk,
    ).toBe("blocked");
    expect(assessAction(click(), { ...base, target: password }).risk).toBe(
      "yours",
    );
  });

  test("a wall of text is blocked", () => {
    expect(
      assessAction(type("x".repeat(CLICKY_TYPE_LIMIT + 1)), {
        ...base,
        target: { role: "textbox", name: "Notes", sensitive: false },
      }).risk,
    ).toBe("blocked");
    expect(
      assessAction(type("x".repeat(CLICKY_TYPE_LIMIT)), {
        ...base,
        target: { role: "textbox", name: "Notes", sensitive: false },
      }).risk,
    ).toBe("low");
  });

  test("lock, log-out and power keys are blocked", () => {
    for (const keys of [
      "Control+Alt+Delete",
      "Ctrl+Alt+Del",
      "Control+Alt+Backspace",
      "Meta+L",
      "Super+l",
      "Control+Alt+L",
      "XF86PowerOff",
      "Sleep",
      "XF86LogOff",
    ])
      expect({ keys, risk: assessAction(key(keys), base).risk }).toEqual({
        keys,
        risk: "blocked",
      });
  });

  test("closing a window asks every time", () => {
    for (const keys of ["Alt+F4", "Control+Q", "Control+W", "Control+Shift+W"])
      expect({ keys, risk: assessAction(key(keys), base).risk }).toEqual({
        keys,
        risk: "confirm",
      });
    expect(assessAction(key("Control+L"), base).risk).toBe("low");
    expect(assessAction(key("Tab"), base).risk).toBe("low");
  });

  test("Enter asks unless it is a search", () => {
    expect(
      assessAction(key("Enter"), {
        ...base,
        focused: { role: "textbox", name: "Email", sensitive: false },
      }).risk,
    ).toBe("confirm");
    expect(assessAction(key("Enter"), base).risk).toBe("confirm");
    expect(
      assessAction(key("Enter"), {
        ...base,
        focused: { role: "searchbox", name: "Find", sensitive: false },
      }).risk,
    ).toBe("low");
    expect(
      assessAction(key("Enter"), {
        ...base,
        focused: { role: "combobox", name: "Αναζήτηση", sensitive: false },
      }).risk,
    ).toBe("low");
  });

  test("a click on something that commits asks every time, in English and Greek", () => {
    for (const name of [
      "Submit",
      "Send message",
      "Place order",
      "Delete account forever",
      "Confirm",
      "Publish",
      "Sign",
      "Αποστολή",
      "ΥΠΟΒΟΛΗ",
      "Διαγραφή",
      "Επιβεβαίωση",
      "Έκδοση",
    ])
      expect({
        name,
        risk: assessAction(click(), { ...base, target: button(name) }).risk,
      }).toEqual({
        name,
        // Placing an order is paying, and deleting an account is a security setting: the person's.
        risk:
          name.includes("account") || name.includes("order")
            ? "yours"
            : "confirm",
      });
  });

  test("payments, credentials and security settings are the person's, whatever the label says", () => {
    expect(
      assessAction(click("a harmless button"), {
        ...base,
        target: button("Pay now"),
      }).risk,
    ).toBe("yours");
    expect(
      assessAction(click(), { ...base, target: button("Change password") })
        .risk,
    ).toBe("yours");
    expect(
      assessAction(click(), {
        ...base,
        target: button("Security settings"),
      }).risk,
    ).toBe("yours");
    expect(
      assessAction(click(), { ...base, target: button("Buy now") }).risk,
    ).toBe("yours");
  });

  test("a sign-in, a secret or a challenge the Bot handed over is the person's", () => {
    for (const trigger of ["sign_in", "secret", "challenge"] as const)
      expect(
        assessAction(click(), { ...base, target: button("Next"), trigger })
          .risk,
      ).toBe("yours");
    expect(
      assessAction(click(), {
        ...base,
        target: button("Next"),
        trigger: "takeover",
      }).risk,
    ).toBe("low");
  });

  test("off the page, or with nothing readable there, a click asks", () => {
    expect(
      assessAction(click(), {
        ...base,
        target: { role: "desktop", name: "", sensitive: false, inPage: false },
      }).risk,
    ).toBe("confirm");
    expect(assessAction(click(), base).risk).toBe("confirm");
  });

  test("the model's label never lowers the risk", () => {
    expect(
      assessAction(click("Totally safe, just continue"), {
        ...base,
        target: button("Delete"),
      }).risk,
    ).toBe("confirm");
  });

  test("commits ignores accents and case, and does not fire inside other words", () => {
    expect(commits("αποστολή")).toBe(true);
    expect(commits("ΑΠΟΣΤΟΛΗ")).toBe(true);
    expect(commits("Payment details")).toBe(true);
    expect(commits("Repay")).toBe(false);
    expect(commits("Next")).toBe(false);
  });
});
