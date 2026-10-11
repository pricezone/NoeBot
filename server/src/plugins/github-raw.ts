/**
 * One file out of a public GitHub repository, at one commit.
 *
 * The only outbound fetch the plugin installer makes, and it is kept narrow on purpose: the host is
 * fixed, the ref has to be a full commit hash, and the path is a list of plain segments. A plugin
 * is "whatever is at this commit", so what the index reviewed is what the installer fetches —
 * never a branch that moved since, and never an address a request supplied.
 *
 * Nothing here is logged but the status. A `SKILL.md` is public, and still: the installer runs
 * for any signed-in person, and a body in a log line is a body in whatever collects the logs.
 */

export type RawFile = {
  owner: string;
  repo: string;
  /** A full commit hash. A branch or a tag is refused rather than resolved. */
  ref: string;
  /** Slash-separated, relative to the repository root, no leading slash. */
  path: string;
};

export type RawFetchFailure =
  | "refused"
  | "not-found"
  | "too-large"
  | "unreachable";

export type RawFetchResult =
  | { ok: true; text: string }
  | { ok: false; reason: RawFetchFailure };

const GITHUB_NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const COMMIT = /^[0-9a-f]{40}$/;

/** What the index puts in `gitUrl`, and what the installer builds a raw address out of. */
export function githubRepositoryOf(
  gitUrl: string,
): { owner: string; repo: string } | null {
  let url: URL;
  try {
    url = new URL(gitUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname !== "github.com") return null;
  const [owner, repo] = url.pathname.replace(/^\/+/, "").split("/");
  if (!owner || !repo) return null;
  const name = repo.replace(/\.git$/, "");
  if (!GITHUB_NAME.test(owner) || !GITHUB_NAME.test(name) || name === "..")
    return null;
  return { owner, repo: name };
}

/** The raw address, or null when any part of the file's name is not one this fetcher will build. */
export function rawUrlFor(file: RawFile): string | null {
  if (!GITHUB_NAME.test(file.owner) || !GITHUB_NAME.test(file.repo))
    return null;
  if (!COMMIT.test(file.ref)) return null;
  const segments = file.path.split("/");
  if (
    segments.some(
      (segment) =>
        segment === "" ||
        segment === "." ||
        segment === ".." ||
        /[\\%?#]/.test(segment),
    )
  ) {
    return null;
  }
  return `https://raw.githubusercontent.com/${file.owner}/${file.repo}/${file.ref}/${segments.map(encodeURIComponent).join("/")}`;
}

/** Joins a plugin's `gitPath` and a path inside it, without a leading or doubled slash. */
export function joinRepositoryPath(...parts: string[]): string {
  return parts
    .flatMap((part) => part.split("/"))
    .filter((segment) => segment !== "")
    .join("/");
}

export async function fetchGithubRaw(
  file: RawFile,
  options: {
    maxBytes?: number;
    timeoutMs?: number;
    fetch?: typeof fetch;
  } = {},
): Promise<RawFetchResult> {
  const url = rawUrlFor(file);
  if (!url) return { ok: false, reason: "refused" };
  const maxBytes = options.maxBytes ?? 262_144;
  const doFetch = options.fetch ?? fetch;

  let response: Response;
  try {
    response = await doFetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      headers: { Accept: "text/plain, application/json;q=0.9, */*;q=0.1" },
    });
  } catch {
    return { ok: false, reason: "unreachable" };
  }

  if (response.status === 404) return { ok: false, reason: "not-found" };
  if (!response.ok) {
    console.error(
      JSON.stringify({
        type: "github-raw-fetch-failed",
        owner: file.owner,
        repo: file.repo,
        ref: file.ref,
        path: file.path,
        status: response.status,
      }),
    );
    // A redirect is a file that is not where the index said; it is not followed.
    return {
      ok: false,
      reason:
        response.status >= 300 && response.status < 400
          ? "refused"
          : "unreachable",
    };
  }

  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > maxBytes) return { ok: false, reason: "too-large" };

  const reader = response.body?.getReader();
  if (!reader) return { ok: true, text: "" };
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: "too-large" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  const joined = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(joined) };
}
