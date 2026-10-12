/**
 * The design's rule tables, typed. `avatar-map.json` is the source of truth the design handed
 * over; product tunes the tables there and nothing in code repeats their numbers.
 */

import map from "./avatar-map.json";

export type AvatarMap = {
  version: string;
  timing: {
    minDisplayMs: number;
    reactionMs: number;
    debounceMs: number;
    maxSameLoopBeforeSwitchMs: number;
  };
  intentRules: readonly {
    intent: string;
    examples: readonly string[];
    sequence: readonly string[];
  }[];
  sentimentReactions: readonly { userTone: string; face: string }[];
  outcomes: readonly { result: string; sequence: readonly string[] }[];
  toolMap: readonly { tool: string; animation: string }[];
  catalog: {
    expressions: readonly string[];
    actions: readonly string[];
    states: readonly string[];
  };
};

export const AVATAR_MAP: AvatarMap = map;

export const TIMING = AVATAR_MAP.timing;
