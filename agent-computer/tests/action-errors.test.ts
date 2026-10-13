import { describe, expect, test } from "bun:test";
import { parseFill, pickOption, wantsTicked } from "../src/acting";
import {
  explainActionFailure,
  isElementProblem,
  isRequestError,
  notATextField,
  summariseError,
} from "../src/action-errors";
import type { ElementProbe } from "../src/element-probe";

/**
 * What the Bot is told when an action on an element does not work.
 *
 * The defect this replaces: every Playwright error mentioning the locator came back as "that element
 * is not on the page any more, take a fresh snapshot", so a Bot facing a cookie banner, a disabled
 * button or a drop-down took snapshot after snapshot of an element that was there all along.
 */
const probe = (overrides: Partial<ElementProbe> = {}): ElementProbe => ({
  connected: true,
  tag: "button",
  type: "",
  role: "",
  disabled: false,
  readOnly: false,
  editable: false,
  checkable: false,
  hasPopup: false,
  visible: true,
  inViewport: true,
  ...overrides,
});

const timeout = new Error(
  "locator.click: Timeout 10000ms exceeded.\nCall log:\n  - waiting for locator('aria-ref=e5')\n    - locator resolved to <button>Pay</button>\n  - attempting click action",
);

const explain = (error: Error, found: ElementProbe | null, verb = "click") =>
  explainActionFailure({
    error,
    probe: found,
    ref: "e5",
    verb,
    timeoutMs: 10_000,
    refFor: (label) => (label === "Accept all" ? "e9" : undefined),
  });

describe("why an action did not work", () => {
  test("covered: names what is in front, its buttons with refs, and clicks nothing", () => {
    const error = explain(
      timeout,
      probe({
        cover: {
          label: "div.cookie-consent",
          text: "We use cookies",
          consent: true,
          buttons: ["Accept all", "Settings"],
        },
      }),
    );
    expect(isElementProblem(error) && error.problem).toBe("covered");
    expect(error.message).toContain("covered by div.cookie-consent");
    expect(error.message).toContain('e9 "Accept all"');
    expect(error.message).toContain('"Settings"');
    expect(error.message).toContain("Nothing was clicked for you");
    expect(error.message).not.toContain("Call log");
    if (isElementProblem(error))
      expect(error.details.coveredBy?.buttons).toEqual([
        { name: "Accept all", ref: "e9" },
        { name: "Settings" },
      ]);
  });

  test("covered, known only from Playwright's own words, still says so", () => {
    const error = explain(
      new Error(
        'locator.click: Timeout 10000ms exceeded.\nCall log:\n  - <div id="overlay">…</div> intercepts pointer events',
      ),
      probe(),
    );
    expect(isElementProblem(error) && error.problem).toBe("covered");
    expect(error.message).toContain('<div id="overlay">');
  });

  test("disabled says what usually enables it", () => {
    const error = explain(timeout, probe({ disabled: true }));
    expect(isElementProblem(error) && error.problem).toBe("disabled");
    expect(error.message).toContain("required fields");
  });

  test("hidden is not missing", () => {
    const error = explain(timeout, probe({ visible: false }));
    expect(isElementProblem(error) && error.problem).toBe("not_visible");
  });

  test("only an element that left the page asks for a fresh snapshot", () => {
    const gone = explain(timeout, null);
    expect(isElementProblem(gone) && gone.problem).toBe("detached");
    expect(gone.message).toContain("Take a fresh snapshot");
    for (const found of [probe({ disabled: true }), probe({ visible: false })])
      expect(explain(timeout, found).message).not.toContain("fresh snapshot");
  });

  test("a slow element is a timeout, in seconds, without the call log", () => {
    const error = explain(timeout, probe());
    expect(isElementProblem(error) && error.problem).toBe("timeout");
    expect(error.message).toBe(
      "e5 did not become ready to click within 10 seconds. Read the page or take a screenshot to see what it is waiting for.",
    );
  });

  test("a date in the wrong format is told the format", () => {
    const error = explain(
      new Error("locator.fill: Error: Malformed value"),
      probe({ tag: "input", type: "date", editable: true }),
      "type into",
    );
    expect(isElementProblem(error) && error.problem).toBe("invalid_value");
    expect(error.message).toContain("YYYY-MM-DD");
  });

  test("typing into a drop-down or a checkbox names the tool that fits", () => {
    const select = notATextField(
      "e2",
      probe({
        tag: "select",
        select: { options: ["A", "B"], multiple: false },
      }),
    );
    expect(select?.message).toContain("computer_select");
    expect(select?.message).toContain("A | B");
    expect(
      notATextField(
        "e3",
        probe({ tag: "input", type: "checkbox", checkable: true }),
      )?.message,
    ).toContain("computer_check");
    expect(
      notATextField("e4", probe({ tag: "input", type: "text", readOnly: true }))
        ?.message,
    ).toContain("read-only");
    expect(
      notATextField(
        "e5",
        probe({ tag: "input", type: "text", editable: true }),
      ),
    ).toBeUndefined();
  });

  test("a closed page is said plainly, not as an element problem", () => {
    const error = explain(
      new Error(
        "locator.click: Target page, context or browser has been closed",
      ),
      null,
    );
    expect(isElementProblem(error)).toBe(false);
    expect(error.message).toBe("The page was closed while this was happening.");
  });
});

describe("Playwright's errors, summarised", () => {
  test("the call log, colour codes and API prefix are dropped", () => {
    expect(
      summariseError(
        "page.goto: \u001b[31mnet::ERR_FAILED\u001b[39m at https://x.test/\nCall log:\n  - navigating to ...",
      ),
    ).toBe("net::ERR_FAILED at https://x.test/");
  });

  test("a long message is cut", () => {
    expect(summariseError("x".repeat(500)).length).toBe(300);
  });
});

describe("choosing an option", () => {
  const choices = [
    { label: "Greece", value: "gr", disabled: false },
    { label: "Cyprus", value: "cy", disabled: false },
    { label: "United Kingdom", value: "uk", disabled: false },
    { label: "United States", value: "us", disabled: false },
  ];

  test("by label, by value, ignoring case and spacing", () => {
    expect(pickOption(choices, "Cyprus")?.value).toBe("cy");
    expect(pickOption(choices, "gr")?.value).toBe("gr");
    expect(pickOption(choices, "  greece ")?.value).toBe("gr");
  });

  test("a unique beginning or part of a label, never an ambiguous one", () => {
    expect(pickOption(choices, "Cyp")?.value).toBe("cy");
    expect(pickOption(choices, "Kingdom")?.value).toBe("uk");
    expect(pickOption(choices, "United")).toBeUndefined();
    expect(pickOption(choices, "Spain")).toBeUndefined();
  });
});

test("what typing into a checkbox means", () => {
  expect(wantsTicked("yes")).toBe(true);
  expect(wantsTicked("ΝΑΙ")).toBe(true);
  expect(wantsTicked("false")).toBe(false);
  expect(wantsTicked("")).toBe(false);
  expect(wantsTicked("maybe")).toBeUndefined();
});

describe("a fill request", () => {
  test("each field names a ref and exactly one thing to put in it", () => {
    expect(
      parseFill(
        [
          { ref: "e1", text: "Ada" },
          { ref: "e2", checked: true },
          { ref: "e3", option: "Pro" },
          { ref: "e4", file: "cv.pdf" },
        ],
        { click: "e9" },
      ),
    ).toEqual({
      fields: [
        { ref: "e1", text: "Ada" },
        { ref: "e2", checked: true },
        { ref: "e3", option: "Pro" },
        { ref: "e4", file: "cv.pdf" },
      ],
      after: { click: "e9" },
    });
    expect(
      parseFill([{ ref: "e1", text: "" }], { submit: true }).after,
    ).toEqual({ submit: true });
  });

  test("malformed fields are refused as the caller's mistake", () => {
    for (const [fields, then] of [
      [[], undefined],
      [[{ ref: "e1" }], undefined],
      [[{ ref: "e1", text: "a", checked: true }], undefined],
      [[{ ref: "e1", checked: "yes" }], undefined],
      [[{ text: "a" }], undefined],
      [[{ ref: "e1", text: "a" }], { press: "Enter" }],
    ] as const) {
      let thrown: unknown;
      try {
        parseFill(fields, then);
      } catch (error) {
        thrown = error;
      }
      expect(isRequestError(thrown)).toBe(true);
    }
  });
});
