/**
 * An RFC 4180 CSV reader, as a generator of rows.
 *
 * A generator, not an array, because SR Legacy's `food_nutrient.csv` is 36 MB
 * and 644,000 rows, and the build only keeps a fraction of them. Quoted fields
 * may hold commas, doubled quotes and newlines (one USDA Foundation
 * description ends in a newline), so a line-based split is not enough.
 */
export function* csvRows(text: string): Generator<string[]> {
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  const n = text.length;
  // A UTF-8 byte-order mark is not part of the first header.
  if (text.charCodeAt(0) === 0xfeff) i = 1;
  while (i < n) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      i += 1;
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      row.push(field);
      field = "";
      yield row;
      row = [];
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    yield row;
  }
}

/** Rows as objects keyed by the header row. */
export function* csvRecords(text: string): Generator<Record<string, string>> {
  let header: string[] | null = null;
  for (const row of csvRows(text)) {
    if (header === null) {
      header = row.map((h) => h.trim());
      continue;
    }
    if (row.length === 1 && row[0] === "") continue;
    const rec: Record<string, string> = {};
    header.forEach((h, idx) => {
      rec[h] = row[idx] ?? "";
    });
    yield rec;
  }
}
