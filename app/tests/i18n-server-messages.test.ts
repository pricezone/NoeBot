import { afterEach, expect, test } from "bun:test";
import { client, serverMessageOf } from "@/lib/client";
import { i18n } from "@/lib/i18n";
import {
  loadServerMessages,
  localizeServerMessage,
} from "@/lib/i18n/server-messages";
import { ensureLocale, resetI18nForTests } from "@/lib/i18n/set-locale";

/**
 * The server answers in English; the app says its sentences in the interface's language, exactly
 * or by pattern, and keeps the English for anything that compares it.
 */

const realFetch = globalThis.fetch;

afterEach(async () => {
  globalThis.fetch = realFetch;
  await resetI18nForTests();
});

async function inGreek() {
  await ensureLocale("el");
  await loadServerMessages();
}

test("in English a sentence is shown as the server sent it", () => {
  expect(localizeServerMessage("Channel not found.")).toBe(
    "Channel not found.",
  );
});

test("a sentence written as one literal is translated exactly", async () => {
  await inGreek();
  expect(localizeServerMessage("Channel not found.")).toBe(
    "Το κανάλι δεν βρέθηκε.",
  );
});

test("a sentence built with values is translated by its pattern, values kept", async () => {
  await inGreek();
  expect(
    localizeServerMessage("Weekly digest is not a Bot template here."),
  ).toBe("Το Weekly digest δεν είναι πρότυπο Bot εδώ.");
});

test("a sentence quoted inside another is translated too", async () => {
  await inGreek();
  expect(
    localizeServerMessage(
      "Email (e12) was refused, so nothing was filled in: A rule asks before this kind of action.",
    ),
  ).toBe(
    "Το Email (e12) απορρίφθηκε, οπότε δεν συμπληρώθηκε τίποτα: Ένας κανόνας ζητά έγκριση πριν από αυτό το είδος ενέργειας.",
  );
});

test("a sentence the catalog does not know stays English, never a key", async () => {
  await inGreek();
  expect(localizeServerMessage("Something new went wrong.")).toBe(
    "Something new went wrong.",
  );
});

test("client throws the translated sentence and keeps the English to compare", async () => {
  await inGreek();
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: "Agent not found." }), {
      status: 404,
    })) as unknown as typeof fetch;
  const failure = await client("/api/agents/x", "agent").catch(
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toBe("Ο πράκτορας δεν βρέθηκε.");
  expect(serverMessageOf(failure)).toBe("Agent not found.");
});

test("client's own fallback is translated when the server sent no sentence", async () => {
  await inGreek();
  globalThis.fetch = (async () =>
    new Response("<html>bad gateway</html>", {
      status: 502,
    })) as unknown as typeof fetch;
  const failure = await client("/api/x", "x", {
    fallback: "That request failed.",
  }).catch((error: unknown) => error);
  expect((failure as Error).message).toBe(
    i18n.t("That request failed.", { lng: "el" }),
  );
  expect(serverMessageOf(failure)).toBeUndefined();
});
