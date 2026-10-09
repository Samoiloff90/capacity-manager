import type { QuarterSnapshot, TaskMark } from "../domain/capacity/quarter-capacity.types";
import { isWebLink, QUARTER_INPUT_LIMITS } from "../domain/capacity/quarter-snapshot.validation";
import { pluralRu } from "../domain/capacity/quarter-totals";
import { formatPercent, isSizeLabel, parseEstimateInput, sumEstimates, type EstimateInput } from "../domain/capacity/source-plan";
import { parseTableText, toTableText } from "./table-text";

/**
 * Many works at once from a spreadsheet (QUARTER_PLANNING_UX.md, «Вставка строк из таблицы»;
 * DEC-039, DEC-043, DEC-050). Rows copied from Excel and, later, rows read from an .xlsx file
 * go through the same preview: columns are mapped to fields, every row is checked by the
 * rules of the work form, repeats are found, and nothing is added before confirmation.
 * Nothing here talks to the network or runs anything from the rows: cells are plain text.
 */

type Snapshot = QuarterSnapshot;
type Work = Snapshot["tasks"][number];

export type ImportField = "name" | "estimate" | "link" | "comment" | "source";
export type ColumnRole = ImportField | "skip";
export type TextField = Exclude<ImportField, "source">;

export const COLUMN_ROLES: readonly ColumnRole[] = ["name", "estimate", "link", "comment", "source", "skip"];
export const ROLE_LABELS: Readonly<Record<ColumnRole, string>> = {
  name: "Название", estimate: "Оценка, ч", link: "Ссылка", comment: "Комментарий", source: "Источник", skip: "Не загружать"
};

/** A guard against a wrong paste, not a business limit: a quarter list is tens of rows. */
export const IMPORT_LIMITS = { characters: 2_000_000, rows: 1000, columns: 60 } as const;

/** The original estimate kept in the comment when a row is added without an estimate (DEC-043). */
export const ORIGINAL_ESTIMATE = "исходная оценка";

/**
 * One import in progress: the copied cells, how the columns are read and what the user
 * changed in the preview. Kept per quarter and source while the project is open; never
 * written to the project file.
 */
export type ImportDraft = Readonly<{
  planId: string;
  /** The source whose window started the import (null: the table of sources); never changes. */
  openedFrom: string | null;
  /** Rows without a source of their own go here: the open source, or the one chosen in the window. */
  sourceId: string | null;
  cells: readonly (readonly string[])[];
  /** Line of each row in the copied selection, so «строка 7» stays the same after a partial add. */
  lines: readonly number[];
  hasHeader: boolean;
  roles: readonly ColumnRole[];
  /** Text fixed in the preview, by row. */
  edits: Readonly<Record<number, Readonly<Partial<Record<TextField, string>>>>>;
  /** Source chosen in the preview, by row. */
  sources: Readonly<Record<number, string>>;
  /** The user's own tick; otherwise a row is ticked unless it has an error or repeats a work. */
  checked: Readonly<Record<number, boolean>>;
  /** One decision for the whole import; it always starts on «На рассмотрение» (DEC-039). */
  mark: Exclude<TaskMark, "out">;
  /** Set after a partial add: the window shows what was added and what was not. */
  outcome: ImportOutcome | null;
  /** True when the rows exceeded IMPORT_LIMITS and were cut. */
  cut: boolean;
}>;

export type ImportOutcome = Readonly<{
  mark: Exclude<TaskMark, "out">;
  added: readonly Readonly<{ line: number; name: string; sourceName: string; estimate: string | null }>[];
  skipped: readonly Readonly<{ line: number; name: string; reason: string }>[];
  emptyLines: number;
}>;

export type RowIssue = Readonly<{
  /** error — cannot be added; repeat — unticked by default; warning and note — added as is. */
  level: "error" | "repeat" | "warning" | "note";
  field: ImportField | null;
  text: string;
  /** The estimate is not hours: «Добавить без оценки» keeps it in the comment. */
  withoutEstimate?: boolean;
}>;

export type PreviewRow = Readonly<{
  index: number;
  line: number;
  values: Readonly<Record<TextField, string>>;
  /** What the row says about its source, if a column is read as «Источник». */
  sourceText: string;
  sourceId: string | null;
  /** Shown in the source list while no source is resolved: why one has to be chosen. */
  sourceHint: string;
  estimate: string | null;
  issues: readonly RowIssue[];
  blocked: boolean;
  repeat: boolean;
  checked: boolean;
}>;

export type SourceGroup = Readonly<{ sourceId: string; count: number; estimates: readonly (string | null)[]; knownHours: string; missing: number }>;

export type ImportPreview = Readonly<{
  rows: readonly PreviewRow[];
  emptyLines: readonly number[];
  header: readonly string[] | null;
  columnCount: number;
  /** No column is read as «Название»: nothing can be added. */
  noNameColumn: boolean;
  /** No column is read as «Оценка, ч»: every work would come without an estimate. */
  noEstimateColumn: boolean;
  checked: readonly PreviewRow[];
  groups: readonly SourceGroup[];
  /** The quarter would hold more works than a snapshot allows. */
  overLimit: boolean;
}>;

/** A finished import that «Отменить вставку» removes, even after other actions. */
export type ImportBatch = Readonly<{
  id: string;
  planId: string;
  /** The works as they were added: a later change is named before the undo. */
  works: readonly Work[];
  mark: Exclude<TaskMark, "out">;
  /** The source whose window started the import (null: the table of sources); it shows the undo too. */
  openedFrom?: string | null;
}>;

export const importDraftKey = (planId: string, sourceId: string | null) => `${planId}:${sourceId ?? "*"}`;

// --- Reading the rows -------------------------------------------------------------------------

const nameCache = new Map<string, string>();
function normalizeName(value: string): string {
  let name = nameCache.get(value);
  if (name === undefined) {
    name = value.replace(/\s+/g, " ").trim().toLocaleLowerCase("ru").replace(/ё/g, "е");
    if (nameCache.size > 20000) nameCache.clear();
    nameCache.set(value, name);
  }
  return name;
}

const HEADER_WORDS: ReadonlyArray<[ImportField, ReadonlySet<string>]> = [
  ["name", new Set(["название", "наименование", "работа", "работы", "задача", "задачи", "заголовок", "тема", "title", "name", "summary", "task"])],
  ["estimate", new Set(["оценка", "оценки", "часы", "часов", "час", "ч", "трудоемкость", "трудозатраты", "estimate", "hours", "effort"])],
  ["link", new Set(["ссылка", "ссылки", "url", "link", "kaiten", "карточка", "адрес"])],
  ["comment", new Set(["комментарий", "комментарии", "примечание", "примечания", "прим", "описание", "comment", "comments", "note", "notes", "description"])],
  ["source", new Set(["источник", "источники", "заказчик", "направление", "поток", "source", "customer"])]
];

/** Headers of numbers that are not hours: sizes, points, identifiers (DEC-041). */
const NOT_HOURS = new Set(["размер", "размеры", "size", "sp", "story", "points", "point", "сложность", "баллы", "id", "№", "номер", "ид", "код", "приоритет"]);
/** Every word a header may consist of: a lone «Название работы» is a header, «Описание API» is a work. */
const HEADER_VOCABULARY = new Set([...HEADER_WORDS.flatMap(([, words]) => [...words]), ...NOT_HOURS, "на", "в", "по", "для", "полная", "план"]);

/** A header cell names a field: «Название работы», «Оценка, ч», «Ссылка на Kaiten»; the first word decides first. */
export function headerField(cell: string): ImportField | null {
  const words = headerWords(cell);
  if (!words.length || words.some((word) => NOT_HOURS.has(word))) return null;
  for (const [field, set] of HEADER_WORDS) if (set.has(words[0])) return field;
  for (const word of words.slice(1)) for (const [field, set] of HEADER_WORDS) if (set.has(word)) return field;
  return null;
}

const headerWords = (cell: string) => normalizeName(cell).split(/[^\p{L}\p{N}№]+/u).filter(Boolean);

/**
 * «Оценка, ч» of a copied cell: the rules of the work form (DEC-041, DEC-043), plus a number
 * with thousands separated by spaces as Excel shows it («1 200»).
 */
export function parseImportEstimate(text: string): EstimateInput {
  const value = text.replace(/[\u00a0\u202f]/g, " ").trim();
  // «1,200» from Excel in English is 1 200 h, in Russian 1,2 h: never guessed silently.
  if (/^[1-9]\d{0,2}(?:[.,]\d{3})+(?:\s*(?:ч|час|часа|часов|h)\.?)?$/i.test(value)) {
    return { kind: "invalid", message: `«${value}» — непонятно, тысячи это или дробная часть. Укажите часы без разделителя тысяч, например 1200 или 1,2.` };
  }
  const grouped = /^(\d{1,3}(?: \d{3})+)([.,]\d+)?(\s*(?:ч|час|часа|часов|h)\.?)?$/i.exec(value);
  return parseEstimateInput(grouped ? `${grouped[1].replace(/ /g, "")}${grouped[2] ?? ""}` : value);
}

function cellAt(row: readonly string[] | undefined, column: number): string {
  return column >= 0 ? row?.[column] ?? "" : "";
}

const isBlankRow = (row: readonly string[]) => row.every((cell) => !cell.trim());
const oneLine = (text: string) => text.replace(/[ \t]*[\r\n]+[ \t]*/g, " ");

/**
 * The first row is a header only if it reads like one: short cells, at least half of them (and
 * at least two) name a field, no link, hours or size. A lone cell must be a field name itself
 * («Название», «Название работы»), not a work that starts with such a word.
 */
function looksLikeHeader(row: readonly string[]): boolean {
  const cells = row.map((cell) => cell.trim()).filter(Boolean);
  if (!cells.length || cells.some((cell) => isWebLink(cell) || parseImportEstimate(cell).kind === "hours" || isSizeLabel(cell))) return false;
  // «ID» or «Размер» is a header too, only one that is not read (NOT_HOURS).
  const named = cells.filter((cell) => cell.length <= 40 && headerWords(cell).length <= 4
    && (headerField(cell) !== null || headerWords(cell).some((word) => NOT_HOURS.has(word))));
  if (cells.length === 1) return named.length === 1 && headerWords(cells[0]).every((word) => HEADER_VOCABULARY.has(word));
  return named.length >= 2 && named.length * 2 >= cells.length;
}

/** Card numbers and other identifiers: whole numbers going strictly up. */
function isIdentifierColumn(values: readonly string[]): boolean {
  if (values.length < 3 || !values.every((value) => /^\d+$/.test(value))) return false;
  return values.every((value, index) => index === 0 || Number(value) > Number(values[index - 1]));
}

/** Column roles from the header, then from the content for what the header did not name. */
export function guessRoles(cells: readonly (readonly string[])[], hasHeader: boolean, columnCount: number,
  snapshot: Pick<Snapshot, "directions">): ColumnRole[] {
  const roles: ColumnRole[] = Array.from({ length: columnCount }, () => "skip");
  const taken = new Set<ImportField>();
  const take = (column: number, field: ImportField) => {
    if (taken.has(field) || roles[column] !== "skip") return;
    roles[column] = field;
    taken.add(field);
  };
  if (hasHeader && cells[0]) cells[0].forEach((cell, column) => { if (column < columnCount) { const field = headerField(cell); if (field) take(column, field); } });

  const data = (hasHeader ? cells.slice(1) : cells).filter((row) => !isBlankRow(row));
  const share = (column: number, test: (cell: string) => boolean) => {
    const values = data.map((row) => cellAt(row, column).trim()).filter(Boolean);
    return values.length ? values.filter(test).length / values.length : 0;
  };
  const sourceNames = new Set(snapshot.directions.map((direction) => normalizeName(direction.name)));
  const free = () => roles.map((role, column) => role === "skip" ? column : -1).filter((column) => column >= 0);

  // By content: links, then hours — only without a header, from the only column that can be
  // hours and is not a list of identifiers; a header names its estimate itself, so sizes,
  // points and card numbers never become hours (DEC-041). Then source names and text.
  const values = (column: number) => data.map((row) => cellAt(row, column).trim()).filter(Boolean);
  for (const column of free()) if (share(column, (cell) => isWebLink(cell)) >= 0.5) take(column, "link");
  if (!hasHeader) {
    const numeric = free().filter((column) => share(column, (cell) => parseImportEstimate(cell).kind === "hours" || isSizeLabel(cell)) >= 0.6);
    if (numeric.length === 1 && !isIdentifierColumn(values(numeric[0]))) take(numeric[0], "estimate");
  }
  for (const column of free()) if (sourceNames.size && share(column, (cell) => sourceNames.has(normalizeName(cell))) >= 0.6) take(column, "source");
  const textual = (column: number) => share(column, (cell) => parseImportEstimate(cell).kind !== "hours" && !isSizeLabel(cell)) >= 0.6;
  for (const column of free()) if (textual(column)) take(column, "name");
  // Without a header only the next text column becomes the comment; with a header the user named it.
  if (!hasHeader) for (const column of free()) if (textual(column)) take(column, "comment");
  return roles;
}

/** A new import from copied text; the open source is the default for every row. */
export function createImportDraft(input: { planId: string; sourceId: string | null; text: string; snapshot: Snapshot }): ImportDraft {
  const text = input.text.length > IMPORT_LIMITS.characters ? input.text.slice(0, IMPORT_LIMITS.characters) : input.text;
  let cells = parseTableText(text);
  let cut = text !== input.text;
  // Trailing empty rows and columns of a selection are not data.
  while (cells.length && isBlankRow(cells[cells.length - 1])) cells.pop();
  let columnCount = 0;
  for (const row of cells) row.forEach((cell, column) => { if (cell.trim()) columnCount = Math.max(columnCount, column + 1); });
  if (columnCount > IMPORT_LIMITS.columns) { columnCount = IMPORT_LIMITS.columns; cut = true; }
  cells = cells.map((row) => Array.from({ length: columnCount }, (_, column) => row[column] ?? ""));
  const hasHeader = cells.length > 0 && looksLikeHeader(cells[0]);
  const keep = IMPORT_LIMITS.rows + (hasHeader ? 1 : 0);
  if (cells.length > keep) { cells = cells.slice(0, keep); cut = true; }
  return {
    planId: input.planId, openedFrom: input.sourceId, sourceId: input.sourceId, cells, lines: cells.map((_, index) => index + 1), hasHeader,
    roles: guessRoles(cells, hasHeader, columnCount, input.snapshot),
    edits: {}, sources: {}, checked: {}, mark: "candidate", outcome: null, cut
  };
}

// --- The preview -------------------------------------------------------------------------------

const MARK_PLACE: Record<TaskMark, string> = { candidate: "на рассмотрении", plan: "в плане квартала", out: "в «Не в этом квартале»" };

function linkKey(link: string): string | null {
  if (!isWebLink(link)) return null;
  try { return new URL(link).href.replace(/\/+$/, ""); }
  catch { return null; }
}

const works = (count: number) => `${count} ${pluralRu(count, "работа", "работы", "работ")}`;

/** Every row checked against the quarter: errors, repeats and what would be added where. */
export function previewImport(draft: ImportDraft, snapshot: Snapshot): ImportPreview {
  const column = (field: ImportField) => draft.roles.indexOf(field);
  const sourceColumn = column("source");
  const sourceById = new Map(snapshot.directions.map((direction) => [direction.id, direction]));
  const sourcesByName = new Map<string, Snapshot["directions"][number][]>();
  for (const direction of snapshot.directions) {
    const key = normalizeName(direction.name);
    sourcesByName.set(key, [...sourcesByName.get(key) ?? [], direction]);
  }
  const labels = sourceLabels(snapshot.directions);
  const sourceName = (id: string) => labels.get(id) ?? "Без названия";
  // A name of several sources is resolved by the user (R-005): one of those sources of works,
  // chosen in any row with that same value, serves every row with it, unless rows disagree.
  // Another source chosen for a row is that row's own choice.
  const confirmed = new Map<string, { ids: Set<string>; line: number }>();
  if (sourceColumn >= 0) {
    draft.cells.forEach((cells, index) => {
      const chosen = draft.sources[index];
      const key = normalizeName(cellAt(cells, sourceColumn).trim());
      if ((draft.hasHeader && index === 0) || chosen === undefined || !key || (sourcesByName.get(key)?.length ?? 0) < 2) return;
      const candidate = sourceById.get(chosen);
      if (candidate?.kind !== "work" || normalizeName(candidate.name) !== key) return;
      const known = confirmed.get(key) ?? { ids: new Set<string>(), line: draft.lines[index] ?? index + 1 };
      known.ids.add(chosen);
      confirmed.set(key, known);
    });
  }

  const byLink = new Map<string, Work>();
  const byExact = new Map<string, Work>();
  const byName = new Map<string, Work>();
  const exactKey = (sourceId: string, name: string, estimate: string | null, link: string | null) =>
    `${sourceId}\u0000${normalizeName(name)}\u0000${estimate ?? ""}\u0000${link ?? ""}`;
  for (const work of snapshot.tasks) {
    const key = work.link ? linkKey(work.link) : null;
    if (key && !byLink.has(key)) byLink.set(key, work);
    const exact = exactKey(work.directionId, work.name, work.estimateHours, key);
    if (!byExact.has(exact)) byExact.set(exact, work);
    const name = `${work.directionId}\u0000${normalizeName(work.name)}`;
    if (!byName.has(name)) byName.set(name, work);
  }
  const rowByLink = new Map<string, number>();
  const rowByExact = new Map<string, number>();
  const rowByName = new Map<string, number>();
  const describe = (work: Work) => `«${work.name}» («${sourceName(work.directionId)}», ${MARK_PLACE[work.mark]})`;

  const rows: PreviewRow[] = [];
  const emptyLines: number[] = [];
  draft.cells.forEach((cells, index) => {
    if (draft.hasHeader && index === 0) return;
    const line = draft.lines[index] ?? index + 1;
    const edit = draft.edits[index] ?? {};
    // Fields of a work are one line, as in the work form: a line break inside a cell becomes a space.
    const raw = (field: TextField) => edit[field] ?? oneLine(cellAt(cells, column(field)));
    const values = { name: raw("name"), estimate: raw("estimate"), link: raw("link"), comment: raw("comment") };
    const sourceText = cellAt(cells, sourceColumn).trim();
    if (isBlankRow(cells) && !Object.values(edit).some((value) => value?.trim()) && draft.sources[index] === undefined) {
      emptyLines.push(line);
      return;
    }

    const issues: RowIssue[] = [];
    const name = values.name.replace(/\s+/g, " ").trim();
    if (!name) issues.push({ level: "error", field: "name", text: "Нет названия." });
    else if (name.length > QUARTER_INPUT_LIMITS.nameCharacters) issues.push({ level: "error", field: "name", text: `Название длиннее ${QUARTER_INPUT_LIMITS.nameCharacters} символов.` });

    const parsed = parseImportEstimate(values.estimate);
    const estimate = parsed.kind === "hours" ? parsed.hours : null;
    if (parsed.kind === "invalid") issues.push({ level: "error", field: "estimate", text: parsed.message, withoutEstimate: true });
    else if (parsed.kind === "empty") issues.push({ level: "warning", field: "estimate", text: "Без оценки." });
    else if (parsed.hours === "0") issues.push({ level: "note", field: "estimate", text: "Указана нулевая трудоёмкость. Если оценка неизвестна, очистите поле." });

    const link = values.link.trim();
    if (link && !isWebLink(link)) issues.push({ level: "error", field: "link", text: "Ссылка не распознана: адрес должен начинаться с https:// или http:// — например, адрес карточки Kaiten." });
    const comment = values.comment.trim();
    if (comment.length > QUARTER_INPUT_LIMITS.commentCharacters) issues.push({ level: "error", field: "comment", text: `Комментарий длиннее ${QUARTER_INPUT_LIMITS.commentCharacters} символов.` });

    // Sources are never created or swapped silently (DEC-050). A source chosen in the preview is
    // the only one checked: if it was deleted or became a reserve, the row waits for a new choice
    // instead of falling back to its text or the open source. A name of several sources — of
    // works, or of works and a reserve — is not guessed either (R-005).
    let sourceId: string | null = null;
    let sourceHint = "— выберите —";
    const sourceError = (text: string, hint: string) => {
      issues.push({ level: "error", field: "source", text });
      sourceHint = hint;
    };
    const chosen = draft.sources[index];
    if (chosen !== undefined) {
      const direction = sourceById.get(chosen);
      if (direction?.kind === "work") sourceId = chosen;
      else if (direction) sourceError(`Выбранный источник «${sourceName(chosen)}» стал резервом: работы в него не добавляются. Выберите источник работ.`, `«${sourceName(chosen)}» — резерв`);
      else sourceError("Выбранный источник удалён из квартала. Выберите источник.", "— выбранный удалён —");
    } else if (sourceColumn >= 0 && sourceText) {
      const key = normalizeName(sourceText);
      const found = sourcesByName.get(key) ?? [];
      const forWorks = found.filter((direction) => direction.kind === "work");
      const decided = confirmed.get(key);
      if (found.length === 1 && forWorks.length === 1) sourceId = forWorks[0].id;
      else if (found.length > 1 && decided?.ids.size === 1) {
        sourceId = [...decided.ids][0];
        issues.push({ level: "note", field: "source", text: `Источник выбран для «${sourceText}» в строке ${decided.line}: ${sourceName(sourceId)}.` });
      } else if (forWorks.length > 1) sourceError(`Источников с названием «${sourceText}» в квартале ${forWorks.length}. Выберите нужный — выбор подойдёт и для других строк с этим названием.`, `«${sourceText}» — несколько`);
      else if (forWorks.length === 1) sourceError(`«${sourceText}» — так называются источник работ и резерв. Резерв работы не принимает: выберите источник работ — выбор подойдёт и для других строк с этим названием.`, `«${sourceText}» — выберите источник работ`);
      else if (found.length) sourceError(`«${sourceText}» — резерв: работы в него не добавляются. Выберите источник работ.`, `«${sourceText}» — резерв`);
      else sourceError(`Источника «${sourceText}» нет в этом квартале. Источники при загрузке не создаются: выберите существующий.`, `«${sourceText}» — нет такого`);
    } else if (draft.sourceId) {
      const direction = sourceById.get(draft.sourceId);
      if (direction?.kind === "work") sourceId = draft.sourceId;
      else sourceError("Источник для строк без своего удалён или стал резервом. Выберите источник.", "— выберите —");
    } else sourceError("Не указан источник.", "— выберите —");

    // Repeats: a link already in the quarter or above, the same work again, then a similar name.
    const key = link ? linkKey(link) : null;
    if (name && sourceId) {
      const exact = exactKey(sourceId, name, estimate, key);
      const nameKey = `${sourceId}\u0000${normalizeName(name)}`;
      const linkWork = key ? byLink.get(key) : undefined;
      const linkRow = key ? rowByLink.get(key) : undefined;
      if (linkWork) issues.push({ level: "repeat", field: "link", text: `Ссылка уже есть у работы ${describe(linkWork)}.` });
      else if (linkRow !== undefined) issues.push({ level: "repeat", field: "link", text: `Та же ссылка, что в строке ${linkRow}.` });
      else if (byExact.has(exact)) issues.push({ level: "repeat", field: "name", text: `Такая работа уже есть: ${describe(byExact.get(exact)!)}.` });
      else if (rowByExact.has(exact)) issues.push({ level: "repeat", field: "name", text: `Повтор строки ${rowByExact.get(exact)}.` });
      else if (byName.has(nameKey)) issues.push({ level: "warning", field: "name", text: `Работа с таким названием уже есть: ${describe(byName.get(nameKey)!)}.` });
      else if (rowByName.has(nameKey)) issues.push({ level: "warning", field: "name", text: `Такое же название в строке ${rowByName.get(nameKey)}.` });
    }

    const blocked = issues.some((issue) => issue.level === "error");
    const repeat = issues.some((issue) => issue.level === "repeat");
    if (!blocked && name && sourceId) {
      if (key && !rowByLink.has(key)) rowByLink.set(key, line);
      const exact = exactKey(sourceId, name, estimate, key);
      if (!rowByExact.has(exact)) rowByExact.set(exact, line);
      const nameKey = `${sourceId}\u0000${normalizeName(name)}`;
      if (!rowByName.has(nameKey)) rowByName.set(nameKey, line);
    }
    const checked = !blocked && (draft.checked[index] ?? !repeat);
    rows.push({ index, line, values, sourceText, sourceId, sourceHint, estimate, issues, blocked, repeat, checked });
  });

  const checked = rows.filter((row) => row.checked);
  const groups = new Map<string, { sourceId: string; count: number; estimates: (string | null)[] }>();
  for (const row of checked) {
    const group = groups.get(row.sourceId!) ?? { sourceId: row.sourceId!, count: 0, estimates: [] };
    group.count += 1;
    group.estimates.push(row.estimate);
    groups.set(row.sourceId!, group);
  }
  // Groups in the order of the quarter's sources, as in the table of sources.
  const order = new Map(snapshot.directions.map((direction, index) => [direction.id, index]));
  return {
    rows, emptyLines,
    header: draft.hasHeader && draft.cells[0] ? draft.cells[0] : null,
    columnCount: draft.roles.length,
    noNameColumn: column("name") < 0,
    noEstimateColumn: column("estimate") < 0,
    checked,
    groups: [...groups.values()].sort((a, b) => (order.get(a.sourceId) ?? 0) - (order.get(b.sourceId) ?? 0)).map((group) => ({
      ...group,
      ...sumEstimates(group.estimates)
    })),
    overLimit: snapshot.tasks.length + checked.length > QUARTER_INPUT_LIMITS.entitiesPerCollection
  };
}

/**
 * Names of the sources of works as the preview lists them. Sources may share a name (nothing
 * forbids it); those get their place in the quarter and their share, so the choice is visible.
 */
export function sourceLabels(directions: Snapshot["directions"]): ReadonlyMap<string, string> {
  const named = (direction: Snapshot["directions"][number]) => direction.name.trim() || "Без названия";
  const counts = new Map<string, number>();
  for (const direction of directions) {
    if (direction.kind === "work") counts.set(normalizeName(named(direction)), (counts.get(normalizeName(named(direction))) ?? 0) + 1);
  }
  return new Map(directions.map((direction, index) => {
    const name = named(direction);
    if ((counts.get(normalizeName(name)) ?? 0) < 2) return [direction.id, name];
    const share = direction.percent === null ? "доля не задана" : formatPercent(direction.percent);
    return [direction.id, `${name} (${index + 1}-й в списке, ${share})`];
  }));
}

/** «6 работ: 132 ч и 2 без оценки». */
export function describeGroup(group: Pick<SourceGroup, "count" | "knownHours" | "missing">, format: (value: string) => string): string {
  const parts = [group.count > group.missing ? format(group.knownHours) : "", group.missing ? `${group.missing} без оценки` : ""].filter(Boolean);
  return `${works(group.count)}: ${parts.join(" и ")}`;
}

// --- Changes in the preview --------------------------------------------------------------------

export function setRowText(draft: ImportDraft, index: number, field: TextField, value: string): ImportDraft {
  return { ...draft, edits: { ...draft.edits, [index]: { ...draft.edits[index], [field]: value } } };
}

export function setRowSource(draft: ImportDraft, index: number, sourceId: string): ImportDraft {
  return { ...draft, sources: { ...draft.sources, [index]: sourceId } };
}

export function setRowChecked(draft: ImportDraft, index: number, checked: boolean): ImportDraft {
  return { ...draft, checked: { ...draft.checked, [index]: checked } };
}

/** «Добавить без оценки»: the estimate becomes empty, the original goes to the comment (DEC-043). */
export function withoutEstimate(draft: ImportDraft, row: PreviewRow): ImportDraft {
  const original = row.values.estimate.trim();
  const comment = row.values.comment.trim();
  const note = `${ORIGINAL_ESTIMATE}: ${original}`;
  const checked = { ...draft.checked };
  delete checked[row.index];
  return {
    ...draft, checked,
    edits: { ...draft.edits, [row.index]: { ...draft.edits[row.index], estimate: "", comment: comment ? `${comment}; ${note}` : note } }
  };
}

/** A column gets a role; the column that had it is not read any more. */
export function setColumnRole(draft: ImportDraft, column: number, role: ColumnRole): ImportDraft {
  const roles = draft.roles.map((current, index) => index === column ? role : role !== "skip" && current === role ? "skip" : current);
  return { ...draft, roles };
}

/** Switching the header row reads the columns again by its names. */
export function setHasHeader(draft: ImportDraft, hasHeader: boolean, snapshot: Snapshot): ImportDraft {
  return { ...draft, hasHeader, roles: guessRoles(draft.cells, hasHeader, draft.roles.length, snapshot) };
}

// --- Adding ----------------------------------------------------------------------------------

const firstReason = (row: PreviewRow) =>
  row.issues.find((issue) => issue.level === "error")?.text ?? row.issues.find((issue) => issue.level === "repeat")?.text ?? "Строка снята.";

/**
 * Adds the ticked rows as works with the import's mark. The rows left out stay in a new draft
 * with their fixes, so they are not lost (DEC-039); null when everything was added.
 */
export function applyImport(draft: ImportDraft, snapshot: Snapshot, newId: () => string): {
  works: Work[]; outcome: ImportOutcome; rest: ImportDraft | null;
} {
  const preview = previewImport(draft, snapshot);
  if (preview.overLimit) throw new Error("В квартале будет больше работ, чем помещается в одном квартале. Добавьте часть строк.");
  const labels = sourceLabels(snapshot.directions);
  const sourceName = (id: string) => labels.get(id) ?? "";
  const added = preview.checked.map((row) => ({
    row,
    work: {
      id: newId(), name: row.values.name.replace(/\s+/g, " ").trim(), directionId: row.sourceId!,
      estimateHours: row.estimate, mark: draft.mark,
      link: row.values.link.trim() || null, comment: row.values.comment.trim() || null
    } satisfies Work
  }));
  const skipped = preview.rows.filter((row) => !row.checked);
  const outcome: ImportOutcome = {
    mark: draft.mark,
    added: added.map(({ row, work }) => ({ line: row.line, name: work.name, sourceName: sourceName(work.directionId), estimate: work.estimateHours })),
    skipped: skipped.map((row) => ({ line: row.line, name: row.values.name.trim(), reason: firstReason(row) })),
    emptyLines: preview.emptyLines.length
  };
  if (!skipped.length) return { works: added.map(({ work }) => work), outcome, rest: null };

  // The left-out rows keep their lines, fixes, chosen sources and the user's own ticks.
  const keep = [...(draft.hasHeader ? [0] : []), ...skipped.map((row) => row.index)];
  const remap = <T>(record: Readonly<Record<number, T>>) => Object.fromEntries(keep.flatMap((old, next) =>
    record[old] === undefined ? [] : [[next, record[old]]])) as Record<number, T>;
  const rest: ImportDraft = {
    ...draft,
    cells: keep.map((index) => draft.cells[index]),
    lines: keep.map((index) => draft.lines[index] ?? index + 1),
    edits: remap(draft.edits), sources: remap(draft.sources), checked: remap(draft.checked), outcome, cut: false
  };
  return { works: added.map(({ work }) => work), outcome, rest };
}

/**
 * «Скопировать пропущенные»: the rows left after an add (the draft applyImport returns), with
 * the header row (DEC-039) and the reason in the last column, ready to paste into a spreadsheet.
 */
export function skippedTableText(draft: ImportDraft, snapshot: Snapshot): string {
  const preview = previewImport(draft, snapshot);
  const sourceName = (id: string) => snapshot.directions.find((direction) => direction.id === id)?.name ?? "";
  const header0 = preview.header ?? draft.roles.map((role) => role === "skip" ? "" : ROLE_LABELS[role]);
  const reason = (row: PreviewRow) => draft.outcome?.skipped.find((item) => item.line === row.line)?.reason ?? firstReason(row);
  // A field fixed in the preview without a column of its own (the original size after «Добавить
  // без оценки» goes to the comment) gets an extra column, so nothing typed is lost.
  const extra = (["name", "estimate", "link", "comment"] as const).filter((field) => !draft.roles.includes(field)
    && preview.rows.some((row) => draft.edits[row.index]?.[field]?.trim()));
  const extraHeader = extra.map((field) => ROLE_LABELS[field]);
  const rows = preview.rows.map((row) => draft.roles.map((role, column) => {
    if (role === "source") return draft.sources[row.index] !== undefined ? sourceName(draft.sources[row.index]) : cellAt(draft.cells[row.index], column);
    if (role !== "skip" && draft.edits[row.index]?.[role] !== undefined) return draft.edits[row.index][role]!;
    return cellAt(draft.cells[row.index], column);
  }).concat(extra.map((field) => row.values[field]), reason(row)));
  return toTableText([[...header0, ...extraHeader, "Причина пропуска"], ...rows]);
}

/** Rows still waiting in a draft: named when closing the project would lose them. */
export function pendingRowCount(draft: ImportDraft): number {
  return draft.cells.filter((row, index) => !(draft.hasHeader && index === 0) && !isBlankRow(row)).length;
}

// --- Undo of an import -------------------------------------------------------------------------

/** Works of the import that were changed after it, named before «Отменить вставку». */
export function changedSinceImport(batch: ImportBatch, tasks: readonly Work[]): { present: number; changed: string[] } {
  const current = new Map(tasks.map((task) => [task.id, task]));
  let present = 0;
  const changed: string[] = [];
  for (const work of batch.works) {
    const now = current.get(work.id);
    if (!now) continue;
    present += 1;
    if (now.mark !== work.mark) changed.push(`«${now.name}» — ${now.mark === "plan" ? "включена в план квартала" : now.mark === "out" ? "перенесена в «Не в этом квартале»" : "возвращена на рассмотрение"}`);
    else if (now.name !== work.name || now.estimateHours !== work.estimateHours || now.link !== work.link
      || now.comment !== work.comment || now.directionId !== work.directionId) changed.push(`«${now.name}» — изменена`);
  }
  return { present, changed };
}

/** Removes exactly the works of this import; other works and later changes stay. */
export function removeImported(tasks: readonly Work[], batch: ImportBatch): Work[] {
  const ids = new Set(batch.works.map((work) => work.id));
  return tasks.filter((task) => !ids.has(task.id));
}
