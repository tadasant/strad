/**
 * The statement guard: one statement, of a kind that reads, calling nothing
 * whose effect outlives the transaction.
 *
 * THIS IS NOT THE BOUNDARY. It is the first of three layers, and the cheapest
 * to fool. The boundary is the transaction every query runs in (`BEGIN ...
 * READ ONLY`, rolled back, never committed — `query.ts`) and, under that, the
 * role the URI names. What this file is for is the refusal a caller can READ:
 * "multi-statement input is rejected" said before anything reaches the server,
 * instead of a driver error, and the handful of functions a read-only
 * transaction does not stop because their effect is not a write — ending
 * another backend, taking an advisory lock that outlives the call, reaching
 * another database through dblink.
 *
 * It is a TOKENIZER, not a parser. It knows where Postgres's strings, quoted
 * identifiers, dollar quotes and comments begin and end, so a `;` or a function
 * name inside one of them is not mistaken for code — and that is all it knows.
 * The extended query protocol the statement is then sent over is a second
 * single-statement check, made by the server itself: a prepared statement with
 * two commands in it is an error there, whatever this file concluded.
 */

export class SqlRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SqlRejected";
  }
}

/** The first keyword of every statement this server will send. */
export const ALLOWED_LEADING_KEYWORDS = ["SELECT", "WITH", "VALUES", "TABLE", "EXPLAIN", "SHOW"] as const;

/**
 * Functions refused by name, wherever they are called. Each one has an effect a
 * READ ONLY transaction does not prevent, because it is not a write to a table:
 * signalling or ending other sessions, server configuration, locks that live
 * on the session, notifications, large objects, another database by dblink,
 * and the server's own filesystem. Most also need a privilege a read-only role
 * should not hold; this is for the deployment where it does.
 */
const DENIED_FUNCTIONS = new Set([
  "pg_terminate_backend",
  "pg_cancel_backend",
  "pg_reload_conf",
  "pg_rotate_logfile",
  "pg_promote",
  "pg_switch_wal",
  "pg_create_restore_point",
  "pg_log_backend_memory_contexts",
  "pg_notify",
  "set_config",
  "lo_import",
  "lo_export",
  "lo_create",
  "lo_creat",
  "lo_unlink",
  "lo_put",
  "lo_from_bytea",
  // These EXECUTE a query given as a string, which this guard cannot read into.
  "ts_stat",
  "ts_rewrite",
]);

/** And by prefix, for the families. */
const DENIED_PREFIXES = [
  "pg_advisory_",
  "pg_try_advisory_",
  "dblink",
  "pg_read_",
  "pg_ls_",
  "pg_stat_file",
  "pg_file_",
  "pg_logical_",
  "pg_replication_",
  "pg_create_",
  "pg_drop_replication_slot",
  "pg_copy_",
  // query_to_xml, query_to_xmlschema, query_to_xml_and_xmlschema, and the
  // cursor_to_* family: each runs SQL from a string.
  "query_to_xml",
  "cursor_to_xml",
];

function denied(name: string): boolean {
  const n = name.toLowerCase();
  return DENIED_FUNCTIONS.has(n) || DENIED_PREFIXES.some((p) => n.startsWith(p));
}

type Token =
  | { kind: "word"; text: string; quoted: boolean }
  | { kind: "semicolon"; at: number }
  | { kind: "paren" }
  | { kind: "other" };

const WORD_START = /[A-Za-z_\u0080-￿]/;
const WORD_PART = /[A-Za-z0-9_$\u0080-￿]/;

/**
 * Split `sql` into the tokens this guard cares about. Strings, comments and
 * dollar-quoted bodies are consumed whole and produce nothing (a string) or
 * nothing at all (a comment). An unterminated one is a refusal: the server
 * would read the rest of the input as part of it, and so must we.
 */
export function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i]!;
    const next = sql[i + 1];
    if (/\s/.test(c)) {
      i += 1;
    } else if (c === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? n : end + 1;
    } else if (c === "/" && next === "*") {
      // Postgres block comments NEST.
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth += 1;
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth -= 1;
          i += 2;
        } else i += 1;
      }
      if (depth > 0) throw new SqlRejected("The SQL has an unterminated /* comment.");
    } else if (c === "'" || ((c === "E" || c === "e") && next === "'")) {
      // E'...' honours backslash escapes; a plain '...' only doubles quotes
      // (standard_conforming_strings is on in every supported Postgres).
      const escapes = c !== "'";
      i += escapes ? 2 : 1;
      let closed = false;
      while (i < n) {
        const d = sql[i]!;
        if (escapes && d === "\\") {
          i += 2;
        } else if (d === "'") {
          if (sql[i + 1] === "'") i += 2;
          else {
            i += 1;
            closed = true;
            break;
          }
        } else i += 1;
      }
      if (!closed) throw new SqlRejected("The SQL has an unterminated string literal.");
      tokens.push({ kind: "other" });
    } else if (c === '"') {
      let j = i + 1;
      let text = "";
      let closed = false;
      while (j < n) {
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') {
            text += '"';
            j += 2;
          } else {
            j += 1;
            closed = true;
            break;
          }
        } else {
          text += sql[j];
          j += 1;
        }
      }
      if (!closed) throw new SqlRejected("The SQL has an unterminated quoted identifier.");
      tokens.push({ kind: "word", text, quoted: true });
      i = j;
    } else if (c === "$") {
      const tag = /^\$([A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/.exec(sql.slice(i));
      if (tag) {
        const end = sql.indexOf(tag[0], i + tag[0].length);
        if (end === -1) throw new SqlRejected("The SQL has an unterminated dollar-quoted string.");
        i = end + tag[0].length;
        tokens.push({ kind: "other" });
      } else {
        // $1, a positional parameter.
        i += 1;
        while (i < n && /[0-9]/.test(sql[i]!)) i += 1;
        tokens.push({ kind: "other" });
      }
    } else if (WORD_START.test(c)) {
      let j = i + 1;
      while (j < n && WORD_PART.test(sql[j]!)) j += 1;
      // U&"..." and U&'...' spell a name or string with escapes, which would
      // let a refused function name past a guard that reads names literally.
      // A read statement has no need of them.
      if (j === i + 1 && (c === "U" || c === "u") && sql[j] === "&" && (sql[j + 1] === '"' || sql[j + 1] === "'")) {
        throw new SqlRejected("Unicode-escaped names and strings (U&\"...\", U&'...') are not accepted here.");
      }
      tokens.push({ kind: "word", text: sql.slice(i, j), quoted: false });
      i = j;
    } else if (c === ";") {
      tokens.push({ kind: "semicolon", at: i });
      i += 1;
    } else if (c === "(") {
      tokens.push({ kind: "paren" });
      i += 1;
    } else {
      tokens.push({ kind: "other" });
      i += 1;
    }
  }
  return tokens;
}

/**
 * Accept `sql` or say why not. Returns the statement with any trailing `;`
 * removed, since the extended protocol takes exactly one statement and a
 * trailing semicolon is the one harmless form of "more than one".
 */
export function checkReadOnlySql(sql: string): string {
  if (typeof sql !== "string" || sql.trim() === "") {
    throw new SqlRejected("`sql` must be a non-empty SQL statement.");
  }
  const tokens = tokenize(sql);
  const semis = tokens.flatMap((t, idx) => (t.kind === "semicolon" ? [idx] : []));
  const firstSemi = semis[0];
  if (firstSemi !== undefined && tokens.slice(firstSemi + 1).some((t) => t.kind !== "semicolon")) {
    throw new SqlRejected(
      "Only one SQL statement may be run per call; this input has more than one " +
        "(a `;` followed by more SQL). Send each statement as its own call.",
    );
  }
  const body = firstSemi === undefined ? tokens : tokens.slice(0, firstSemi);
  if (body.length === 0) {
    throw new SqlRejected("`sql` must be a non-empty SQL statement.");
  }
  // `(SELECT ...) UNION (SELECT ...)` is a read; the keyword is after the parens.
  const lead = body.find((t) => t.kind !== "paren")!;
  const keyword = lead.kind === "word" && !lead.quoted ? lead.text.toUpperCase() : "";
  if (!(ALLOWED_LEADING_KEYWORDS as readonly string[]).includes(keyword)) {
    throw new SqlRejected(
      `Only read statements are run here: the statement must begin with one of ` +
        `${ALLOWED_LEADING_KEYWORDS.join(", ")}. ` +
        (keyword ? `This one begins with ${keyword}.` : `This one begins with something else.`),
    );
  }
  for (let k = 0; k < body.length; k += 1) {
    const t = body[k]!;
    if (t.kind === "word" && body[k + 1]?.kind === "paren" && denied(t.text)) {
      throw new SqlRejected(
        `The function ${t.text.toLowerCase()}() is refused here: its effect is not ` +
          `a write, so a read-only transaction would not stop it.`,
      );
    }
  }
  if (firstSemi === undefined) return sql.trim();
  const at = (tokens[firstSemi] as { at: number }).at;
  return sql.slice(0, at).trim();
}
