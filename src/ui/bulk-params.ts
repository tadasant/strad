/**
 * Bulk add on the parameters page: the CSV format, and the one parser for it.
 *
 * One record per line, in this column order:
 *
 *     prefix,VARIABLE,kind,value,note
 *
 *   - `prefix`   the path prefix, as on the single form (`telegram-rw/static/`).
 *                May be empty.
 *   - `VARIABLE` the variable name. Required.
 *   - `kind`     `secret` or `plain`. EMPTY MEANS SECRET: a value nobody marked
 *                is treated as the credential it probably is, because a
 *                non-secret value is one agents can read.
 *   - `value`    required.
 *   - `note`     optional; the column may be left off entirely.
 *
 * Quoting is RFC 4180: a field wrapped in `"` may hold commas and newlines, and
 * `""` inside it is one `"`. An unquoted field is trimmed; a quoted VALUE is kept
 * byte for byte, so quoting is how a value keeps leading or trailing spaces.
 * Blank lines and lines starting with `#` are skipped, and so is a first line
 * that reads `prefix,variable,…` — a header pasted from a spreadsheet.
 *
 * ONE PARSER, TWO PLACES. The page previews a paste in the browser, before
 * anything is sent, and the server parses the same text again before it writes.
 * Two hand-written parsers would disagree on exactly the inputs that matter — a
 * quoted comma, a stray quote — and the preview would promise a batch the server
 * then refuses. So the browser runs THESE functions: `bulkClientScript()` inlines
 * them with `Function.prototype.toString()`, which is why each is
 * self-contained, referring to nothing outside its own body. Production runs
 * `tsc` output and tests run esbuild's, both plain JS;
 * `test/ui.secrets.bulk.test.ts` evaluates the inlined copy to keep that true.
 *
 * NO VALUE IN ANY MESSAGE. An error names a line and a column, never the text
 * found there: the text of a bad line is very often the credential itself.
 */

/** One parsed record. `line` is the 1-based line the record STARTS on. */
export interface BulkRecord {
  line: number;
  prefix: string;
  variable: string;
  kind: string;
  value: string;
  note: string;
}

export interface BulkParseError {
  line: number;
  message: string;
}

export interface BulkParse {
  records: BulkRecord[];
  errors: BulkParseError[];
}

/** The most records one submission may carry. The form body is capped at 64kb anyway. */
export const MAX_BULK_RECORDS = 100;

export function parseBulkCsv(text: string): BulkParse {
  const records: BulkRecord[] = [];
  const errors: BulkParseError[] = [];
  const src = String(text);
  let i = 0;
  let line = 1;
  let sawRecord = false;

  while (i < src.length) {
    const start = line;
    const fields: { text: string; quoted: boolean }[] = [];
    let buf = "";
    let quoted = false;
    let error = "";
    let ended = false;

    while (i < src.length && !ended) {
      const ch = src[i];
      if (ch === '"' && !quoted && buf.trim() === "") {
        // An opening quote, possibly after spaces (`a, "b,c"`).
        quoted = true;
        buf = "";
        i += 1;
        let closed = false;
        while (i < src.length) {
          const c = src[i];
          if (c === '"') {
            if (src[i + 1] === '"') {
              buf += '"';
              i += 2;
              continue;
            }
            i += 1;
            closed = true;
            break;
          }
          if (c === "\n") line += 1;
          buf += c;
          i += 1;
        }
        if (!closed) {
          error = `a quoted field opened on line ${start} is never closed.`;
          i = src.length;
          break;
        }
        // Only spaces may sit between a closing quote and the next comma.
        while (i < src.length && (src[i] === " " || src[i] === "\t")) i += 1;
        const next = src[i];
        if (i < src.length && next !== "," && next !== "\n" && next !== "\r") {
          error = `field ${fields.length + 1} has text after its closing quote. Inside a quoted field, write a quote as "".`;
        }
        continue;
      }
      if (ch === '"' && !quoted) {
        error = `field ${fields.length + 1} has a quote in the middle of it. Quote the whole field, and write the quote as "".`;
      }
      if (ch === ",") {
        fields.push({ text: buf, quoted });
        buf = "";
        quoted = false;
        i += 1;
        continue;
      }
      if (ch === "\r" || ch === "\n") {
        i += ch === "\r" && src[i + 1] === "\n" ? 2 : 1;
        line += 1;
        ended = true;
        continue;
      }
      if (quoted) {
        // Text after a closing quote was reported above; skip it.
        i += 1;
        continue;
      }
      buf += ch;
      i += 1;
    }
    fields.push({ text: buf, quoted });

    const first = fields[0] as { text: string; quoted: boolean };
    const blank =
      fields.length === 1 && !first.quoted && first.text.trim() === "";
    if (!error && blank) continue;
    if (!error && !first.quoted && first.text.trim().startsWith("#")) continue;
    if (
      !error &&
      !sawRecord &&
      fields.length >= 2 &&
      first.text.trim().toLowerCase() === "prefix" &&
      (fields[1] as { text: string }).text.trim().toLowerCase() === "variable"
    ) {
      sawRecord = true;
      continue;
    }
    sawRecord = true;
    if (error) {
      errors.push({ line: start, message: error });
      continue;
    }
    if (fields.length < 4 || fields.length > 5) {
      errors.push({
        line: start,
        message:
          `expected 4 or 5 fields (prefix,VARIABLE,kind,value,note), found ${fields.length}.` +
          (fields.length > 5
            ? " Quote a value or note that contains a comma."
            : ""),
      });
      continue;
    }
    const trimmed = fields.map(function (f) {
      return f.text.trim();
    });
    const valueField = fields[3] as { text: string; quoted: boolean };
    records.push({
      line: start,
      prefix: trimmed[0] ?? "",
      variable: trimmed[1] ?? "",
      kind: trimmed[2] ?? "",
      value: valueField.quoted ? valueField.text : valueField.text.trim(),
      note: trimmed[4] ?? "",
    });
  }
  return { records, errors };
}

/**
 * The `kind` column: true for secret, false for plain, null for anything else.
 * Empty is secret — see the module header.
 */
export function parseBulkKind(kind: string): boolean | null {
  const k = String(kind).trim().toLowerCase();
  if (k === "" || k === "secret" || k === "s" || k === "true" || k === "yes") {
    return true;
  }
  if (
    k === "plain" ||
    k === "non-secret" ||
    k === "nonsecret" ||
    k === "p" ||
    k === "false" ||
    k === "no"
  ) {
    return false;
  }
  return null;
}

/** One row back into the format `parseBulkCsv` reads. Quotes only what needs it. */
export function formatBulkRow(row: {
  prefix: string;
  variable: string;
  kind: string;
  value: string;
  note: string;
}): string {
  // `keep` marks the VALUE column, whose surrounding spaces are content.
  const raw = [row.prefix, row.variable, row.kind, row.value];
  if (row.note !== "") raw.push(row.note);
  const cells = raw.map(function (v, n) {
    const s = String(v);
    const keep = n === 3;
    // A leading `#` would turn the line into a comment. It is illegal in every
    // column but the value and the note, and the row editor round-trips
    // whatever was typed, so it is quoted rather than allowed to change meaning.
    const needs =
      /[",\r\n]/.test(s) ||
      (keep && s !== s.trim()) ||
      (n === 0 && /^\s*#/.test(s));
    return needs ? '"' + s.replace(/"/g, '""') + '"' : s;
  });
  return cells.join(",");
}

// ---------------------------------------------------------------------------
// The server's half: every line checked before ANY line is written.
// ---------------------------------------------------------------------------

/** One line of a bulk submission, checked. `value` never leaves the server. */
export interface BulkPlanLine {
  line: number;
  /** Normalised, as `normalisePathPrefix` writes it. */
  prefix: string;
  variable: string;
  /** The composed path, or `""` when the line is too broken to compose one. */
  path: string;
  /** A line whose kind did not parse is reported as secret — the strict answer. */
  secret: boolean;
  value: string;
  note: string;
  /** Why this line will not be written. Never quotes the value. */
  error?: string;
}

export interface BulkPlan {
  lines: BulkPlanLine[];
  /** Lines that could not be parsed at all, so have no fields to report. */
  unreadable: BulkParseError[];
  /** A problem with the batch as a whole (empty, too long, bad namespace). */
  batchError?: string;
}

export interface BulkPlanContext {
  namespace: string;
  /** The namespace refusal the single form would give, if any. */
  namespaceError: string | null;
  /** The paths already in the namespace. A create on one would 409. */
  existing: string[];
  /** The per-field gates the single create applies, so the two stay one rule. */
  validateVariable: (variable: string) => string | null;
  validatePrefix: (prefix: string) => string | null;
  normalisePrefix: (prefix: string) => string;
  validateNote: (note: string) => string | null;
  /** The same well-formedness check every action runs, as a sentence or null. */
  checkPath: (path: string) => string | null;
  /** The resource-id fold. Two paths that fold together are one parameter. */
  idOf: (path: string) => string;
}

export function planBulkCreate(text: string, ctx: BulkPlanContext): BulkPlan {
  const parsed = parseBulkCsv(text);
  const lines: BulkPlanLine[] = [];
  const existingIds = new Set(ctx.existing.map(ctx.idOf));
  const seen = new Map<string, number>();

  for (const r of parsed.records) {
    const kind = parseBulkKind(r.kind);
    const prefix = ctx.normalisePrefix(r.prefix);
    const composable =
      !ctx.validateVariable(r.variable) && !ctx.validatePrefix(r.prefix);
    const path = composable ? `${ctx.namespace}${prefix}${r.variable}` : "";
    const error =
      ctx.validatePrefix(r.prefix) ??
      ctx.validateVariable(r.variable) ??
      (kind === null
        ? `The kind column must be "secret" or "plain" (empty means secret).`
        : null) ??
      (r.value === "" ? "A value is required." : null) ??
      ctx.validateNote(r.note) ??
      ctx.checkPath(path) ??
      duplicateOf(path, r.line) ??
      (existingIds.has(ctx.idOf(path))
        ? "A parameter at this path already exists. Rotate it from the table instead."
        : null);
    lines.push({
      line: r.line,
      prefix,
      variable: r.variable,
      path,
      secret: kind ?? true,
      value: r.value,
      note: r.note,
      ...(error ? { error } : {}),
    });
  }

  const count = parsed.records.length + parsed.errors.length;
  const batchError =
    ctx.namespaceError ??
    (count === 0 ? "Nothing to create: no lines were entered." : null) ??
    (count > MAX_BULK_RECORDS
      ? `At most ${MAX_BULK_RECORDS} parameters may be created at once; this has ${count}.`
      : null);

  return {
    lines,
    unreadable: parsed.errors,
    ...(batchError ? { batchError } : {}),
  };

  function duplicateOf(p: string, line: number): string | null {
    const id = ctx.idOf(p);
    const earlier = seen.get(id);
    if (earlier !== undefined) {
      return `Line ${earlier} already creates this path.`;
    }
    seen.set(id, line);
    return null;
  }
}

/** Whether every line of a plan can be written. */
export function planIsWritable(plan: BulkPlan): boolean {
  return (
    !plan.batchError &&
    plan.unreadable.length === 0 &&
    plan.lines.every((l) => !l.error)
  );
}

/**
 * The lines to hand back to the editor after a submission: the ones that were
 * not created, with EVERY VALUE BLANKED.
 *
 * A value is never sent back to the page, secret or not — the response is a
 * page, and a page is cached, screenshotted and left open. The human re-types
 * the value; the prefix, name, kind and note come back so they do not have to
 * re-type those too.
 */
export function refillCsv(lines: BulkPlanLine[]): string {
  return lines
    .map((l) =>
      formatBulkRow({
        prefix: l.prefix,
        variable: l.variable,
        kind: l.secret ? "secret" : "plain",
        value: "",
        note: l.note,
      }),
    )
    .join("\n");
}

/** One line of what a bulk add did, for the page. No value field, by design. */
export interface BulkReportLine {
  line: number;
  /** `""` when the line was too broken to compose one. */
  path: string;
  variable: string;
  secret: boolean;
  /**
   * `created`: written. `failed`: the store refused it. `invalid`: a check refused
   * it, so nothing was written. `skipped`: fine, but not written because
   * another line was invalid.
   */
  status: "created" | "failed" | "invalid" | "skipped";
  message?: string;
  /** Created, but a connector's console-read grant did not take. */
  warn?: boolean;
}

export interface BulkReport {
  lines: BulkReportLine[];
  /** CSV for the editor: the lines not created, values blanked. See refillCsv. */
  refill: string;
}
