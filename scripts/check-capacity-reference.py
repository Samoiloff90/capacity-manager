#!/usr/bin/env python3
"""Independent numerical acceptance oracle; uses only Python's standard library.

Rules: docs/product/MVP.md and docs/system/MODEL.md; the quarter planner (format 2):
DEC-030, DEC-031, DEC-032, DEC-038, DEC-041, DEC-043 in docs/product/REQUIREMENTS.md.
No production modules are imported or read. All calendars below are artificial, not
Russian work calendars. --check is read-only; --write explicitly replaces only the two
owned JSON fixtures.
"""

import argparse
import json
import random
import sys
from datetime import date, timedelta
from fractions import Fraction
from pathlib import Path


FIXTURE = Path(__file__).resolve().parents[1] / "tests/fixtures/capacity-acceptance.json"
QUARTER_FIXTURE = Path(__file__).resolve().parents[1] / "tests/fixtures/quarter-acceptance.json"
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


# --- Quarter planner (format 2): sources, reserves by person, decisions on works -------------


def quarter_snapshot(days, ftes, directions, tasks=(), year=2033, quarter=2):
    """The first `days` dates of the quarter are working; each person has days × 8 × FTE hours."""
    dates = quarter_dates(year, quarter)
    working = [day.isoformat() for day in dates[:days]]
    return {
        "year": year, "quarter": quarter,
        "calendar": [{"date": day.isoformat(), "isWorking": index < days} for index, day in enumerate(dates)],
        "calendarSource": {"kind": "manual", "version": "acceptance-artificial-v1", "baseWorkingDates": working},
        "competencies": [{"id": "dev", "name": "Разработка"}],
        "members": [{"id": f"p{i + 1}", "name": f"Сотрудник {i + 1}", "competencyId": "dev", "fte": fte}
                    for i, fte in enumerate(ftes)],
        "absences": [],
        "directions": list(directions),
        "tasks": list(tasks),
    }


def work_source(identifier, name, percent):
    return {"id": identifier, "name": name, "percent": percent, "kind": "work", "memberPercents": []}


def reserve_source(identifier, name, percent, own=None):
    return {"id": identifier, "name": name, "percent": percent, "kind": "reserve",
            "memberPercents": [{"memberId": member, "percent": value} for member, value in (own or {}).items()]}


def quarter_work(identifier, source, estimate, mark):
    return {"id": identifier, "name": f"Работа {identifier}", "directionId": source, "estimateHours": estimate,
            "mark": mark, "link": None, "comment": None}


def quarter_reference(snapshot):
    """Budgets of sources from all available hours; a reserve summed per person with the own
    share instead of the common one; only works in the plan take a budget; a missing estimate
    is counted apart from 0. Written from the decisions, not from the application."""
    working = {date.fromisoformat(row["date"]) for row in snapshot["calendar"] if row["isWorking"]}
    hours_of = {}
    for member in snapshot["members"]:
        intervals = [(date.fromisoformat(row["startDate"]), date.fromisoformat(row["endDate"]))
                     for row in snapshot["absences"] if row["memberId"] == member["id"]]
        available = [day for day in working if not any(start <= day <= end for start, end in intervals)]
        hours_of[member["id"]] = len(available) * 8 * Fraction(member["fte"])
    total = sum(hours_of.values(), Fraction(0))
    nominal = sum((Fraction(row["percent"]) for row in snapshot["directions"] if row["percent"] is not None), Fraction(0))
    directions = []
    for source in snapshot["directions"]:
        reserve_members = []
        if source["kind"] == "work":
            quota_set = source["percent"] is not None
            budget = total * Fraction(source["percent"]) / 100 if quota_set else Fraction(0)
        else:
            own = {row["memberId"]: Fraction(row["percent"]) for row in source["memberPercents"]}
            common = Fraction(source["percent"]) if source["percent"] is not None else None
            quota_set = bool(snapshot["members"]) or common is not None
            budget = Fraction(0)
            for member in snapshot["members"]:
                share = own.get(member["id"], common)
                if share is None:
                    quota_set = False
                    reserve_members.append({"memberId": member["id"], "reserveHours": None})
                    continue
                person = hours_of[member["id"]] * share / 100
                budget += person
                reserve_members.append({"memberId": member["id"], "reserveHours": decimal(person)})
            if not quota_set:
                budget = Fraction(0)
        works = [row for row in snapshot["tasks"] if row["directionId"] == source["id"]]
        plan = [row for row in works if row["mark"] == "plan"]
        known = sum((Fraction(row["estimateHours"]) for row in plan if row["estimateHours"] is not None), Fraction(0))
        directions.append({
            "directionId": source["id"], "kind": source["kind"], "quotaSet": quota_set,
            "budgetHours": decimal(budget), "knownDemandHours": decimal(known),
            "missingEstimateCount": sum(row["estimateHours"] is None for row in plan),
            "remainingKnownHours": decimal(budget - known), "overrunKnownHours": decimal(max(Fraction(0), known - budget)),
            "planCount": len(plan), "candidateCount": sum(row["mark"] == "candidate" for row in works),
            "outCount": sum(row["mark"] == "out" for row in works), "reserveMembers": reserve_members,
            "_budget": budget, "_known": known, "_name": source["name"], "_percent": source["percent"],
        })
    allocated = sum((row["_budget"] for row in directions if row["quotaSet"]), Fraction(0))
    unallocated = total - allocated
    for_works = [row for row in directions if row["kind"] == "work"]
    over = [row for row in for_works if row["quotaSet"] and row["_known"] > row["_budget"]]
    fits = [row for row in for_works if row["quotaSet"] and row["_known"] <= row["_budget"]]
    plan = {
        "reserveCount": sum(row["kind"] == "reserve" for row in directions),
        "reserveHours": decimal(sum((row["_budget"] for row in directions if row["kind"] == "reserve" and row["quotaSet"]), Fraction(0))),
        "allocatedHours": decimal(allocated), "unallocatedHours": decimal(unallocated),
        "overallocated": unallocated < 0 if total > 0 else nominal > 100,
        "nominalPercent": decimal(nominal),
        "unsetQuotaCount": sum(not row["quotaSet"] for row in directions),
        "planCount": sum(row["planCount"] for row in for_works),
        "plannedKnownHours": decimal(sum((row["_known"] for row in for_works), Fraction(0))),
        "plannedMissingEstimateCount": sum(row["missingEstimateCount"] for row in for_works),
        "remainingHours": decimal(sum((row["_budget"] - row["_known"] for row in fits), Fraction(0))),
        "overrunHours": decimal(sum((row["_known"] - row["_budget"] for row in over), Fraction(0))),
        "overrunSourceCount": len(over),
    }
    return {"availableHours": decimal(total), "plan": plan, "directions": directions, "_total": total, "_allocated": allocated}


def round_half_away(value, places):
    scale = 10 ** places
    magnitude = (abs(value) * scale * 2 + 1) // 2
    return Fraction(magnitude if value >= 0 else -magnitude, scale)


def number_cell(value):
    """A number of the written workbook: hours to 0,01, half away from zero."""
    return float(decimal(round_half_away(value, 2)))


def excess_cell(value):
    """An overrun or an excess below a hundredth is written as «<0,01 ч», as on screen."""
    if value != 0 and abs(value) < Fraction(1, 100):
        return "<0,01 ч" if value > 0 else "−<0,01 ч"
    return number_cell(value)


def percent_text(value):
    text = decimal(value).replace(".", ",")
    return ("−" + text[1:] if text.startswith("-") else text) + "%"


def allocation_texts(allocated, total, nominal):
    """«Выделено источникам» and «Не распределено» in % of the capacity: hundredths, more places
    when hundredths would show 100% for a sum that is not, named beyond six places."""
    if total == 0:
        return percent_text(nominal), percent_text(100 - nominal)
    exact = allocated * 100 / total
    shown = round_half_away(exact, 2)
    if allocated != total:
        for places in range(3, 7):
            if shown != 100:
                break
            shown = round_half_away(exact, places)
        if shown == 100:
            return ("более 100%", "менее 0%") if allocated > total else ("менее 100%", "более 0%")
    return percent_text(shown), percent_text(100 - shown)


def report_expectation(snapshot, reference):
    """Cells of the written workbook: the summary figures and the table of sources."""
    plan = reference["plan"]
    total, allocated = reference["_total"], reference["_allocated"]
    missing = plan["plannedMissingEstimateCount"] > 0
    allocated_text, unallocated_text = allocation_texts(allocated, total, Fraction(plan["nominalPercent"]))
    summary = {
        "Доступно команде, ч": number_cell(total),
        "Резерв, ч": number_cell(Fraction(plan["reserveHours"])) if plan["reserveCount"] else "Не задан",
        ("Занято работами в плане, не менее, ч" if missing else "Занято работами в плане, ч"): number_cell(Fraction(plan["plannedKnownHours"])),
        "Работ в плане": plan["planCount"],
        "Работ в плане без оценки": plan["plannedMissingEstimateCount"],
        ("Остатки квот, не более, ч" if missing and plan["remainingHours"] != "0" else "Остатки квот, ч"): number_cell(Fraction(plan["remainingHours"])),
        "Перебор квот, ч": excess_cell(Fraction(plan["overrunHours"])),
        "Источников с перебором": plan["overrunSourceCount"],
        "Выделено источникам, ч": number_cell(allocated),
        "Выделено источникам, % ёмкости": allocated_text,
        "Не распределено, ч": excess_cell(total - allocated),
        "Не распределено, % ёмкости": unallocated_text,
        "Источников без доли": plan["unsetQuotaCount"],
    }
    sources = []
    for row in reference["directions"]:
        share = float(decimal(Fraction(row["_percent"]))) if row["quotaSet"] and row["_percent"] is not None else "не задана"
        if row["kind"] == "reserve":
            own = bool(next(source for source in snapshot["directions"] if source["id"] == row["directionId"])["memberPercents"])
            # With own shares the actual share differs from the common one: budget / capacity, to 0,01%.
            actual = None if not row["quotaSet"] else share if not own else float(decimal(round_half_away(row["_budget"] * 100 / total, 2))) if total else None
            sources.append([row["_name"], "Резерв", share, actual, number_cell(row["_budget"]) if row["quotaSet"] else None,
                            None, None, None, None, None, None])
            continue
        if not row["quotaSet"]:
            sources.append([row["_name"], "Работы", share, None, None, number_cell(row["_known"]), row["missingEstimateCount"],
                            None, None, row["candidateCount"], row["outCount"]])
            continue
        rest = row["_budget"] - row["_known"]
        sources.append([row["_name"], "Работы", share, share, number_cell(row["_budget"]), number_cell(row["_known"]),
                        row["missingEstimateCount"], number_cell(max(rest, Fraction(0))), excess_cell(max(-rest, Fraction(0))),
                        row["candidateCount"], row["outCount"]])
    sources.append(["Не распределено", None, None, unallocated_text, excess_cell(total - allocated), None, None, None, None, None, None])
    return {"summary": summary, "sources": sources}


def quarter_case(identifier, title, data, manual_checks, report=False):
    reference = quarter_reference(data)
    public = {"availableHours": reference["availableHours"], "plan": reference["plan"],
              "directions": [{key: value for key, value in row.items() if not key.startswith("_")} for row in reference["directions"]]}
    for path, value in manual_checks.items():
        actual = at_path(public, path)
        assert actual == value and type(actual) is type(value), f"{identifier}: {path}: {actual!r} != {value!r}"
    item = {"id": identifier, "title": title, "manualChecks": manual_checks, "snapshot": data, "expected": public}
    if report:
        item["report"] = report_expectation(data, reference)
    return item


def quarter_controls():
    cases = []
    # DEC-041, the PO's example: 1 000 h, quota 25% = 250 h, 200 h of other works in the plan.
    for identifier, mark, estimate, known, rest in (("dec041-on-review", "candidate", "28", "200", "50"),
                                                   ("dec041-included-28", "plan", "28", "228", "22"),
                                                   ("dec041-estimate-34", "plan", "34", "234", "16")):
        data = quarter_snapshot(25, ("1",) * 5, [work_source("requests", "Запросы", "25"), work_source("rest", "Остальное", "75")],
                                [quarter_work("w130", "requests", "130", "plan"), quarter_work("w70", "requests", "70", "plan"),
                                 quarter_work("w28", "requests", estimate, mark)])
        cases.append(quarter_case(identifier, f"DEC-041: квота 250 ч, другие работы 200 ч; работа {estimate} ч {mark}: {known} / {rest}", data, {
            "availableHours": "1000", "directions.0.budgetHours": "250",
            "directions.0.knownDemandHours": known, "directions.0.remainingKnownHours": rest,
        }, report=identifier == "dec041-estimate-34"))
    # DEC-038, the PO's example: 80 h × 30% + 40 h × 40% = 24 + 16 = 40 h, not an average share.
    data = quarter_snapshot(10, ("1", "0.5"), [reserve_source("meet", "Встречи", "30", {"p2": "40"}), work_source("product", "Продукт", "25")])
    cases.append(quarter_case("reserve-80x30-40x40", "Резерв: 80 ч × 30% + 40 ч × 40% = 40 ч", data, {
        "availableHours": "120", "directions.0.budgetHours": "40",
        "directions.0.reserveMembers.0.reserveHours": "24", "directions.0.reserveMembers.1.reserveHours": "16",
        "plan.reserveHours": "40", "directions.1.budgetHours": "30", "plan.allocatedHours": "70", "plan.unallocatedHours": "50",
    }, report=True))
    # DEC-032: the decision moves, the work stays; only «В плане» takes the 30 h quota.
    for step, (mark, known, rest, overrun) in enumerate((("candidate", "10", "20", "0"), ("plan", "38", "-8", "8"),
                                                        ("candidate", "10", "20", "0"), ("out", "10", "20", "0"),
                                                        ("plan", "38", "-8", "8")), start=1):
        data = quarter_snapshot(10, ("1", "0.5"), [work_source("ui", "УИ", "25"), work_source("rest", "Остальное", "50")],
                                [quarter_work("base", "ui", "10", "plan"), quarter_work("w28", "ui", "28", mark)])
        cases.append(quarter_case(f"review-plan-step-{step}", f"Рассмотрение ↔ план, шаг {step}: работа 28 ч — {mark}", data, {
            "directions.0.budgetHours": "30", "directions.0.knownDemandHours": known,
            "directions.0.remainingKnownHours": rest, "directions.0.overrunKnownHours": overrun,
            "directions.0.planCount": 2 if mark == "plan" else 1,
            "directions.0.candidateCount": 1 if mark == "candidate" else 0, "directions.0.outCount": 1 if mark == "out" else 0,
        }))
    # DEC-043: an empty estimate is unknown, 0 h is a known zero.
    data = quarter_snapshot(10, ("1", "0.5"), [work_source("ui", "УИ", "25")],
                            [quarter_work("ten", "ui", "10", "plan"), quarter_work("zero", "ui", "0", "plan"),
                             quarter_work("unknown", "ui", None, "plan")])
    cases.append(quarter_case("empty-is-not-zero", "Пусто ≠ 0: известно 10 ч, одна работа без оценки", data, {
        "directions.0.knownDemandHours": "10", "directions.0.missingEstimateCount": 1, "directions.0.planCount": 3,
        "plan.plannedMissingEstimateCount": 1, "plan.remainingHours": "20",
    }, report=True))
    data = quarter_snapshot(10, ("1", "0.5"), [work_source("ui", "УИ", "25")], [quarter_work("zero", "ui", "0", "plan")])
    cases.append(quarter_case("zero-is-known", "0 ч — известная нулевая оценка", data, {
        "directions.0.knownDemandHours": "0", "directions.0.missingEstimateCount": 0, "plan.remainingHours": "30",
    }))
    # DEC-030: under 100% the rest is not allocated; over 100% is an explicit problem; an unset share is not 0%.
    for identifier, sources, allocated, unallocated, overallocated in (
            ("under-allocation-80", [work_source("a", "А", "80")], "96", "24", False),
            ("over-allocation-106", [work_source("a", "А", "60"), work_source("b", "Б", "46")], "127.2", "-7.2", True),
            ("unset-share", [work_source("a", "А", None), work_source("b", "Б", "20")], "24", "96", False)):
        data = quarter_snapshot(10, ("1", "0.5"), sources)
        cases.append(quarter_case(identifier, f"Доли: выделено {allocated} ч из 120 ч", data, {
            "plan.allocatedHours": allocated, "plan.unallocatedHours": unallocated, "plan.overallocated": overallocated,
        }, report=identifier != "under-allocation-80"))
    # Small excesses and fractions: never rounded away.
    data = quarter_snapshot(20, ("1",), [work_source("a", "А", "50"), work_source("b", "Б", "50.0001")])
    cases.append(quarter_case("small-excess-of-shares", "50% + 50,0001% от 160 ч: превышение 0,00016 ч", data, {
        "plan.allocatedHours": "160.00016", "plan.unallocatedHours": "-0.00016", "plan.overallocated": True,
    }, report=True))
    data = quarter_snapshot(10, ("1",), [work_source("a", "А", "50"), work_source("b", "Б", "50")], [quarter_work("w", "a", "40.0001", "plan")])
    cases.append(quarter_case("small-overrun", "Квота 40 ч, в плане 40,0001 ч: перебор 0,0001 ч", data, {
        "directions.0.overrunKnownHours": "0.0001", "plan.overrunHours": "0.0001", "plan.overrunSourceCount": 1,
    }, report=True))
    data = quarter_snapshot(10, ("1",), [work_source("a", "А", "50"), work_source("b", "Б", "50")], [quarter_work("w", "a", "40.007", "plan")])
    cases.append(quarter_case("overrun-below-hundredth", "Перебор 0,007 ч: на экране и в файле «<0,01 ч», не 0,01", data, {
        "directions.0.overrunKnownHours": "0.007", "plan.overrunHours": "0.007",
    }, report=True))
    data = quarter_snapshot(10, ("1",), [work_source("works", "Работы", "70"), reserve_source("meet", "Встречи", "30", {"p1": "30.00001"})])
    cases.append(quarter_case("own-reserve-small-excess", "Своя доля резерва 30,00001%: выделено 80,000008 ч из 80 ч", data, {
        "directions.1.budgetHours": "24.000008", "plan.allocatedHours": "80.000008", "plan.unallocatedHours": "-0.000008",
    }, report=True))
    data = quarter_snapshot(13, ("0.75", "0.5"), [reserve_source("meet", "Встречи", "12.5", {"p1": "33.333"}), work_source("ui", "УИ", "37.5")],
                            [quarter_work("a", "ui", "12.5", "plan"), quarter_work("b", "ui", "36.25", "plan"), quarter_work("c", "ui", "7.75", "candidate")])
    cases.append(quarter_case("fractions", "Дробные ставки, доли и оценки: 78 + 52 ч, резерв 25,99974 + 6,5 ч", data, {
        "availableHours": "130", "directions.0.reserveMembers.0.reserveHours": "25.99974",
        "directions.0.reserveMembers.1.reserveHours": "6.5", "directions.0.budgetHours": "32.49974",
        "directions.1.budgetHours": "48.75", "directions.1.knownDemandHours": "48.75", "directions.1.remainingKnownHours": "0",
        "plan.unallocatedHours": "48.75026",
    }, report=True))
    return cases


def build_quarter_fixture():
    return {
        "schemaVersion": 1,
        "reference": {
            "rules": ["docs/product/REQUIREMENTS.md: DEC-030, DEC-031, DEC-032, DEC-038, DEC-041, DEC-043",
                      "docs/product/QUARTER_PLANNING_UX.md", "docs/architecture/QUARTER_PLANNING_PLAN.md: «Общий отчёт»"],
            "method": "Python stdlib fractions.Fraction; hand-written manual checks; no application imports",
            "calendarWarning": "Все даты и рабочие календари учебные; это не проверка календаря РФ или законодательных норм.",
        },
        "cases": quarter_controls(),
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
    mode.add_argument("--write", action="store_true",
                      help="explicitly regenerate only tests/fixtures/capacity-acceptance.json and quarter-acceptance.json")
    args = parser.parse_args()
    fixtures = ((FIXTURE, build_fixture()), (QUARTER_FIXTURE, build_quarter_fixture()))
    if args.write:
        for path, expected in fixtures:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(expected, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            print(f"WROTE {len(expected['cases'])} cases: {path}")
        return 0
    for path, expected in fixtures:
        try:
            actual = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as error:
            print(f"FAIL: cannot read fixture {path.name}: {error}", file=sys.stderr)
            return 1
        difference = first_difference(actual, expected)
        if difference:
            print(f"FAIL: reference mismatch in {path.name}: {difference}", file=sys.stderr)
            print("Fixture was not changed. Review rules and data before explicitly using --write.", file=sys.stderr)
            return 1
    counts = " and ".join(f"{len(expected['cases'])} ({path.name})" for path, expected in fixtures)
    print(f"PASS: {counts} committed cases match the independent reference; no files written.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
