import { expect, test } from "bun:test";
import { scheduleInGreek } from "../../shared/i18n/schedule-words";
import { describeCron } from "../src/routines/schedule";

/**
 * Every shape `describeCron` words a schedule in has Greek in `scheduleInGreek`, and only a raw
 * expression is left as it is. A new shape in English fails here, not on a Greek screen.
 */

const SAMPLES = [
  "*/15 * * * *",
  "*/20 * * * *",
  "*/30 * * * *",
  "0,30 9 * * *",
  "0,15,45 18 * * *",
  "0 9 * * *",
  "30 7 * * 1-5",
  "0 9 * * 1",
  "0 9 * * 0",
  "0 9 * * 6",
  "0 9 * * 1,3,5",
  "15 18 * * 2,4",
  "0 8 1 * *",
  "0 8 2 * *",
  "0 8 3 * *",
  "0 8 11 * *",
  "0 8 22 * *",
  "0 8 31 * *",
  // Stranger than the shapes: worded as the raw expression, and left alone.
  "*/40 * * * *",
  "0 9 1 1 *",
  "0 9-17 * * *",
];

test("every worded schedule has Greek", () => {
  const missing = SAMPLES.map((cron) => describeCron(cron))
    .filter((words, index) => words !== SAMPLES[index])
    .filter((words) => scheduleInGreek(words) === null);
  expect(missing).toEqual([]);
});

test("a raw expression is left as it is", () => {
  for (const cron of ["*/40 * * * *", "0 9 1 1 *", "0 9-17 * * *"])
    expect(scheduleInGreek(describeCron(cron))).toBeNull();
});

test("the Greek reads as Greek says it", () => {
  expect(scheduleInGreek(describeCron("*/15 * * * *"))).toBe("Κάθε 15 λεπτά");
  expect(scheduleInGreek(describeCron("0,30 9 * * *"))).toBe(
    "Κάθε μέρα στις 09:00 και 09:30",
  );
  expect(scheduleInGreek(describeCron("30 7 * * 1-5"))).toBe(
    "Τις καθημερινές στις 07:30",
  );
  expect(scheduleInGreek(describeCron("0 9 * * 1"))).toBe(
    "Κάθε Δευτέρα στις 09:00",
  );
  expect(scheduleInGreek(describeCron("0 9 * * 1,3,5"))).toBe(
    "Κάθε Δευτέρα, Τετάρτη και Παρασκευή στις 09:00",
  );
  expect(scheduleInGreek(describeCron("0 8 1 * *"))).toBe(
    "Την 1η κάθε μήνα στις 08:00",
  );
});
