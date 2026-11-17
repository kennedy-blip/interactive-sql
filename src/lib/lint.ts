/**
 * A tiny, dependency-free static analyser for SQL.
 *
 * It does not talk to a database: it masks comments and string literals so
 * structural rules stay accurate, then reports the query patterns that most
 * often hurt performance in production.
 */

export type LintSeverity = "critical" | "warning" | "info";

export type LintFinding = {
  rule: string;
  severity: LintSeverity;
  title: string;
  detail: string;
  hint: string;
  line: number;
};

export const SEVERITY_RANK: Record<LintSeverity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

export const SEVERITY_LABEL: Record<LintSeverity, string> = {
  critical: "Critical",
  warning: "Warning",
  info: "Advisory",
};

const SCALAR_FUNCTIONS =
  "(?:lower|upper|date|date_trunc|year|month|day|hour|substr|substring|cast|coalesce|length|trim|ltrim|rtrim|to_char|round|abs)";

/** Replace comments and quoted literals with spaces, keeping offsets intact. */
function maskSql(sql: string): string {
  let out = "";
  let index = 0;

  while (index < sql.length) {
    const char = sql[index];

    if (char === "-" && sql[index + 1] === "-") {
      while (index < sql.length && sql[index] !== "\n") {
        out += " ";
        index += 1;
      }
      continue;
    }

    if (char === "/" && sql[index + 1] === "*") {
      out += "  ";
      index += 2;
      while (
        index < sql.length &&
        !(sql[index] === "*" && sql[index + 1] === "/")
      ) {
        out += sql[index] === "\n" ? "\n" : " ";
        index += 1;
      }
      if (index < sql.length) {
        out += "  ";
        index += 2;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      const quote = char;
      out += " ";
      index += 1;
      while (index < sql.length) {
        if (sql[index] === quote) {
          if (sql[index + 1] === quote) {
            out += "  ";
            index += 2;
            continue;
          }
          out += " ";
          index += 1;
          break;
        }
        out += sql[index] === "\n" ? "\n" : " ";
        index += 1;
      }
      continue;
    }

    out += char;
    index += 1;
  }

  return out;
}

function lineOf(text: string, index: number): number {
  let line = 1;
  const limit = Math.min(Math.max(index, 0), text.length);
  for (let cursor = 0; cursor < limit; cursor += 1) {
    if (text[cursor] === "\n") line += 1;
  }
  return line;
}

function firstIndex(pattern: RegExp, text: string): number | null {
  const match = pattern.exec(text);
  return match ? match.index : null;
}

/** Locate `JOIN` clauses that never declare an ON / USING condition. */
function findsCartesianJoin(masked: string): number | null {
  const joinPattern = /\bJOIN\b/gi;
  let match: RegExpExecArray | null = joinPattern.exec(masked);

  while (match) {
    const start = match.index;
    const isCross = /CROSS\s+$/i.test(masked.slice(Math.max(0, start - 8), start));
    if (!isCross) {
      const rest = masked.slice(start);
      const nextJoinOffset = rest.slice(6).search(/\bJOIN\b/i);
      const window =
        nextJoinOffset === -1 ? rest : rest.slice(0, nextJoinOffset + 6);
      if (!/\b(ON|USING)\b/i.test(window)) return start;
    }
    match = joinPattern.exec(masked);
  }
  return null;
}

export function lintSql(sql: string): LintFinding[] {
  const findings: LintFinding[] = [];
  const masked = maskSql(sql);
  const trimmed = masked.trim();

  if (!trimmed) return findings;

  const add = (
    rule: string,
    severity: LintSeverity,
    title: string,
    detail: string,
    hint: string,
    index: number | null,
  ) => {
    findings.push({
      rule,
      severity,
      title,
      detail,
      hint,
      line: lineOf(masked, index ?? 0),
    });
  };

  const isSelect = /\bSELECT\b/i.test(masked);
  const hasFrom = /\bFROM\b/i.test(masked);
  const hasWhere = /\bWHERE\b/i.test(masked);
  const hasLimit = /\bLIMIT\b/i.test(masked);
  const hasGroupBy = /\bGROUP\s+BY\b/i.test(masked);
  const hasAggregate = /\b(COUNT|SUM|AVG|MIN|MAX)\s*\(/i.test(masked);

  const destructive = /\b(DROP|TRUNCATE|DELETE|UPDATE|ALTER)\b/i.exec(masked);
  if (destructive) {
    const keyword = destructive[1].toUpperCase();
    const needsWhere = /\b(DELETE|UPDATE)\b/i.test(keyword) && !hasWhere;
    add(
      "destructive-statement",
      "critical",
      needsWhere ? `${keyword} without WHERE` : `${keyword} statement`,
      needsWhere
        ? `This ${keyword.toLowerCase()} has no WHERE clause, so it would touch every row in the table.`
        : `This script contains ${keyword}, which changes data or schema instead of reading it.`,
      "Run schema and data changes through review on a copy before applying them.",
      destructive.index,
    );
  }

  const cartesianIndex = findsCartesianJoin(masked);
  if (cartesianIndex !== null) {
    add(
      "cartesian-join",
      "critical",
      "Join without ON condition",
      "A JOIN here has no ON or USING clause, which produces a cartesian product and explodes the row count.",
      "Add an explicit ON clause that links the join keys, or use CROSS JOIN if the product is intended.",
      cartesianIndex,
    );
  }

  const selectStar = firstIndex(
    /\bSELECT\s+(?:DISTINCT\s+)?(?:[a-z_]\w*\.)?\*/i,
    masked,
  );
  if (selectStar !== null) {
    add(
      "select-star",
      "warning",
      "SELECT * returns every column",
      "Reading all columns increases I/O, breaks covering indexes, and ships fields the UI never renders.",
      "List only the columns you actually consume so the planner can use an index-only scan.",
      selectStar,
    );
  }

  if (isSelect && hasFrom && !hasWhere) {
    add(
      "missing-where",
      "warning",
      "No WHERE clause",
      "Without a filter the engine reads the full table, so cost grows with table size instead of result size.",
      "Add a selective predicate on an indexed column to narrow the read before aggregation.",
      0,
    );
  }

  if (isSelect && hasFrom && !hasLimit && !(hasAggregate && !hasGroupBy)) {
    add(
      "unbounded-result",
      "warning",
      "Unbounded result set",
      "There is no LIMIT, so the query can return an unbounded number of rows to the client.",
      "Add a LIMIT while exploring data, and paginate instead of streaming everything at once.",
      null,
    );
  }

  const functionOnColumn = firstIndex(
    new RegExp(
      `\\b(?:WHERE|AND|OR|HAVING)\\s+${SCALAR_FUNCTIONS}\\s*\\(\\s*[a-z_][\\w.]*`,
      "i",
    ),
    masked,
  );
  if (functionOnColumn !== null) {
    add(
      "non-sargable-predicate",
      "warning",
      "Function applied to a filtered column",
      "Wrapping a column in a function inside WHERE makes the predicate non-sargable, so a plain B-Tree index is skipped.",
      "Compare the bare column instead, e.g. created_at >= '2025-01-01' AND created_at < '2025-02-01'.",
      functionOnColumn,
    );
  }

  const leadingWildcard = firstIndex(/\bLIKE\s+'%/i, sql);
  if (leadingWildcard !== null) {
    add(
      "leading-wildcard",
      "warning",
      "Leading wildcard LIKE",
      "A pattern that starts with % cannot use a standard index, so the engine scans and compares every row.",
      "Prefer prefix matches, a trigram / full-text index, or a dedicated search engine.",
      leadingWildcard,
    );
  }

  const quotedNumber = firstIndex(
    /\b[\w.]*(?:id|_id)\s*(?:=|<>|!=|<|>|<=|>=)\s*'[^']*'/i,
    sql,
  );
  if (quotedNumber !== null) {
    add(
      "quoted-numeric",
      "warning",
      "Numeric key compared as text",
      "An id is compared to a quoted string, which can force an implicit cast and prevent index usage.",
      "Pass numeric keys as numbers: WHERE id = 1042",
      quotedNumber,
    );
  }

  const commaJoin = firstIndex(/\bFROM\s+[\w.]+\s+(?:[a-z_]\w*\s+)?,/i, masked);
  if (commaJoin !== null && !/\bJOIN\b/i.test(masked)) {
    add(
      "comma-join",
      "info",
      "Old-style comma join",
      "Tables are joined with a comma in FROM, which hides the join condition inside WHERE.",
      "Rewrite it with an explicit JOIN … ON so the intent and the plan are obvious.",
      commaJoin,
    );
  }

  const distinct = firstIndex(/\bSELECT\s+DISTINCT\b/i, masked);
  if (distinct !== null) {
    add(
      "select-distinct",
      "info",
      "DISTINCT is sorting duplicate rows away",
      "DISTINCT usually means a join fanned the rows out. It costs a sort or hash and hides the real cardinality.",
      "Fix the join grain with a subquery or aggregate instead of applying DISTINCT to the final result.",
      distinct,
    );
  }

  const notIn = firstIndex(/\bNOT\s+IN\s*\(/i, masked);
  if (notIn !== null) {
    add(
      "not-in",
      "info",
      "NOT IN with a subquery",
      "If the subquery yields a NULL, NOT IN returns no rows at all, and the planner cannot use a semi-join.",
      "Use NOT EXISTS (SELECT 1 …) which is null-safe and optimises better.",
      notIn,
    );
  }

  const orPredicate = firstIndex(/\bWHERE\b[^;]*\bOR\b/i, masked);
  if (orPredicate !== null && !/\bIN\s*\(/i.test(masked)) {
    add(
      "or-predicate",
      "info",
      "OR across different columns",
      "OR predicates on separate columns usually stop the planner from using a single index.",
      "Split the query into UNION ALL branches, or merge the conditions into an IN list on one column.",
      orPredicate,
    );
  }

  const body = trimmed.endsWith(";") ? trimmed.slice(0, -1) : trimmed;
  const multipleStatements = firstIndex(/;\s*\S/, body);
  if (multipleStatements !== null) {
    add(
      "multiple-statements",
      "info",
      "Multiple statements in one script",
      "The editor will execute this as a script; each statement is planned separately.",
      "Run one statement at a time when you want to read the execution plan accurately.",
      multipleStatements,
    );
  }

  return findings.sort(
    (left, right) =>
      SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity] ||
      left.line - right.line,
  );
}

export function lintCounts(
  findings: LintFinding[],
): Record<LintSeverity, number> {
  return findings.reduce(
    (counts, finding) => {
      counts[finding.severity] += 1;
      return counts;
    },
    { critical: 0, warning: 0, info: 0 },
  );
}
