import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDialogKeeper } from "../src/dialogs";
import { createDownloadKeeper, safeFileName } from "../src/downloads";
import { createWorkspace } from "../src/workspace";

/** A dialog as Playwright hands one over, recording how it was answered. */
function fakeDialog(type: string, message: string, defaultValue = "") {
  const answers: Array<{ accepted: boolean; text?: string }> = [];
  return {
    answers,
    dialog: {
      type: () => type,
      message: () => message,
      defaultValue: () => defaultValue,
      accept: async (text?: string) => {
        answers.push({
          accepted: true,
          ...(text !== undefined ? { text } : {}),
        });
      },
      dismiss: async () => {
        answers.push({ accepted: false });
      },
    },
  };
}

describe("held dialogs", () => {
  test("a dialog is held, reported to whoever is waiting, and answered once", async () => {
    const keeper = createDialogKeeper();
    const waiting = keeper.next("bot");
    const { dialog, answers } = fakeDialog("prompt", "Your name?", "Anon");
    keeper.receive("bot", dialog);
    expect(await waiting.opened).toEqual({
      type: "prompt",
      message: "Your name?",
      defaultValue: "Anon",
    });
    expect(keeper.pending("bot")?.type).toBe("prompt");
    await keeper.answer("bot", true, "Ada");
    expect(answers).toEqual([{ accepted: true, text: "Ada" }]);
    expect(keeper.pending("bot")).toBeUndefined();
    await expect(keeper.answer("bot", true)).rejects.toThrow("no dialog open");
  });

  test("a confirm is accepted without text, even when text is given", async () => {
    const keeper = createDialogKeeper();
    const { dialog, answers } = fakeDialog("confirm", "Sure?");
    keeper.receive("bot", dialog);
    await keeper.answer("bot", true, "ignored");
    expect(answers).toEqual([{ accepted: true }]);
  });

  test("one nobody answers is dismissed after the hold, and said once", async () => {
    const keeper = createDialogKeeper({ holdMs: 20 });
    const { dialog, answers } = fakeDialog("confirm", "Delete everything?");
    keeper.receive("bot", dialog);
    await Bun.sleep(60);
    expect(answers).toEqual([{ accepted: false }]);
    expect(keeper.pending("bot")).toBeUndefined();
    await expect(keeper.answer("bot", true)).rejects.toThrow(
      "dismissed after a minute",
    );
    expect(keeper.takeExpired("bot")).toEqual({
      type: "confirm",
      message: "Delete everything?",
      dismissed: true,
    });
    expect(keeper.takeExpired("bot")).toBeUndefined();
  });

  test("while a person drives, a dialog is dismissed at once, as before", () => {
    const keeper = createDialogKeeper({ dismissAtOnce: () => true });
    const { dialog, answers } = fakeDialog("alert", "Hi");
    keeper.receive("bot", dialog);
    expect(answers).toEqual([{ accepted: false }]);
    expect(keeper.pending("bot")).toBeUndefined();
  });

  test("leaving a page the Bot asked to leave accepts its 'leave this site?' question", async () => {
    const keeper = createDialogKeeper();
    const { dialog, answers } = fakeDialog("beforeunload", "");
    await keeper.leaving("bot", async () => {
      keeper.receive("bot", dialog);
    });
    expect(answers).toEqual([{ accepted: true }]);
    // Outside a navigation it is held like any other.
    const held = fakeDialog("beforeunload", "");
    keeper.receive("bot", held.dialog);
    expect(keeper.pending("bot")?.type).toBe("beforeunload");
  });

  test("dialogs are kept apart per Bot and forgotten with the browser", () => {
    const keeper = createDialogKeeper();
    keeper.receive("one", fakeDialog("alert", "For one").dialog);
    expect(keeper.pending("two")).toBeUndefined();
    keeper.forget("one");
    expect(keeper.pending("one")).toBeUndefined();
  });
});

describe("downloads into the workspace", () => {
  const roots: string[] = [];
  afterAll(async () => {
    for (const root of roots) await rm(root, { recursive: true, force: true });
  });

  test("a suggested name loses folders and control characters", () => {
    expect(safeFileName("../../etc/passwd")).toBe("passwd");
    expect(safeFileName("..\\secret.txt")).toBe("secret.txt");
    expect(safeFileName("a\u0000b?.pdf")).toBe("a_b_.pdf");
    expect(safeFileName("")).toBe("download");
    expect(safeFileName(`${"x".repeat(200)}.pdf`)).toEndWith(".pdf");
    expect(safeFileName(`${"x".repeat(200)}.pdf`).length).toBe(120);
  });

  test("saved under Downloads/, numbered when taken, reported once", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-downloads-"));
    roots.push(root);
    const keeper = createDownloadKeeper(createWorkspace(root));
    const download = (name: string, contents: string) => ({
      suggestedFilename: () => name,
      saveAs: async (path: string) => {
        await Bun.write(path, contents);
      },
    });
    keeper.receive("bot", download("statement.pdf", "first"));
    expect(keeper.started("bot")).toBe(true);
    expect(await keeper.take("bot")).toEqual({
      download: { path: "Downloads/statement.pdf", bytes: 5 },
      notes: [],
    });
    expect(keeper.started("bot")).toBe(false);
    keeper.receive("bot", download("statement.pdf", "second!"));
    expect((await keeper.take("bot")).download).toEqual({
      path: "Downloads/statement (1).pdf",
      bytes: 7,
    });
    expect(
      await readFile(join(root, "Downloads/statement (1).pdf"), "utf8"),
    ).toBe("second!");
  });

  test("a failed save becomes a note, and one still saving is reported later", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-downloads-"));
    roots.push(root);
    const keeper = createDownloadKeeper(createWorkspace(root));
    keeper.receive("bot", {
      suggestedFilename: () => "broken.zip",
      saveAs: async () => {
        throw new Error("canceled");
      },
    });
    expect(await keeper.take("bot")).toEqual({
      notes: ["The download of broken.zip failed: canceled"],
    });
    let finish: () => void = () => undefined;
    keeper.receive("bot", {
      suggestedFilename: () => "big.iso",
      saveAs: (path: string) =>
        new Promise<void>((resolve) => {
          finish = () => {
            void Bun.write(path, "iso").then(() => resolve());
          };
        }),
    });
    const early = await keeper.take("bot", 20);
    expect(early.download).toBeUndefined();
    expect(early.notes[0]).toContain("still being saved");
    finish();
    expect((await keeper.take("bot")).download?.path).toBe("Downloads/big.iso");
  });
});
