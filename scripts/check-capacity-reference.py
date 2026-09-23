#!/usr/bin/env python3
"""Independent numerical acceptance oracle; uses only Python's standard library.

Rules: docs/product/MVP.md and docs/system/MODEL.md. No production modules are
imported or read. All calendars below are artificial, not Russian work calendars.
--check is read-only; --write explicitly replaces only the owned JSON fixture.
"""

import argparse
import json
import random
import sys
from datetime import date, timedelta
from fractions import Fraction
from pathlib import Path


FIXTURE = Path(__file__).resolve().parents[1] / "tests/fixtures/capacity-acceptance.json"
SEED = 20260923


def decimal(value):
    """Render a Fraction by long division, without floating point or rounding."""
    value = Fraction(value)
    if not value:
        return "0"
    sign = "-" if value < 0 else ""
    numerator, denominator = abs(value.numerator), value.denominator
    rest = denominator
    for factor in (2, 5):
        while rest % factor == 0:
            rest //= factor
    if rest != 1:
        raise ValueError("The reference result is not a finite decimal")
    whole, remainder = divmod(numerator, denominator)
    digits = []
    while remainder:
        digit, remainder = divmod(remainder * 10, denominator)
        digits.append(str(digit))
    return sign + str(whole) + ("." + "".join(digits) if digits else "")


def quarter_dates(year, quarter):
    start = date(year, 3 * quarter - 2, 1)
    end = date(year + 1, 1, 1) if quarter == 4 else date(year, 3 * quarter + 1, 1)
    return [start + timedelta(days=i) for i in range((end - start).days)]


def reference(snapshot):
    """Evaluate the agreed equations using date membership and rational sums.

    Each working date is independently classified as available/absent using any
    matching inclusive interval. This is deliberately not an interval/decimal
    implementation copied from the application. Inputs here are valid fixtures;
    this oracle is not a second implementation of the application's validator.
    """
    days = quarter_dates(snapshot["year"], snapshot["quarter"])
    actual_dates = [date.fromisoformat(row["date"]) for row in snapshot["calendar"]]
    assert len(actual_dates) == len(set(actual_dates)) == len(days)
    assert set(actual_dates) == set(days)
    working = {date.fromisoformat(row["date"]) for row in snapshot["calendar"] if row["isWorking"]}
    members, member_hours = [], {}
    for member in sorted(snapshot["members"], key=lambda row: row["id"]):
        intervals = [(date.fromisoformat(row["startDate"]), date.fromisoformat(row["endDate"]))
                     for row in snapshot["absences"] if row["memberId"] == member["id"]]
        assert all(start <= end for start, end in intervals)
        available = [day for day in working if not any(start <= day <= end for start, end in intervals)]
        hours = len(available) * 8 * Fraction(member["fte"])
        member_hours[member["id"]] = hours
        members.append({
            "memberId": member["id"], "name": member["name"],
            "competencyId": member["competencyId"], "fte": member["fte"],
            "workingDays": len(working), "absenceWorkingDays": len(working) - len(available),
            "availableDays": len(available), "availableHours": decimal(hours),
        })
    total_hours = sum(member_hours.values(), Fraction(0))
    competencies = []
    for competency in sorted(snapshot["competencies"], key=lambda row: row["id"]):
        people = [member for member in snapshot["members"] if member["competencyId"] == competency["id"]]
        competencies.append({
            "competencyId": competency["id"], "name": competency["name"], "memberCount": len(people),
            "availableHours": decimal(sum((member_hours[member["id"]] for member in people), Fraction(0))),
        })
    percent = sum((Fraction(row["percent"]) for row in snapshot["directions"]), Fraction(0))
    budget_complete = percent == 100
    directions = []
    for direction in sorted(snapshot["directions"], key=lambda row: row["id"]):
        tasks = [task for task in snapshot["tasks"] if task["directionId"] == direction["id"]]
        estimates = [Fraction(task["estimateHours"]) for task in tasks if task["estimateHours"] is not None]
        missing = sum(task["estimateHours"] is None for task in tasks)
        budget = total_hours * Fraction(direction["percent"]) / 100
        demand = sum(estimates, Fraction(0))
        remaining = budget - demand
        complete = budget_complete and missing == 0
        directions.append({
            "directionId": direction["id"], "name": direction["name"], "percent": direction["percent"],
            "budgetHours": decimal(budget), "knownDemandHours": decimal(demand),
            "missingEstimateCount": missing, "budgetComplete": budget_complete,
            "demandComplete": missing == 0, "balanceComplete": complete,
            "remainingKnownHours": decimal(remaining), "overrunKnownHours": decimal(max(Fraction(0), -remaining)),
            "confirmedRemainingHours": decimal(remaining) if complete else None,
        })
    known = sum((Fraction(task["estimateHours"]) for task in snapshot["tasks"]
                 if task["estimateHours"] is not None), Fraction(0))
    missing_total = sum(task["estimateHours"] is None for task in snapshot["tasks"])
    return {
        "year": snapshot["year"], "quarter": snapshot["quarter"],
        "members": members, "competencies": competencies, "directions": directions,
        "allocation": {"totalPercent": decimal(percent), "status": "complete" if budget_complete
                       else "underallocated" if percent < 100 else "overallocated"},
        "totals": {
            "memberCount": len(members), "workingDays": len(working),
            "availableDays": sum(member["availableDays"] for member in members),
            "availableHours": decimal(total_hours), "knownDemandHours": decimal(known),
            "missingEstimateCount": missing_total, "demandComplete": missing_total == 0,
        },
    }


def snapshot(year=2032, quarter=1, working=None, ftes=("0.625",), percents=("20", "80")):
    dates = quarter_dates(year, quarter)
    selected = set(working if working is not None else [day.isoformat() for day in dates[:20]])
    return {
        "year": year, "quarter": quarter,
        "calendar": [{"date": day.isoformat(), "isWorking": day.isoformat() in selected} for day in dates],
        "calendarSource": {"kind": "manual", "version": "acceptance-artificial-v1", "baseWorkingDates": sorted(selected)},
        "competencies": [{"id": "dev", "name": "Разработка"}, {"id": "qa", "name": "Тестирование"},
                         {"id": "unused", "name": "Без участников"}],
        "members": [{"id": f"m{i + 1:02}", "name": f"Участник {i + 1}",
                     "competencyId": "dev" if i % 2 == 0 else "qa", "fte": fte} for i, fte in enumerate(ftes)],
        "absences": [],
        "directions": [{"id": f"d{i + 1:02}", "name": f"Направление {i + 1}", "percent": percent}
                       for i, percent in enumerate(percents)],
        "tasks": [],
    }


def absence(identifier, member, start, end):
    return {"id": identifier, "memberId": member, "startDate": start, "endDate": end}


def task(identifier, direction, estimate):
    return {"id": identifier, "name": f"Задача {identifier}", "directionId": direction, "estimateHours": estimate}


def at_path(value, path):
    for part in path.split("."):
        value = value[int(part)] if isinstance(value, list) else value[part]
    return value


def case(identifier, title, data, manual_checks=None, kind="control"):
    expected = reference(data)
    for path, value in (manual_checks or {}).items():
        actual = at_path(expected, path)
        assert actual == value and type(actual) is type(value), f"{identifier}: {path}: {actual!r} != {value!r}"
    return {"id": identifier, "kind": kind, "title": title,
            "manualChecks": manual_checks or {}, "snapshot": data, "expected": expected}


def controls():
    cases = []
    data = snapshot(ftes=("1", "0.5"))
    data["absences"] = [absence("a1", "m01", "2032-01-01", "2032-01-02"),
                        absence("a2", "m02", "2032-01-01", "2032-01-04")]
    data["tasks"] = [task("t1", "d01", "30"), task("t2", "d01", "20")]
    cases.append(case("agreed-208", "Согласованный пример: 208 ч, бюджет 41,6 ч, дефицит 8,4 ч", data, {
        "members.0.availableHours": "144", "members.1.availableHours": "64", "totals.availableHours": "208",
        "directions.0.budgetHours": "41.6", "directions.0.knownDemandHours": "50",
        "directions.0.confirmedRemainingHours": "-8.4", "directions.0.overrunKnownHours": "8.4",
    }))
    data = snapshot(percents=("20", "30", "10", "10", "30"))
    data["directions"][4]["name"] = "Встречи — резерв без задач"
    data["tasks"] = [task("t1", "d01", "12"), task("t2", "d01", "10"), task("t3", "d02", "24")]
    cases.append(case("full-base-100", "Все 100 ч распределяются, встречи не уменьшают базу", data, {
        "totals.availableHours": "100", "directions.0.budgetHours": "20",
        "directions.0.overrunKnownHours": "2", "directions.1.confirmedRemainingHours": "6",
        "directions.4.confirmedRemainingHours": "30", "allocation.totalPercent": "100",
    }))
    working = ["2028-01-01", "2028-01-03", "2028-01-04", "2028-01-05", "2028-02-28",
               "2028-02-29", "2028-03-01", "2028-03-29", "2028-03-30", "2028-03-31"]
    data = snapshot(2028, 1, working, ("0.75", "0.5", "1", "0"), ("100",))
    data["absences"] = [absence("a1", "m01", "2027-12-30", "2028-01-03"),
                        absence("a2", "m01", "2028-01-03", "2028-01-04"),
                        absence("a3", "m01", "2028-02-28", "2028-03-01"),
                        absence("a4", "m01", "2028-03-31", "2028-04-03"),
                        absence("a5", "m02", "2028-01-02", "2028-01-02"),
                        absence("a6", "m03", "2027-12-01", "2028-04-30"),
                        absence("a7", "m04", "2028-04-01", "2028-04-30")]
    cases.append(case("absence-union-leap-boundaries", "Пересечения, выходной, рабочая суббота, 29 февраля и границы", data, {
        "totals.workingDays": 10, "members.0.absenceWorkingDays": 7,
        "members.0.availableHours": "18", "members.1.absenceWorkingDays": 0,
        "members.1.availableHours": "40", "members.2.availableDays": 0,
        "members.3.availableDays": 10, "members.3.availableHours": "0", "totals.availableHours": "58",
    }))
    data = snapshot(ftes=("1", "0.75", "0.5", "0"), percents=("50", "25", "25"))
    data["tasks"] = [task("t1", "d01", "180"), task("t2", "d02", "90.000000000001")]
    cases.append(case("fte-and-tiny-overrun", "Ставки применены один раз; точный ноль и дефицит 0,000000000001 ч", data, {
        "members.0.availableHours": "160", "members.1.availableHours": "120",
        "members.2.availableHours": "80", "members.3.availableHours": "0", "totals.availableHours": "360",
        "directions.0.confirmedRemainingHours": "0", "directions.1.overrunKnownHours": "0.000000000001",
        "directions.1.confirmedRemainingHours": "-0.000000000001", "directions.2.confirmedRemainingHours": "90",
    }))
    data = snapshot(percents=("20", "20", "50"))
    data["tasks"] = [task("t1", "d01", "30"), task("t2", "d01", None), task("t3", "d02", "0")]
    cases.append(case("draft-90-null-and-zero", "90%: известный дефицит, null отдельно от явного нуля", data, {
        "allocation.totalPercent": "90", "allocation.status": "underallocated",
        "directions.0.overrunKnownHours": "10", "directions.0.confirmedRemainingHours": None,
        "directions.0.missingEstimateCount": 1, "directions.0.demandComplete": False,
        "directions.1.demandComplete": True, "directions.1.balanceComplete": False,
        "directions.1.remainingKnownHours": "20", "totals.demandComplete": False,
    }))
    data = snapshot(percents=("60", "50"))
    data["tasks"] = [task("t1", "d01", "60"), task("t2", "d02", None)]
    cases.append(case("draft-110", "110%: нет нормирования, даже известный нулевой остаток предварительный", data, {
        "allocation.totalPercent": "110", "allocation.status": "overallocated",
        "directions.0.budgetHours": "60", "directions.1.budgetHours": "50",
        "directions.0.remainingKnownHours": "0", "directions.0.confirmedRemainingHours": None,
        "directions.0.demandComplete": True, "directions.1.demandComplete": False,
    }))
    data = snapshot(working=["2032-01-01"], ftes=("0.12345678901234567890123456789",),
                    percents=("33.333333", "33.333333", "33.333334"))
    data["tasks"] = [task("t1", "d01", "0.329218"), task("t2", "d02", "0"), task("t3", "d03", None)]
    cases.append(case("exact-100-long-decimal", "Точные 100% и ставка с 29 десятичными знаками", data, {
        "totals.availableHours": "0.98765431209876543120987654312", "allocation.totalPercent": "100",
        "allocation.status": "complete", "directions.0.budgetComplete": True,
        "directions.1.demandComplete": True, "directions.2.demandComplete": False,
        "directions.2.confirmedRemainingHours": None,
    }))
    data = snapshot(percents=("33.333333", "33.333333", "33.333333"))
    data["tasks"] = [task("t1", "d01", "0")]
    cases.append(case("exact-99-999999", "99,999999% не равно 100%, без epsilon", data, {
        "allocation.totalPercent": "99.999999", "allocation.status": "underallocated",
        "directions.0.budgetHours": "33.333333", "directions.0.budgetComplete": False,
        "directions.0.confirmedRemainingHours": None,
    }))
    data = snapshot(ftes=(), percents=("20", "80"))
    data["tasks"] = [task("t1", "d01", "5.0001"), task("t2", "d01", None)]
    cases.append(case("empty-team-demand", "Пустая команда: нулевой бюджет, положительная потребность, отдельный резерв", data, {
        "totals.memberCount": 0, "totals.workingDays": 20, "totals.availableHours": "0",
        "directions.0.overrunKnownHours": "5.0001", "directions.0.confirmedRemainingHours": None,
        "directions.1.confirmedRemainingHours": "0", "directions.1.balanceComplete": True,
    }))
    for identifier, count, hours, remaining in (("team-five-before", 5, "400", "-100"),
                                               ("team-twenty", 20, "1600", "1100"),
                                               ("team-five-after", 5, "400", "-100")):
        ftes = tuple(("1", "0.75", "0.5", "0.25", "0")[i % 5] for i in range(count))
        data = snapshot(ftes=ftes, percents=("100",))
        data["tasks"] = [task("t1", "d01", "500")]
        cases.append(case(identifier, f"Последовательность 5 → 20 → 5: {count} участников", data, {
            "totals.memberCount": count, "totals.availableHours": hours,
            "directions.0.confirmedRemainingHours": remaining,
        }))
    return cases


def generated_cases():
    rng = random.Random(SEED)
    cases = []
    percentages = [("20", "30", "10", "10", "30"), ("20", "70"), ("60", "50"),
                   ("33.333333", "33.333333", "33.333334"), ("33.333333",) * 3, ("0", "100"), ()]
    rates = ("0", "0.00000000000000000001", "0.1", "0.33333333333333333333", "0.5", "0.75", "1")
    estimates = (None, "0", "0.00000000000000000001", "1", "12.345678901234567890123456789", "80", "999.99")
    for index in range(24):
        year, quarter = (2024, 2027, 2032)[index % 3], index % 4 + 1
        dates = quarter_dates(year, quarter)
        # Every 11th case has no workdays. Others include artificial working
        # weekends and non-working weekdays, independent of any legal calendar.
        working = [] if index % 11 == 0 else [day.isoformat() for day in dates if rng.randrange(4) != 0]
        count = (1, 0, 2, 5, 7, 20)[index % 6]
        data = snapshot(year, quarter, working, tuple(rng.choice(rates) for _ in range(count)),
                        percentages[index % len(percentages)])
        for member_index, member in enumerate(data["members"]):
            start = dates[0] + timedelta(days=rng.randrange(-15, len(dates) + 10))
            end = start + timedelta(days=rng.randrange(1, 35))
            data["absences"].append(absence(f"a{member_index:02}-1", member["id"], start.isoformat(), end.isoformat()))
            if member_index % 2 == 0:
                data["absences"].append(absence(f"a{member_index:02}-2", member["id"],
                                                (start + timedelta(days=1)).isoformat(), (end + timedelta(days=4)).isoformat()))
        for direction in data["directions"]:
            for task_index in range(rng.randrange(5)):
                data["tasks"].append(task(f"{direction['id']}-t{task_index}", direction["id"], rng.choice(estimates)))
        cases.append(case(f"generated-{index + 1:02}", f"Детерминированная комбинация {index + 1}, {year} Q{quarter}",
                          data, kind="generated"))
    return cases


def build_fixture():
    return {
        "schemaVersion": 1,
        "reference": {
            "rules": ["docs/product/MVP.md", "docs/system/MODEL.md"],
            "method": "Python stdlib datetime + fractions.Fraction; finite-decimal long division; no application imports",
            "calendarWarning": "Все даты и рабочие календари учебные; это не проверка календаря РФ или законодательных норм.",
            "seed": SEED,
        },
        "cases": controls() + generated_cases(),
    }


def first_difference(actual, expected, path="$fixture"):
    if type(actual) is not type(expected):
        return f"{path}: type {type(actual).__name__} != {type(expected).__name__}"
    if isinstance(expected, dict):
        if actual.keys() != expected.keys():
            return f"{path}: object keys differ"
        for key in expected:
            difference = first_difference(actual[key], expected[key], f"{path}.{key}")
            if difference:
                return difference
    elif isinstance(expected, list):
        if len(actual) != len(expected):
            return f"{path}: length {len(actual)} != {len(expected)}"
        for index, (left, right) in enumerate(zip(actual, expected)):
            difference = first_difference(left, right, f"{path}[{index}]")
            if difference:
                return difference
    elif actual != expected:
        return f"{path}: {actual!r} != {expected!r}"
    return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true", help="read-only verification of the committed fixture")
    mode.add_argument("--write", action="store_true", help="explicitly regenerate only tests/fixtures/capacity-acceptance.json")
    args = parser.parse_args()
    expected = build_fixture()
    if args.write:
        FIXTURE.parent.mkdir(parents=True, exist_ok=True)
        FIXTURE.write_text(json.dumps(expected, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"WROTE {len(expected['cases'])} cases: {FIXTURE}")
        return 0
    try:
        actual = json.loads(FIXTURE.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        print(f"FAIL: cannot read fixture: {error}", file=sys.stderr)
        return 1
    difference = first_difference(actual, expected)
    if difference:
        print(f"FAIL: reference mismatch: {difference}", file=sys.stderr)
        print("Fixture was not changed. Review rules and data before explicitly using --write.", file=sys.stderr)
        return 1
    print(f"PASS: {len(expected['cases'])} committed cases match the independent reference; no files written.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
