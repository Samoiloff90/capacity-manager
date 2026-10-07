import { addDecimal, decimalToString, divideDecimalBy100, multiplyDecimal, parseDecimal, type ExactDecimal } from "./decimal-exact";
import type { QuarterReserveMember } from "./quarter-capacity.types";

/**
 * A reserve is summed per person (DEC-038): available hours × the person's own share, or ×
 * the common share when the person has none. Shares are never averaged. total is null while
 * someone has no share at all; with nobody in the team it is 0 h once a common share is set.
 */
export function reserveByPerson(
  people: readonly { memberId: string; availableHours: string }[],
  common: string | null,
  own: ReadonlyMap<string, string>
): { members: QuarterReserveMember[]; total: string | null } {
  let total: ExactDecimal = parseDecimal("0");
  let complete = people.length > 0 || common !== null;
  const members = people.map((person) => {
    const percent = own.get(person.memberId) ?? common;
    const hours = percent === null ? null
      : divideDecimalBy100(multiplyDecimal(parseDecimal(person.availableHours), parseDecimal(percent)));
    if (hours === null) complete = false; else total = addDecimal(total, hours);
    return {
      memberId: person.memberId, availableHours: person.availableHours, percent,
      own: own.has(person.memberId), reserveHours: hours === null ? null : decimalToString(hours)
    };
  });
  return { members, total: complete ? decimalToString(total) : null };
}
