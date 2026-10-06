import { beforeEach, expect, test } from "bun:test";
import {
  clearReturnTo,
  isModalPath,
  readReturnTo,
  rememberReturnTo,
} from "@/lib/return-to";

/**
 * The modal shells close back to the last in-app location the app shell recorded. Nothing
 * recorded means the fallback; a modal path is never recorded, so a modal cannot name itself as
 * its own way out; and the memory is a plain module variable, not storage.
 */

beforeEach(clearReturnTo);

test("nothing remembered reads as the fallback", () => {
  expect(readReturnTo()).toBe("/");
  expect(readReturnTo("/channel/new")).toBe("/channel/new");
});

test("a remembered location comes back, search included", () => {
  rememberReturnTo("/channel/abc?panel=computer");
  expect(readReturnTo()).toBe("/channel/abc?panel=computer");
  rememberReturnTo("/group/xyz");
  expect(readReturnTo("/elsewhere")).toBe("/group/xyz");
});

test("modal paths and relative strings are ignored", () => {
  rememberReturnTo("/channel/abc");
  rememberReturnTo("/settings/bots");
  rememberReturnTo("/marketplace?tab=skills");
  rememberReturnTo("channel/other");
  rememberReturnTo("https://example.com/");
  expect(readReturnTo()).toBe("/channel/abc");
  expect(isModalPath("/settings")).toBe(true);
  expect(isModalPath("/marketplace")).toBe(true);
  expect(isModalPath("/channel/abc")).toBe(false);
});

test("clearing forgets", () => {
  rememberReturnTo("/channel/abc");
  clearReturnTo();
  expect(readReturnTo()).toBe("/");
});
