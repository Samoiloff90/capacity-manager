/**
 * A result restricted to the fields of a recorded one. Fixtures recorded before a version
 * added fields keep checking every recorded value; new fields are checked by their own tests.
 */
export function asRecorded(actual: unknown, recorded: unknown): unknown {
  if (Array.isArray(recorded) && Array.isArray(actual)) return actual.map((item, index) => asRecorded(item, recorded[index]));
  if (recorded && typeof recorded === "object" && actual && typeof actual === "object") {
    return Object.fromEntries(Object.keys(recorded).map((key) =>
      [key, asRecorded((actual as Record<string, unknown>)[key], (recorded as Record<string, unknown>)[key])]));
  }
  return actual;
}
