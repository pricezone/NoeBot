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

  /** A download as Playwright hands one over: its file arrives in `partial`, then `path()` answers. */
  function fakeDownload(
    partial: string,
    name: string,
    contents: string,
    options: { fail?: string; hold?: Promise<void> } = {},
  ) {
    const calls: string[] = [];
    const file = join(partial, `${crypto.randomUUID()}`);
    return {
      calls,
      download: {
        suggestedFilename: () => name,
        path: async () => {
          await options.hold;
          if (options.fail) throw new Error(options.fail);
          await Bun.write(file, contents);
          return file;
        },
        saveAs: async (target: string) => {
          calls.push("saveAs");
          await Bun.write(target, contents);
        },
        cancel: async () => {
          calls.push("cancel");
        },
        delete: async () => {
          calls.push("delete");
          await rm(file, { force: true });
        },
      },
    };
  }

  async function setUp(limits = {}) {
    const root = await mkdtemp(join(tmpdir(), "openbot-downloads-"));
    const partial = await mkdtemp(join(tmpdir(), "openbot-partial-"));
    roots.push(root, partial);
    let clock = 1_000;
    const keeper = createDownloadKeeper(createWorkspace(root), {
      limits,
      partialDir: () => partial,
      now: () => clock,
    });
    return {
      root,
      partial,
      keeper,
      advance: (ms: number) => {
        clock += ms;
      },
    };
  }

  test("a suggested name loses folders and control characters", () => {
    expect(safeFileName("../../etc/passwd")).toBe("passwd");
    expect(safeFileName("..\\secret.txt")).toBe("secret.txt");
    expect(safeFileName("a\u0000b?.pdf")).toBe("a_b_.pdf");
    expect(safeFileName("")).toBe("download");
    expect(safeFileName(`${"x".repeat(200)}.pdf`)).toEndWith(".pdf");
    expect(safeFileName(`${"x".repeat(200)}.pdf`).length).toBe(120);
  });

  test("saved under Downloads/, numbered when taken, reported once, the browser's copy deleted", async () => {
    const { root, partial, keeper } = await setUp();
    const end = keeper.acting("bot");
    const first = fakeDownload(partial, "statement.pdf", "first");
    keeper.receive("bot", first.download);
    expect(keeper.started("bot")).toBe(true);
    expect(await keeper.take("bot")).toEqual({
      download: { path: "Downloads/statement.pdf", bytes: 5 },
      notes: [],
    });
    expect(first.calls).toEqual(["saveAs", "delete"]);
    expect(keeper.started("bot")).toBe(false);
    keeper.receive(
      "bot",
      fakeDownload(partial, "statement.pdf", "second!").download,
    );
    end();
    expect((await keeper.take("bot")).download).toEqual({
      path: "Downloads/statement (1).pdf",
      bytes: 7,
    });
    expect(
      await readFile(join(root, "Downloads/statement (1).pdf"), "utf8"),
    ).toBe("second!");
  });

  test("a download no action started is cancelled and said", async () => {
    const { partial, keeper, advance } = await setUp({ graceMs: 5_000 });
    const unasked = fakeDownload(partial, "drive-by.exe", "x");
    keeper.receive("bot", unasked.download);
    expect(unasked.calls).toEqual(["cancel"]);
    expect((await keeper.take("bot")).notes[0]).toContain(
      "none of your actions asked for",
    );
    // Moments after an action ended it is still that action's; long after, it is not.
    keeper.acting("bot")();
    advance(1_000);
    const soon = fakeDownload(partial, "report.pdf", "ok");
    keeper.receive("bot", soon.download);
    expect(soon.calls).not.toContain("cancel");
    advance(10_000);
    const late = fakeDownload(partial, "late.pdf", "no");
    keeper.receive("bot", late.download);
    expect(late.calls).toEqual(["cancel"]);
  });

  test("a file over the per-file limit is not kept", async () => {
    const { root, partial, keeper } = await setUp({ fileBytes: 4 });
    keeper.acting("bot");
    keeper.receive(
      "bot",
      fakeDownload(partial, "big.bin", "123456789").download,
    );
    const taken = await keeper.take("bot");
    expect(taken.download).toBeUndefined();
    expect(taken.notes[0]).toContain("was not kept");
    expect(
      await readFile(join(root, "Downloads/big.bin"), "utf8").catch(() => null),
    ).toBeNull();
  });

  test("a file that would take the folder past its limit is not kept", async () => {
    const { root, partial, keeper } = await setUp({ folderBytes: 10 });
    await Bun.write(join(root, "Downloads/old.bin"), "12345678");
    keeper.acting("bot");
    keeper.receive("bot", fakeDownload(partial, "new.bin", "12345").download);
    const taken = await keeper.take("bot");
    expect(taken.download).toBeUndefined();
    expect(taken.notes[0]).toContain("folder would pass");
  });

  test("a download growing past the limit while it arrives is cancelled", async () => {
    const { partial, keeper } = await setUp({ fileBytes: 10, watchMs: 10 });
    keeper.acting("bot");
    let finish: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const growing = fakeDownload(partial, "huge.iso", "x", {
      hold,
      fail: "canceled",
    });
    keeper.receive("bot", growing.download);
    await Bun.write(join(partial, "in-progress"), "x".repeat(50));
    for (
      let wait = 0;
      wait < 50 && !growing.calls.includes("cancel");
      wait += 1
    )
      await Bun.sleep(10);
    expect(growing.calls).toContain("cancel");
    finish();
    const taken = await keeper.take("bot");
    expect(taken.notes.join(" ")).toContain("was cancelled");
  });

  test("a failed save becomes a note, and one still saving is reported later", async () => {
    const { partial, keeper } = await setUp();
    keeper.acting("bot");
    keeper.receive(
      "bot",
      fakeDownload(partial, "broken.zip", "x", { fail: "canceled" }).download,
    );
    expect(await keeper.take("bot")).toEqual({
      notes: ["The download of broken.zip was not kept: canceled."],
    });
    let finish: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => {
      finish = resolve;
    });
    keeper.receive(
      "bot",
      fakeDownload(partial, "big.iso", "iso", { hold }).download,
    );
    const early = await keeper.take("bot", 20);
    expect(early.download).toBeUndefined();
    expect(early.notes[0]).toContain("still being saved");
    finish();
    expect((await keeper.take("bot")).download?.path).toBe("Downloads/big.iso");
  });
});
