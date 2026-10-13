import { describe, expect, test } from "bun:test";
import { environmentFor } from "../src/environment";

describe("what the supervisor tells a computer about its browser", () => {
  test("passes the deployment's browser mode to every per-Bot computer", () => {
    expect(
      environmentFor("invoice-collector", {
        COMPUTER_TOKEN: "secret",
        COMPUTER_BROWSER_MODE: "headed",
      }),
    ).toEqual([
      "COMPUTER_BOT_ID=invoice-collector",
      "COMPUTER_TOKEN=secret",
      "COMPUTER_BROWSER_MODE=headed",
    ]);
  });

  test("passes the browser language, the deployment's and this Bot's own only", () => {
    expect(
      environmentFor("sales-bot", {
        COMPUTER_BROWSER_LANG: "el-GR",
        COMPUTER_BROWSER_LANG_SALES_BOT: "de-DE",
        COMPUTER_BROWSER_LANG_SUPPORT: "fr-FR",
      }),
    ).toEqual([
      "COMPUTER_BOT_ID=sales-bot",
      "COMPUTER_BROWSER_LANG=el-GR",
      "COMPUTER_BROWSER_LANG_SALES_BOT=de-DE",
    ]);
  });

  test("does not invent a browser mode when the deployment left it unset", () => {
    expect(
      environmentFor("invoice-collector", { COMPUTER_TOKEN: "secret" }),
    ).toEqual(["COMPUTER_BOT_ID=invoice-collector", "COMPUTER_TOKEN=secret"]);
  });
});
