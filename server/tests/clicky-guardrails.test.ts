import { describe, expect, test } from "bun:test";
import type { ClickyAction } from "../../shared/clicky";
import {
  allowedKeys,
  assessAction,
  CLICKY_TYPE_LIMIT,
  canonicalKeys,
  commits,
  type GuardContext,
  guardFocusOf,
  guardTargetOf,
  hasControlCharacter,
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
/** A context where something on the page has the keyboard, for the key rules. */
const typing = {
  ...base,
  focused: { role: "textbox", name: "Notes", sensitive: false, editable: true },
};
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

  test("a scroll on the page is low risk; off it, or over nothing readable, it asks", () => {
    const scroll: ClickyAction = {
      kind: "scroll",
      at,
      deltaY: -400,
      label: "up",
    };
    expect(
      assessAction(scroll, { ...base, target: button("Results") }),
    ).toEqual({ risk: "low" });
    expect(assessAction(scroll, base).risk).toBe("confirm");
    expect(
      assessAction(scroll, {
        ...base,
        target: { role: "desktop", name: "", sensitive: false, inPage: false },
      }).risk,
    ).toBe("confirm");
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

  test("only everyday keys are pressed at all; closing the tab, reloading and pasting ask", () => {
    for (const keys of [
      "Tab",
      "Shift+Tab",
      "Escape",
      "ArrowDown",
      "Backspace",
      "Delete",
      "PageDown",
      "Home",
      "Control+a",
      "Control+C",
      "Control+Shift+t",
      "Shift+Control+z",
      "Control+f",
    ])
      expect({ keys, risk: assessAction(key(keys), typing).risk }).toEqual({
        keys,
        risk: "low",
      });
    for (const keys of [
      "Control+w",
      "Control+r",
      // The address bar and a new tab are the browser's: nothing there can be read.
      "Control+l",
      "Control+t",
      "Control+v",
      "Control+Shift+v",
      "Shift+Insert",
    ])
      expect({ keys, risk: assessAction(key(keys), typing).risk }).toEqual({
        keys,
        risk: "confirm",
      });
    for (const keys of [
      "Alt+F4",
      "Control+Q",
      "Control+Shift+W",
      "Control+Alt+T",
      "Alt+Tab",
      "F5",
      "F11",
      "Print",
      "Super+e",
      "Meta+L",
      "Hyper+a",
      "Control+Shift+i",
      "a",
      "Control+Alt+Delete",
      "Sleep",
      "",
      "Not a key",
    ])
      expect({ keys, risk: assessAction(key(keys), typing).risk }).toEqual({
        keys,
        risk: "blocked",
      });
  });

  test("keys and combinations have one spelling, which is what is rated and pressed", () => {
    expect(canonicalKeys("ctrl+A")).toBe("Control+a");
    expect(canonicalKeys("Shift+Control+T")).toBe("Control+Shift+t");
    expect(canonicalKeys("return")).toBe("Enter");
    expect(canonicalKeys(" ")).toBe("Space");
    expect(canonicalKeys("Control+KeyW")).toBe("Control+w");
    expect(canonicalKeys("Control")).toBeNull();
    expect(canonicalKeys("Control+")).toBeNull();
    expect(allowedKeys("cmd+l")).toBeNull();
    expect(allowedKeys("Control+L")).toBe("Control+l");
  });

  test("with nothing known to have the keyboard, a key or typing asks; another window takes nothing on a low yes", () => {
    expect(assessAction(key("Tab"), base).risk).toBe("confirm");
    expect(assessAction(type("hello", false), base).risk).toBe("confirm");
    const elsewhere = guardFocusOf({ window: "other", element: null, url: "" });
    expect(assessAction(key("Tab"), { ...base, focused: elsewhere }).risk).toBe(
      "confirm",
    );
    const nothing = guardFocusOf({
      window: "browser",
      element: null,
      url: "",
    });
    expect(nothing).toBeUndefined();
  });

  test("a button that sends its form asks, and typing into another site's frame is the person's", () => {
    const formButton = guardTargetOf({
      role: "button",
      name: "Next",
      sensitive: false,
      submits: true,
      inPage: true,
      url: "https://shop.example/",
    });
    expect(assessAction(click(), { ...base, target: formButton }).risk).toBe(
      "confirm",
    );
    const frame = guardTargetOf({
      role: "frame",
      name: "Card",
      sensitive: false,
      opaque: true,
      inPage: true,
      url: "https://shop.example/",
    });
    expect(assessAction(type("4242"), { ...base, target: frame }).risk).toBe(
      "yours",
    );
    expect(assessAction(click(), { ...base, target: frame }).risk).toBe(
      "confirm",
    );
    // A page under another window on the desktop is off the page.
    const covered = guardTargetOf({
      role: "button",
      name: "Next",
      sensitive: false,
      inPage: true,
      window: "other",
      url: "https://shop.example/",
    });
    expect(assessAction(click(), { ...base, target: covered }).risk).toBe(
      "confirm",
    );
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

  test("typing that ends with Enter is rated as Enter on that field: a search stays everyday, a form asks", () => {
    const typeAndEnter = (text: string): ClickyAction => ({
      kind: "type",
      text,
      at,
      label: "the field",
      pressEnter: true,
    });
    // A search box, by its role or its name, even inside a form (Google's is in one).
    for (const target of [
      { role: "searchbox", name: "Find", sensitive: false, inForm: true },
      { role: "combobox", name: "Αναζήτηση", sensitive: false, inForm: true },
      { role: "textbox", name: "Search gov.gr", sensitive: false },
    ])
      expect(
        assessAction(typeAndEnter("υπεύθυνη δήλωση"), { ...base, target }),
      ).toEqual({ risk: "low" });
    // A field in a form: Enter sends it.
    expect(
      assessAction(typeAndEnter("Maria"), {
        ...base,
        target: guardTargetOf({
          role: "textbox",
          name: "First name",
          sensitive: false,
          inForm: true,
          inPage: true,
          url: "https://gov.example/form",
        }),
      }),
    ).toEqual({ risk: "confirm", reason: "Enter can send the form it is in." });
    // A message box that sends on Enter, with no form around it.
    expect(
      assessAction(typeAndEnter("hello"), {
        ...base,
        target: { role: "textbox", name: "Message", sensitive: false },
      }),
    ).toEqual({ risk: "confirm", reason: "Enter can send what was typed." });
    // The same text without Enter sends nothing.
    expect(
      assessAction(
        { kind: "type", text: "Maria", at, label: "First name" },
        {
          ...base,
          target: {
            role: "textbox",
            name: "First name",
            sensitive: false,
            inForm: true,
          },
        },
      ),
    ).toEqual({ risk: "low" });
    // The stricter rules still come first: no Enter makes a secret field typeable.
    expect(
      assessAction(typeAndEnter("hunter2"), {
        ...base,
        target: { role: "textbox", name: "Password", sensitive: true },
      }).risk,
    ).toBe("blocked");
    // And the key on its own reads the form the same way.
    expect(
      assessAction(key("Enter"), {
        ...base,
        focused: guardFocusOf({
          window: "browser",
          element: {
            role: "textbox",
            name: "Email",
            sensitive: false,
            inForm: true,
          },
          url: "",
        }),
      }),
    ).toEqual({ risk: "confirm", reason: "Enter can send the form it is in." });
  });

  test("a search is a search by what the page says, or by a name that is one, never by a word inside another", () => {
    const enterIn = (target: Record<string, unknown>) =>
      assessAction(
        { kind: "type", text: "q", at, label: "it", pressEnter: true },
        {
          ...base,
          target: { role: "textbox", name: "", sensitive: false, ...target },
        },
      ).risk;
    expect(enterIn({ name: "Query", search: true })).toBe("low");
    expect(enterIn({ name: "Site search" })).toBe("low");
    expect(enterIn({ name: "#research notes" })).toBe("confirm");
    expect(enterIn({ name: "Research" })).toBe("confirm");
    // Never in a textarea or a rich editor, nor in a field named like something hard to undo.
    expect(enterIn({ name: "Search", multiline: true })).toBe("confirm");
    expect(enterIn({ name: "Search and delete", search: true })).toBe(
      "confirm",
    );
  });

  test("on the session's yes, deleting and leaving the site are not everyday", () => {
    const outsideAField = {
      ...base,
      focused: {
        role: "listitem",
        name: "Invoice from Bank",
        sensitive: false,
      },
    };
    for (const keys of ["Delete", "Backspace"]) {
      expect(assessAction(key(keys), outsideAField)).toEqual({
        risk: "confirm",
        reason: "Outside a text field, that key can delete what is selected.",
      });
      expect(assessAction(key(keys), typing).risk).toBe("low");
    }
    const link = (linkHost: string) =>
      assessAction(click(), {
        ...base,
        pageHost: "www.google.com",
        target: {
          role: "link",
          name: "Υπεύθυνη δήλωση",
          sensitive: false,
          linkHost,
        },
      });
    expect(link("www.gov.gr")).toEqual({
      risk: "confirm",
      reason: "That link opens another site.",
    });
    expect(link("www.google.com").risk).toBe("low");
    // The same site under another name is not leaving it.
    expect(link("support.google.com").risk).toBe("low");
    // The everyday words that are not everyday after all.
    for (const name of [
      "Archive",
      "Move to trash",
      "Discard draft",
      "Block user",
      "Report",
      "Mute",
      "Apply",
      "Book now",
      "Reserve a table",
      "I agree",
      "Update",
      "Clear all",
      "Empty bin",
      "End call",
      "Close",
      "Closing",
      "Unfollow",
      "Move",
      "Mark as spam",
      "Αρχειοθέτηση",
      "Μετακίνηση στον κάδο",
      "Απόρριψη",
      "Αποκλεισμός",
      "Αναφορά",
      "Σίγαση",
      "Εφαρμογή",
      "Κράτηση",
      "Συμφωνώ",
      "Ενημέρωση",
      "Εκκαθάριση",
      "Άδειασμα",
      "Τέλος",
      "Κλείσιμο",
      "Μετακίνηση",
      "Ανεπιθύμητο",
    ])
      expect({ name, commits: commits(name) }).toEqual({ name, commits: true });
    for (const name of [
      "Facebook",
      "Research",
      "Weekend",
      "Αποτελέσματα",
      "Ακαδημία",
      "Address",
    ])
      expect({ name, commits: commits(name) }).toEqual({
        name,
        commits: false,
      });
  });

  test("the reasons speak in the first person and never name Clicky", () => {
    const reasons = [
      assessAction(click(), { ...base, actionPolicy: "never" }),
      assessAction(key("Control+Alt+Delete"), typing),
      assessAction(type("a\tb"), { ...base, target: button("x") }),
      assessAction(type("x".repeat(CLICKY_TYPE_LIMIT + 1)), {
        ...base,
        target: button("x"),
      }),
      assessAction(type("x"), {
        ...base,
        target: { role: "textbox", name: "Code", sensitive: true },
      }),
      assessAction(click(), base),
      assessAction(key("Tab"), base),
      assessAction(click(), {
        ...base,
        target: { role: "desktop", name: "", sensitive: false, inPage: false },
      }),
      assessAction(key("Control+l"), typing),
    ].map((assessment) => assessment.reason ?? "");
    for (const reason of reasons) {
      expect(reason).not.toBe("");
      expect(reason).not.toContain("Clicky");
    }
    expect(reasons[0]).toBe("I'm set to guide only, so I never click or type.");
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
    // Whole words in English: "Address" is not "add", "Postcode" is not "post".
    expect(commits("Address")).toBe(false);
    expect(commits("Postcode")).toBe(false);
    for (const name of [
      "Share",
      "Invite people",
      "Add to cart",
      "Allow",
      "Authorize app",
      "Grant access",
      "Accept",
      "Approve",
      "Install",
      "Connect",
      "Save changes",
      "Post",
      "Reply",
      "Forward",
      "Merge",
      "Enable",
      "Disable",
      "Subscribe",
      "Upgrade",
      "Κοινοποίηση",
      "Κοινή χρήση",
      "Πρόσκληση",
      "Προσθήκη",
      "Αποδοχή",
      "Έγκριση",
      "Εγκατάσταση",
      "Σύνδεση",
      "Αποθήκευση",
      "Δημοσίευση",
      "Απάντηση",
      "Προώθηση",
      "Ενεργοποίηση",
      "Απενεργοποίηση",
    ])
      expect({ name, commits: commits(name) }).toEqual({ name, commits: true });
  });

  test("typed text with a line break, a tab or another control character is never typed", () => {
    const field = {
      ...base,
      target: { role: "textbox", name: "Search", sensitive: false },
    };
    for (const text of [
      "foo\n",
      "a\tsecret",
      "x\ry",
      "\u0000",
      "del\u007f",
      "\u001b[A",
    ])
      expect({ text, risk: assessAction(type(text), field).risk }).toEqual({
        text,
        risk: "blocked",
      });
    expect(assessAction(type("plain text, ünïcode ok"), field).risk).toBe(
      "low",
    );
    expect(hasControlCharacter("tab\there")).toBe(true);
    expect(hasControlCharacter("Ελληνικά 😀")).toBe(false);
  });

  test("the stems of committing words count however they end, and a dialog's buttons ask", () => {
    for (const name of [
      "Deletion",
      "Removal",
      "Approval",
      "Submission",
      "Revoke access",
      "Deactivate",
      "Unsubscribe",
      "Cancel my subscription",
      "Reset",
      "Leave group",
    ])
      expect({ name, commits: commits(name) }).toEqual({ name, commits: true });
    expect(commits("Cancel")).toBe(false);
    expect(commits("Ακύρωση")).toBe(false);
    const inDialog = guardTargetOf({
      role: "button",
      name: "OK",
      sensitive: false,
      inDialog: true,
      inPage: true,
      url: "https://shop.example/",
    });
    expect(assessAction(click(), { ...base, target: inDialog }).risk).toBe(
      "confirm",
    );
    expect(
      assessAction(key("Space"), {
        ...base,
        focused: guardFocusOf({
          window: "browser",
          element: {
            role: "button",
            name: "Continue",
            sensitive: false,
            inDialog: true,
          },
          url: "",
        }),
      }).risk,
    ).toBe("confirm");
  });
});
