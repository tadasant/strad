/**
 * Which numbers in an .xlsx are dates, and what to call them.
 *
 * SpreadsheetML has no date type: 2026-09-20 is the number 46285 with a style
 * whose number format happens to render it as a date. A reader that ignores
 * styles reports a financial tracker's date column as five-digit integers, which
 * is not wrong so much as unusable.
 *
 * THIS IS NOT A NUMBER FORMATTER. `$1,234.00` comes back as `1234`, and
 * deliberately: reimplementing Excel's format language to render currency the
 * way the Sheets API's FORMATTED_VALUE would is a large amount of code to make a
 * number less useful. Dates are the one case where the raw value carries no
 * recoverable meaning, so dates are the one case handled.
 */

/**
 * The built-in numFmtIds ECMA-376 assigns date and time semantics.
 *
 * 14-22 are the date and time formats; 45-47 are the elapsed-time ones. Every
 * other built-in is a number, a fraction, a percentage or text.
 */
const BUILTIN_DATE_FORMAT_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

/** The first id a workbook may define for itself; below this they are built in. */
const FIRST_CUSTOM_FORMAT_ID = 164;

export interface NumberFormats {
  /** numFmtId per style index, as `<cellXfs>` orders them. */
  styleFormatIds: number[];
  /** formatCode per custom numFmtId. */
  customFormats: Map<number, string>;
}

/**
 * Strip everything in a format code that is a literal rather than a token.
 *
 * `"$"#,##0.00` and `[Red]0.0;[Blue]-0.0` both contain letters that are not date
 * tokens, and a naive `/[dmy]/` test on the raw code calls both of them dates.
 */
function formatTokens(formatCode: string): string {
  return formatCode
    // Quoted literals: "USD", "m" in `0.0"m"`.
    .replace(/"[^"]*"/g, '')
    // Bracketed sections: colours, conditions, locale ids — except the elapsed
    // forms [h], [m], [s], which ARE time tokens.
    .replace(/\[(?![hms]+\])[^\]]*\]/gi, '')
    // Backslash-escaped single characters: \d, \y.
    .replace(/\\./g, '')
    // The currency/locale prefix `$-409` inside what is left.
    .replace(/\$-?[0-9A-Fa-f]+/g, '');
}

/** True if this format code renders its number as a date or a time. */
export function isDateFormatCode(formatCode: string): boolean {
  const tokens = formatTokens(formatCode);
  // A date format carries a `y` or a `d`; a time format carries an `h` or an
  // `s`. `m` alone is ambiguous — months or minutes — but it never appears
  // without one of the other four, so it never has to decide anything.
  return /[ydhs]/i.test(tokens);
}

/** True if the cell at this style index renders as a date or a time. */
export function isDateStyle(formats: NumberFormats, styleIndex: number | undefined): boolean {
  if (styleIndex === undefined) return false;
  const formatId = formats.styleFormatIds[styleIndex];
  if (formatId === undefined) return false;
  if (formatId < FIRST_CUSTOM_FORMAT_ID) return BUILTIN_DATE_FORMAT_IDS.has(formatId);
  const code = formats.customFormats.get(formatId);
  return code === undefined ? false : isDateFormatCode(code);
}

/** True if the format shows a time of day and not a date. */
function isTimeOnly(formats: NumberFormats, styleIndex: number | undefined): boolean {
  if (styleIndex === undefined) return false;
  const formatId = formats.styleFormatIds[styleIndex];
  if (formatId === undefined) return false;
  const code =
    formatId < FIRST_CUSTOM_FORMAT_ID
      ? BUILTIN_TIME_ONLY_IDS.has(formatId)
        ? 'h:mm'
        : undefined
      : formats.customFormats.get(formatId);
  if (code === undefined) return false;
  return !/[yd]/i.test(formatTokens(code));
}

const BUILTIN_TIME_ONLY_IDS = new Set([18, 19, 20, 21, 45, 46, 47]);

/**
 * An Excel date serial as an ISO-ish string.
 *
 * Serial 0 is 1899-12-30 in the default 1900 system, not 1900-01-01: Excel
 * carries a deliberate bug in which 1900 is a leap year, and dating from
 * 1899-12-30 cancels it for every date from 1900-03-01 onward — which is every
 * date anyone has in a spreadsheet. A workbook with `date1904="1"` (the old Mac
 * default) counts from 1904-01-01 instead and has no such bug.
 */
export function serialToDateString(
  serial: number,
  options: { date1904: boolean; timeOnly: boolean }
): string {
  const epoch = options.date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const ms = Math.round(epoch + serial * 86_400_000);
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return String(serial);

  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  const time =
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
  if (options.timeOnly) return time;

  const day = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  // A whole-day serial is a date; anything with a fraction carries a time worth
  // keeping, and dropping it would turn a timestamped ledger row into a date.
  return Number.isInteger(serial) ? day : `${day} ${time}`;
}

/** Render a numeric cell the way this server renders it: dates as dates. */
export function renderNumber(
  value: number,
  formats: NumberFormats,
  styleIndex: number | undefined,
  date1904: boolean
): string | number {
  if (!isDateStyle(formats, styleIndex)) return value;
  return serialToDateString(value, {
    date1904,
    timeOnly: isTimeOnly(formats, styleIndex),
  });
}
