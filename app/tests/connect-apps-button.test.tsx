import { expect, test } from "bun:test";
import {
  pillFaces,
  SHOWN_APPS,
} from "@/components/app-sidebar/connect-apps-button";

/**
 * The faces on the sidebar's "Connect apps" pill: the apps already wired up first, then — up to
 * three in all — Gmail, Notion and Google Drive, the fixed trio, so the
 * button says what it is for before anything is connected. Decided without a DOM.
 */

test("with nothing connected the pill wears Gmail, Notion and Google Drive", () => {
  expect(pillFaces([]).map((face) => face.key)).toEqual([
    "45893410",
    "notion",
    "google-drive",
  ]);
});

test("a connected app leads, and the trio fills the rest without repeating it", () => {
  expect(
    pillFaces([{ key: "notion", logo: null }]).map((face) => face.key),
  ).toEqual(["notion", "45893410", "google-drive"]);
  expect(
    pillFaces([
      { key: "composio-gmail", logo: "https://logo.example/gmail.png" },
    ]).map((face) => face.key),
  ).toEqual(["composio-gmail", "45893410", "notion"]);
});

test("three connected apps leave no room for a filler, and a fourth is implied by the word", () => {
  const faces = pillFaces(
    ["slack", "linear", "github", "figma"].map((key) => ({ key, logo: null })),
  );
  expect(faces).toHaveLength(SHOWN_APPS);
  expect(faces.map((face) => face.key)).toEqual(["slack", "linear", "github"]);
});
