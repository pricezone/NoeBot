import { appendFile, rename, stat } from "node:fs/promises";

/**
 * A running record of what the Bot's shell did, for the terminal window on the desktop to tail.
 *
 * The shell itself returns each command's output to the gateway, and that is the record that
 * matters: the audit row, the tool result the model reads. This is the copy a person watching the
 * desktop sees, in a terminal window, as it happens. It is a mirror of the shell, not a shell: the
 * window tails a file and nothing typed into it reaches a process.
 *
 * Best effort throughout. A command whose log line could not be written still ran and still answers;
 * a mirror that could fail the thing it mirrors would be a second way for a command to fail, with no
 * second reason.
 */

/** Past this the file is rotated once, so a chatty Bot cannot fill the disk through its mirror. */
const DEFAULT_MAX_BYTES = 1024 * 1024;

export type ShellLog = {
  /** A command is starting. Written the way a prompt would show it. */
  begin(command: string): void;
  /** Output as it arrives, on either stream. */
  write(chunk: string): void;
  /** The command finished. */
  end(outcome: {
    exitCode: number;
    timedOut: boolean;
    elapsedMs: number;
  }): void;
  /** Settle every pending append. A test seam; the shell never waits on this. */
  settled(): Promise<void>;
};

export function createShellLog(
  path: string,
  { maxBytes = DEFAULT_MAX_BYTES }: { maxBytes?: number } = {},
): ShellLog {
  /*
   * One append after another, in the order they were asked for. Two commands cannot run through one
   * shell at once today, but two chunks of one command arrive from two streams, and interleaving
   * their writes out of order would show output in an order the command never produced.
   */
  let queue: Promise<void> = Promise.resolve();

  const enqueue = (text: string) => {
    queue = queue
      .then(async () => {
        await rotateIfLarge();
        await appendFile(path, text, "utf8");
      })
      .catch(() => undefined);
  };

  async function rotateIfLarge(): Promise<void> {
    try {
      const { size } = await stat(path);
      if (size < maxBytes) return;
      await rename(path, `${path}.1`);
    } catch {
      // No file yet, or it cannot be moved. Either way the append below decides what happens next.
    }
  }

  return {
    begin(command) {
      enqueue(`\n$ ${command}\n`);
    },
    write(chunk) {
      if (chunk) enqueue(chunk);
    },
    end({ exitCode, timedOut, elapsedMs }) {
      const seconds = (elapsedMs / 1000).toFixed(1);
      enqueue(
        timedOut
          ? `[timed out after ${seconds}s]\n`
          : `[exit ${exitCode} · ${seconds}s]\n`,
      );
    },
    settled: () => queue,
  };
}
