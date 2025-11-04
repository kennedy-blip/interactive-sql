import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  Activity,
  ArrowDownUp,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Clock3,
  Code2,
  Copy,
  Database,
  Download,
  FileCode2,
  FileJson2,
  Filter,
  GitMerge,
  Info,
  Layers3,
  LoaderCircle,
  Play,
  Plus,
  RotateCcw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Table2,
  Terminal,
  Trash2,
  WandSparkles,
  X,
  Zap,
} from "lucide-react";
import { format } from "sql-formatter";

const DIALECTS = ["PostgreSQL", "MySQL", "SQLite", "Snowflake"] as const;
type Dialect = (typeof DIALECTS)[number];

const TABLES = {
  users: {
    alias: "u",
    columns: ["id", "email", "name", "status", "created_at"],
  },
  orders: {
    alias: "o",
    columns: ["id", "user_id", "product_id", "total", "status", "created_at"],
  },
  products: {
    alias: "p",
    columns: ["id", "name", "category", "price", "stock"],
  },
  analytics: {
    alias: "a",
    columns: ["id", "user_id", "event_type", "source", "created_at"],
  },
} as const;
type TableName = keyof typeof TABLES;
const TABLE_NAMES = Object.keys(TABLES) as TableName[];

const RELATIONS: Record<
  TableName,
  Partial<Record<TableName, [string, string]>>
> = {
  users: { orders: ["u.id", "o.user_id"], analytics: ["u.id", "a.user_id"] },
  orders: { users: ["o.user_id", "u.id"], products: ["o.product_id", "p.id"] },
  products: { orders: ["p.id", "o.product_id"] },
  analytics: { users: ["a.user_id", "u.id"] },
};

type FilterRule = {
  id: number;
  column: string;
  operator: string;
  value: string;
};
type BuilderState = {
  baseTable: TableName;
  selectedColumns: string[];
  joinEnabled: boolean;
  joinTable: TableName;
  joinType: string;
  joinLeft: string;
  joinRight: string;
  filters: FilterRule[];
  orderBy: string;
  orderDirection: "ASC" | "DESC";
  limit: number;
};

const INITIAL_BUILDER: BuilderState = {
  baseTable: "users",
  selectedColumns: ["u.id", "u.email", "order_count", "total_spent"],
  joinEnabled: true,
  joinTable: "orders",
  joinType: "LEFT JOIN",
  joinLeft: "u.id",
  joinRight: "o.user_id",
  filters: [{ id: 1, column: "u.status", operator: "=", value: "active" }],
  orderBy: "total_spent",
  orderDirection: "DESC",
  limit: 100,
};

type PlanNode = {
  name: string;
  detail: string;
  cost: number;
  rows: number;
  kind: "sort" | "aggregate" | "join" | "index" | "scan";
  children?: PlanNode[];
};

type Recommendation = {
  title: string;
  description: string;
  status: "opportunity" | "passed";
  impact?: string;
  script?: string;
  target?: string;
};

type Execution = {
  sql: string;
  dialect: Dialect;
  builder: BuilderState;
  latency: number;
  rows: number;
  score: number;
  plan: PlanNode;
  columns: string[];
  ranAt: number;
};

type SelectOption = { value: string; label: string };

function relationFor(base: TableName, target: TableName): [string, string] {
  return (
    RELATIONS[base][target] ?? [
      `${TABLES[base].alias}.id`,
      `${TABLES[target].alias}.id`,
    ]
  );
}

function newBuilderFor(table: TableName): BuilderState {
  if (table === "users")
    return {
      ...INITIAL_BUILDER,
      selectedColumns: [...INITIAL_BUILDER.selectedColumns],
      filters: [...INITIAL_BUILDER.filters],
    };

  const joinTable = Object.keys(RELATIONS[table])[0] as TableName;
  const [joinLeft, joinRight] = relationFor(table, joinTable);
  const alias = TABLES[table].alias;
  const secondColumn =
    table === "orders" ? "total" : table === "products" ? "name" : "event_type";
  const filterColumn =
    table === "orders"
      ? "status"
      : table === "products"
        ? "stock"
        : "event_type";

  return {
    baseTable: table,
    selectedColumns: [`${alias}.id`, `${alias}.${secondColumn}`],
    joinEnabled: true,
    joinTable,
    joinType: "LEFT JOIN",
    joinLeft,
    joinRight,
    filters: [
      {
        id: 1,
        column: `${alias}.${filterColumn}`,
        operator: table === "products" ? ">" : "=",
        value:
          table === "products"
            ? "0"
            : table === "orders"
              ? "completed"
              : "purchase",
      },
    ],
    orderBy: TABLES[table].columns.some((column) => column === "created_at")
      ? `${alias}.created_at`
      : `${alias}.id`,
    orderDirection: "DESC",
    limit: 100,
  };
}

function quoteValue(value: string, operator: string): string {
  const trimmed = value.trim();
  if (/^-?\d+(\.\d+)?$/.test(trimmed) || /^(true|false|null)$/i.test(trimmed))
    return trimmed;
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed;
  const text =
    operator === "LIKE" && !trimmed.includes("%") ? `%${trimmed}%` : trimmed;
  return `'${text.replace(/'/g, "''")}'`;
}

function buildSql(builder: BuilderState): string {
  const baseAlias = TABLES[builder.baseTable].alias;
  const joinAlias = TABLES[builder.joinTable].alias;
  const columns = builder.selectedColumns.length
    ? builder.selectedColumns
    : [`${baseAlias}.*`];
  const hasAggregate = columns.some(
    (column) => column === "order_count" || column === "total_spent",
  );
  const selectLines = columns.map((column) => {
    if (column === "order_count")
      return `COUNT(${joinAlias}.id) AS order_count`;
    if (column === "total_spent")
      return `SUM(${joinAlias}.total) AS total_spent`;
    return column;
  });

  let query = `SELECT\n  ${selectLines.join(",\n  ")}\nFROM ${builder.baseTable} ${baseAlias}`;
  if (builder.joinEnabled)
    query += `\n${builder.joinType} ${builder.joinTable} ${joinAlias} ON ${builder.joinLeft} = ${builder.joinRight}`;

  const activeFilters = builder.filters.filter((filter) => filter.value.trim());
  if (activeFilters.length)
    query += `\nWHERE ${activeFilters.map((filter) => `${filter.column} ${filter.operator} ${quoteValue(filter.value, filter.operator)}`).join("\n  AND ")}`;

  if (hasAggregate) {
    const groupedColumns = columns.filter(
      (column) =>
        column !== "order_count" &&
        column !== "total_spent" &&
        !column.endsWith(".*"),
    );
    if (groupedColumns.length)
      query += `\nGROUP BY ${groupedColumns.join(", ")}`;
  }
  if (builder.orderBy)
    query += `\nORDER BY ${builder.orderBy} ${builder.orderDirection}`;
  if (builder.limit > 0) query += `\nLIMIT ${builder.limit}`;
  return `${query};`;
}

function makePlan(sql: string, builder: BuilderState): PlanNode {
  const base = sql.match(/\bFROM\s+([a-z_]\w*)/i)?.[1] ?? builder.baseTable;
  const joined = sql.match(/\bJOIN\s+([a-z_]\w*)/i)?.[1];
  const filterColumn = sql.match(/\bWHERE\s+(?:\w+\.)?([a-z_]\w*)/i)?.[1];
  const hasGroup = /\bGROUP\s+BY\b/i.test(sql);
  const hasSort = /\bORDER\s+BY\b/i.test(sql);
  const limit = Number(sql.match(/\bLIMIT\s+(\d+)/i)?.[1] ?? 0);

  const baseScan: PlanNode = filterColumn
    ? {
        name: `Index Scan using idx_${base}_${filterColumn}`,
        detail: `Filter rows in ${base}`,
        cost: 34.2,
        rows: 1200,
        kind: "index",
      }
    : {
        name: `Seq Scan on ${base}`,
        detail: `Read rows from ${base}`,
        cost: 58.4,
        rows: 4200,
        kind: "scan",
      };

  let root: PlanNode = baseScan;
  if (joined) {
    root = {
      name: /\bLEFT\s+JOIN\b/i.test(sql) ? "Hash Left Join" : "Hash Join",
      detail: `Match ${base} with ${joined}`,
      cost: 96.4,
      rows: 4280,
      kind: "join",
      children: [
        baseScan,
        {
          name: `Seq Scan on ${joined}`,
          detail: `Read rows from ${joined}`,
          cost: 62.3,
          rows: 8200,
          kind: "scan",
        },
      ],
    };
  }
  if (hasGroup)
    root = {
      name: "HashAggregate",
      detail: "Group and calculate selected metrics",
      cost: root.cost + 19.8,
      rows: 1200,
      kind: "aggregate",
      children: [root],
    };
  if (hasSort) {
    const sortField =
      sql.match(/\bORDER\s+BY\s+([\w.]+)/i)?.[1] ?? "selected field";
    root = {
      name: "Sort",
      detail: `Order by ${sortField}${limit ? `, top ${limit}` : ""}`,
      cost: root.cost + 13.3,
      rows: limit ? Math.min(limit, 1200) : 1200,
      kind: "sort",
      children: [root],
    };
  }
  return root;
}

function extractManualColumns(sql: string, builder: BuilderState): string[] {
  const selectPart = sql.match(/\bSELECT\b([\s\S]*?)\bFROM\b/i)?.[1];
  if (!selectPart)
    return builder.selectedColumns.map(
      (column) => column.split(".").pop() ?? column,
    );
  if (selectPart.trim() === "*" || /^\w+\.\*$/.test(selectPart.trim()))
    return [...TABLES[builder.baseTable].columns].slice(0, 4);

  const parts: string[] = [];
  let current = "";
  let depth = 0;
  for (const char of selectPart) {
    if (char === "(") depth++;
    if (char === ")") depth--;
    if (char === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else current += char;
  }
  if (current.trim()) parts.push(current.trim());

  const columns = parts.map(
    (part, index) =>
      part.match(/\bAS\s+([a-z_]\w*)\s*$/i)?.[1] ??
      part.match(/(?:\w+\.)?([a-z_]\w*)\s*$/i)?.[1] ??
      `column_${index + 1}`,
  );
  return columns.length ? [...new Set(columns)] : ["id", "email"];
}

function makeExecution(
  sql: string,
  dialect: Dialect,
  builder: BuilderState,
  latency: number,
  manual: boolean,
): Execution {
  const hasJoin = /\bJOIN\b/i.test(sql);
  const hasWhere = /\bWHERE\b/i.test(sql);
  const hasGroup = /\bGROUP\s+BY\b/i.test(sql);
  const hasLimit = /\bLIMIT\b/i.test(sql);
  const selectsAll = /\bSELECT\s+(?:\w+\.)?\*/i.test(sql);
  const score = Math.max(
    38,
    Math.min(
      99,
      94 -
        (hasJoin ? 6 : 0) -
        (hasGroup ? 4 : 0) -
        (selectsAll ? 12 : 0) -
        (!hasWhere ? 8 : 0) -
        (!hasLimit ? 5 : 0) +
        (hasWhere ? 4 : 0),
    ),
  );
  const limit = Number(sql.match(/\bLIMIT\s+(\d+)/i)?.[1] ?? 1248);

  return {
    sql,
    dialect,
    builder: {
      ...builder,
      selectedColumns: [...builder.selectedColumns],
      filters: builder.filters.map((filter) => ({ ...filter })),
    },
    latency,
    rows: Math.min(Math.max(limit, 0), hasWhere ? 1248 : 4200),
    score,
    plan: makePlan(sql, builder),
    columns: manual
      ? extractManualColumns(sql, builder)
      : builder.selectedColumns.map(
          (column) => column.split(".").pop() ?? column,
        ),
    ranAt: Date.now(),
  };
}

function getRecommendations(execution: Execution): Recommendation[] {
  const { sql, dialect, builder } = execution;
  const items: Recommendation[] = [];
  const joined = sql.match(/\bJOIN\s+([a-z_]\w*)/i)?.[1];
  const base = sql.match(/\bFROM\s+([a-z_]\w*)/i)?.[1] ?? builder.baseTable;
  const filterColumn = sql.match(/\bWHERE\s+(?:\w+\.)?([a-z_]\w*)/i)?.[1];

  let indexTable = "";
  let indexColumn = "";
  if (joined === "orders" && base === "users") {
    indexTable = "orders";
    indexColumn = "user_id";
  } else if (joined === "analytics") {
    indexTable = "analytics";
    indexColumn = "user_id";
  } else if (filterColumn && filterColumn !== "id") {
    indexTable = base;
    indexColumn = filterColumn;
  }

  if (indexTable) {
    const snowflake = dialect === "Snowflake";
    const target = `${indexTable}(${indexColumn})`;
    const script = snowflake
      ? `ALTER TABLE ${indexTable}\nCLUSTER BY (${indexColumn});`
      : dialect === "PostgreSQL"
        ? `CREATE INDEX CONCURRENTLY idx_${indexTable}_${indexColumn}\nON ${indexTable} (${indexColumn});`
        : `CREATE INDEX idx_${indexTable}_${indexColumn}\nON ${indexTable} (${indexColumn});`;
    items.push({
      title: snowflake ? "Clustering opportunity" : "Missing index detected",
      description: snowflake
        ? `Cluster ${target} to reduce the amount of data scanned for this query pattern.`
        : `Add a B-Tree index on ${target} to speed up ${joined ? "joins" : "filtering"} by an estimated ${joined ? "45" : "30"}%.`,
      status: "opportunity",
      impact: "High impact",
      target,
      script,
    });
  }

  if (/\bGROUP\s+BY\b/i.test(sql) && /\bORDER\s+BY\b/i.test(sql))
    items.push({
      title: "Watch aggregate sort cost",
      description:
        "For larger datasets, monitor sort memory after aggregation and keep the result limit selective.",
      status: "opportunity",
      impact: "Worth checking",
    });
  if (/\bSELECT\s+(?:\w+\.)?\*/i.test(sql))
    items.push({
      title: "Select only needed columns",
      description:
        "Replace SELECT * with the fields you use to reduce data transfer and scan work.",
      status: "opportunity",
      impact: "Medium impact",
    });
  else
    items.push({
      title: "Focused column selection",
      description:
        "You are selecting specific fields instead of fetching every column.",
      status: "passed",
    });
  if (/\bWHERE\b/i.test(sql))
    items.push({
      title: "Filter is in place",
      description:
        "A WHERE clause narrows the data before the final result is returned.",
      status: "passed",
    });
  else
    items.push({
      title: "Add a selective filter",
      description:
        "A WHERE clause can avoid reading and returning unnecessary rows.",
      status: "opportunity",
      impact: "Medium impact",
    });
  if (/\bLIMIT\b/i.test(sql))
    items.push({
      title: "Result set is bounded",
      description:
        "A LIMIT keeps the returned dataset manageable while iterating.",
      status: "passed",
    });
  else
    items.push({
      title: "Bound the result set",
      description:
        "Add a LIMIT while exploring data to keep response sizes predictable.",
      status: "opportunity",
      impact: "Quick win",
    });
  return items;
}

const PREVIEW_DATA: Record<
  TableName,
  Array<Record<string, string | number>>
> = {
  users: [
    {
      id: 1042,
      email: "olivia.chen@northstar.io",
      name: "Olivia Chen",
      status: "active",
      order_count: 28,
      total_spent: 4892.5,
      created_at: "2025-04-21",
    },
    {
      id: 1087,
      email: "marcus.lee@studio.dev",
      name: "Marcus Lee",
      status: "active",
      order_count: 22,
      total_spent: 3740.2,
      created_at: "2025-04-18",
    },
    {
      id: 1103,
      email: "ava.patel@acme.co",
      name: "Ava Patel",
      status: "active",
      order_count: 19,
      total_spent: 3128.75,
      created_at: "2025-04-15",
    },
    {
      id: 1148,
      email: "noah.williams@hey.com",
      name: "Noah Williams",
      status: "active",
      order_count: 16,
      total_spent: 2654.0,
      created_at: "2025-04-11",
    },
    {
      id: 1192,
      email: "sophia.kim@linear.app",
      name: "Sophia Kim",
      status: "active",
      order_count: 14,
      total_spent: 2210.4,
      created_at: "2025-04-08",
    },
  ],
  orders: [
    {
      id: 8021,
      user_id: 1042,
      product_id: 501,
      total: 398.5,
      status: "completed",
      created_at: "2025-04-21",
    },
    {
      id: 7988,
      user_id: 1087,
      product_id: 502,
      total: 274.0,
      status: "completed",
      created_at: "2025-04-18",
    },
    {
      id: 7924,
      user_id: 1103,
      product_id: 503,
      total: 185.75,
      status: "completed",
      created_at: "2025-04-15",
    },
    {
      id: 7890,
      user_id: 1148,
      product_id: 504,
      total: 159.0,
      status: "completed",
      created_at: "2025-04-11",
    },
    {
      id: 7815,
      user_id: 1192,
      product_id: 505,
      total: 122.4,
      status: "completed",
      created_at: "2025-04-08",
    },
  ],
  products: [
    {
      id: 501,
      name: "Studio Headphones",
      category: "Electronics",
      price: 149.0,
      stock: 42,
      order_count: 28,
      total_spent: 4892.5,
    },
    {
      id: 502,
      name: "Ceramic Desk Lamp",
      category: "Home",
      price: 89.0,
      stock: 18,
      order_count: 22,
      total_spent: 3740.2,
    },
    {
      id: 503,
      name: "Notebook Set",
      category: "Office",
      price: 45.5,
      stock: 67,
      order_count: 19,
      total_spent: 3128.75,
    },
    {
      id: 504,
      name: "Mechanical Keyboard",
      category: "Electronics",
      price: 129.0,
      stock: 24,
      order_count: 16,
      total_spent: 2654.0,
    },
    {
      id: 505,
      name: "Canvas Organizer",
      category: "Home",
      price: 79.0,
      stock: 36,
      order_count: 14,
      total_spent: 2210.4,
    },
  ],
  analytics: [
    {
      id: 19021,
      user_id: 1042,
      event_type: "purchase",
      source: "organic",
      created_at: "2025-04-21",
    },
    {
      id: 19018,
      user_id: 1087,
      event_type: "purchase",
      source: "referral",
      created_at: "2025-04-18",
    },
    {
      id: 19015,
      user_id: 1103,
      event_type: "purchase",
      source: "paid",
      created_at: "2025-04-15",
    },
    {
      id: 19011,
      user_id: 1148,
      event_type: "purchase",
      source: "organic",
      created_at: "2025-04-11",
    },
    {
      id: 19008,
      user_id: 1192,
      event_type: "purchase",
      source: "social",
      created_at: "2025-04-08",
    },
  ],
};

function resultValue(
  column: string,
  index: number,
  table: TableName,
): string | number {
  const key = column.toLowerCase();
  const row = PREVIEW_DATA[table][index];
  if (key in row) return row[key];
  if (key in PREVIEW_DATA.users[index]) return PREVIEW_DATA.users[index][key];
  if (key in PREVIEW_DATA.orders[index]) return PREVIEW_DATA.orders[index][key];
  if (key.includes("count")) return [28, 22, 19, 16, 14][index];
  if (
    key.includes("amount") ||
    key.includes("revenue") ||
    key.includes("spent")
  )
    return [4892.5, 3740.2, 3128.75, 2654, 2210.4][index];
  if (key.includes("id")) return row.id;
  if (key.includes("date") || key.includes("time"))
    return row.created_at ?? "2025-04-21";
  return ["value_01", "value_02", "value_03", "value_04", "value_05"][index];
}

function planLines(node: PlanNode, depth = 0): string[] {
  return [
    `${"  ".repeat(depth)}- ${node.name} (cost ${node.cost.toFixed(2)}, rows ${node.rows.toLocaleString()})`,
    ...(node.children ?? []).flatMap((child) => planLines(child, depth + 1)),
  ];
}

function highlightSql(sql: string) {
  const tokenPattern =
    /(--[^\n]*|'(?:''|[^'])*'|\b(?:GROUP BY|ORDER BY|LEFT JOIN|RIGHT JOIN|INNER JOIN|CREATE INDEX|SELECT|FROM|WHERE|JOIN|ON|AS|COUNT|SUM|AVG|MIN|MAX|LIMIT|DESC|ASC|AND|OR|IN|LIKE|DISTINCT|HAVING|INSERT|UPDATE|DELETE|CREATE|INDEX|CONCURRENTLY|CLUSTER BY)\b|\b\d+(?:\.\d+)?\b)/gi;
  return sql.split(tokenPattern).map((part, index) => {
    if (!part) return null;
    let className = "";
    if (part.startsWith("--")) className = "syntax-comment";
    else if (part.startsWith("'")) className = "syntax-string";
    else if (/^\d/.test(part)) className = "syntax-number";
    else if (/^(COUNT|SUM|AVG|MIN|MAX)$/i.test(part))
      className = "syntax-function";
    else if (
      /^(SELECT|FROM|WHERE|JOIN|LEFT JOIN|RIGHT JOIN|INNER JOIN|ON|AS|GROUP BY|ORDER BY|LIMIT|DESC|ASC|AND|OR|IN|LIKE|DISTINCT|HAVING|INSERT|UPDATE|DELETE|CREATE|CREATE INDEX|INDEX|CONCURRENTLY|CLUSTER BY)$/i.test(
        part,
      )
    )
      className = "syntax-keyword";
    return className ? (
      <span className={className} key={index}>
        {part}
      </span>
    ) : (
      part
    );
  });
}

function SelectField({
  value,
  options,
  onChange,
  ariaLabel,
  disabled = false,
}: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  ariaLabel: string;
  disabled?: boolean;
}) {
  return (
    <div className={`select-wrap ${disabled ? "is-disabled" : ""}`}>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-label={ariaLabel}
        disabled={disabled}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown size={14} aria-hidden="true" />
    </div>
  );
}

function PlanTreeNode({
  node,
  totalCost,
}: {
  node: PlanNode;
  totalCost: number;
}) {
  const Icon =
    node.kind === "sort"
      ? ArrowDownUp
      : node.kind === "aggregate"
        ? Layers3
        : node.kind === "join"
          ? GitMerge
          : node.kind === "index"
            ? Search
            : Database;
  return (
    <div className="tree-node">
      <div className="plan-operation">
        <span className={`operation-icon operation-${node.kind}`}>
          <Icon size={16} strokeWidth={1.8} />
        </span>
        <div className="operation-copy">
          <span className="operation-title" title={node.name}>
            {node.name}
          </span>
          <span className="operation-detail">{node.detail}</span>
          <span className="operation-mobile-rows">
            {node.rows.toLocaleString()} rows estimated
          </span>
        </div>
        <div className="operation-cost">
          <span className="cost-bar">
            <span
              style={{
                width: `${Math.max(12, (node.cost / totalCost) * 100)}%`,
              }}
            />
          </span>
          <span className="cost-value">{node.cost.toFixed(2)}</span>
        </div>
        <div className="operation-rows">
          {node.rows.toLocaleString()}
          <span> rows</span>
        </div>
      </div>
      {node.children && (
        <div className="tree-children">
          {node.children.map((child, index) => (
            <PlanTreeNode
              node={child}
              totalCost={totalCost}
              key={`${child.name}-${index}`}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function readDraft(): {
  builder: BuilderState;
  dialect: Dialect;
  manualSql: string | null;
} | null {
  try {
    const saved = localStorage.getItem("querypulse-draft-v1");
    if (!saved) return null;
    const draft = JSON.parse(saved);
    if (
      !TABLE_NAMES.includes(draft.builder?.baseTable) ||
      !Array.isArray(draft.builder?.selectedColumns) ||
      !Array.isArray(draft.builder?.filters)
    )
      return null;
    return {
      builder: draft.builder,
      dialect: DIALECTS.includes(draft.dialect) ? draft.dialect : "PostgreSQL",
      manualSql: typeof draft.manualSql === "string" ? draft.manualSql : null,
    };
  } catch {
    return null;
  }
}

export default function App() {
  const [builder, setBuilder] = useState<BuilderState>(
    () => readDraft()?.builder ?? newBuilderFor("users"),
  );
  const [dialect, setDialect] = useState<Dialect>(
    () => readDraft()?.dialect ?? "PostgreSQL",
  );
  const [manualSql, setManualSql] = useState<string | null>(
    () => readDraft()?.manualSql ?? null,
  );
  const compiledSql = useMemo(() => buildSql(builder), [builder]);
  const sql = manualSql ?? compiledSql;
  const [execution, setExecution] = useState<Execution>(() =>
    makeExecution(
      manualSql ?? buildSql(builder),
      dialect,
      builder,
      142,
      manualSql !== null,
    ),
  );
  const [running, setRunning] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [scriptVisible, setScriptVisible] = useState(false);
  const [resultView, setResultView] = useState<"table" | "json">("table");
  const [toast, setToast] = useState<{
    message: string;
    error: boolean;
  } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const highlightRef = useRef<HTMLPreElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);

  const baseAlias = TABLES[builder.baseTable].alias;
  const joinAlias = TABLES[builder.joinTable].alias;
  const joinTargets = Object.keys(RELATIONS[builder.baseTable]) as TableName[];
  const columnOptions: SelectOption[] = [
    ...TABLES[builder.baseTable].columns.map((column) => ({
      value: `${baseAlias}.${column}`,
      label: `${baseAlias}.${column}`,
    })),
    ...(builder.joinEnabled
      ? TABLES[builder.joinTable].columns.map((column) => ({
          value: `${joinAlias}.${column}`,
          label: `${joinAlias}.${column}`,
        }))
      : []),
  ];
  const selectableColumns: SelectOption[] = [
    ...TABLES[builder.baseTable].columns
      .slice(0, 4)
      .map((column) => ({
        value: `${baseAlias}.${column}`,
        label: `${baseAlias}.${column}`,
      })),
    ...(builder.joinEnabled
      ? TABLES[builder.joinTable].columns
          .filter((column) => !["id", "user_id", "product_id"].includes(column))
          .slice(0, 2)
          .map((column) => ({
            value: `${joinAlias}.${column}`,
            label: `${joinAlias}.${column}`,
          }))
      : []),
    ...(builder.joinEnabled && builder.joinTable === "orders"
      ? [
          { value: "order_count", label: "COUNT(o.id)" },
          { value: "total_spent", label: "SUM(o.total)" },
        ]
      : []),
  ];
  const orderOptions: SelectOption[] = [
    ...columnOptions,
    ...(builder.joinEnabled && builder.joinTable === "orders"
      ? [
          { value: "order_count", label: "order_count" },
          { value: "total_spent", label: "total_spent" },
        ]
      : []),
  ];
  const recommendations = useMemo(
    () => getRecommendations(execution),
    [execution],
  );
  const opportunities = recommendations.filter(
    (item) => item.status === "opportunity",
  );
  const indexRecommendation = recommendations.find((item) => item.script);
  const isStale = execution.sql !== sql || execution.dialect !== dialect;
  const parsedResultTable = execution.sql.match(/\bFROM\s+([a-z_]\w*)/i)?.[1];
  const resultTable =
    TABLE_NAMES.find((name) => name === parsedResultTable) ??
    execution.builder.baseTable;
  const resultRows = PREVIEW_DATA[resultTable]
    .slice(0, execution.rows)
    .map((_, index) =>
      Object.fromEntries(
        execution.columns.map((column) => [
          column,
          resultValue(column, index, resultTable),
        ]),
      ),
    );

  useEffect(() => {
    try {
      localStorage.setItem(
        "querypulse-draft-v1",
        JSON.stringify({ builder, dialect, manualSql }),
      );
    } catch {
      /* The workspace still works if local storage is unavailable. */
    }
  }, [builder, dialect, manualSql]);

  useEffect(() => {
    if (!drawerOpen) return;
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDrawerOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = oldOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [drawerOpen]);

  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
      if (runTimer.current) clearTimeout(runTimer.current);
    },
    [],
  );

  function notify(message: string, error = false) {
    setToast({ message, error });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3200);
  }

  function updateBuilder(update: (previous: BuilderState) => BuilderState) {
    setBuilder(update);
    setManualSql(null);
  }

  function chooseTable(table: TableName) {
    updateBuilder(() => newBuilderFor(table));
  }

  function chooseJoinTable(table: TableName) {
    updateBuilder((previous) => {
      const [joinLeft, joinRight] = relationFor(previous.baseTable, table);
      const prefix = `${TABLES[previous.baseTable].alias}.`;
      const selectedColumns = previous.selectedColumns.filter((column) =>
        column.startsWith(prefix),
      );
      return {
        ...previous,
        joinTable: table,
        joinLeft,
        joinRight,
        selectedColumns: selectedColumns.length
          ? selectedColumns
          : [`${prefix}id`],
        filters: previous.filters.filter((filter) =>
          filter.column.startsWith(prefix),
        ),
        orderBy: previous.orderBy.startsWith(prefix)
          ? previous.orderBy
          : `${prefix}id`,
      };
    });
  }

  function toggleJoin() {
    updateBuilder((previous) => {
      if (!previous.joinEnabled) return { ...previous, joinEnabled: true };
      const prefix = `${TABLES[previous.baseTable].alias}.`;
      const selectedColumns = previous.selectedColumns.filter((column) =>
        column.startsWith(prefix),
      );
      return {
        ...previous,
        joinEnabled: false,
        selectedColumns: selectedColumns.length
          ? selectedColumns
          : [`${prefix}id`],
        filters: previous.filters.filter((filter) =>
          filter.column.startsWith(prefix),
        ),
        orderBy: previous.orderBy.startsWith(prefix)
          ? previous.orderBy
          : `${prefix}id`,
      };
    });
  }

  function toggleColumn(column: string) {
    if (
      builder.selectedColumns.includes(column) &&
      builder.selectedColumns.length === 1
    ) {
      notify("Keep at least one selected column.", true);
      return;
    }
    updateBuilder((previous) => {
      const selectedColumns = previous.selectedColumns.includes(column)
        ? previous.selectedColumns.filter((item) => item !== column)
        : [...previous.selectedColumns, column];
      return {
        ...previous,
        selectedColumns,
        orderBy:
          previous.orderBy === column && !selectedColumns.includes(column)
            ? selectedColumns[0]
            : previous.orderBy,
      };
    });
  }

  function changeFilter(id: number, patch: Partial<FilterRule>) {
    updateBuilder((previous) => ({
      ...previous,
      filters: previous.filters.map((filter) =>
        filter.id === id ? { ...filter, ...patch } : filter,
      ),
    }));
  }

  function addFilter() {
    updateBuilder((previous) => {
      const alias = TABLES[previous.baseTable].alias;
      const availableColumn =
        TABLES[previous.baseTable].columns.find(
          (column) =>
            !previous.filters.some(
              (filter) => filter.column === `${alias}.${column}`,
            ),
        ) ?? "id";
      return {
        ...previous,
        filters: [
          ...previous.filters,
          {
            id: Date.now(),
            column: `${alias}.${availableColumn}`,
            operator: "=",
            value: "",
          },
        ],
      };
    });
  }

  function formatSql() {
    try {
      const formatted = format(sql, {
        language: dialect.toLowerCase() as
          "postgresql" | "mysql" | "sqlite" | "snowflake",
        tabWidth: 2,
        keywordCase: "upper",
      });
      setManualSql(formatted);
      notify("SQL formatted for " + dialect + ".");
    } catch {
      notify("This SQL could not be formatted. Check its syntax.", true);
    }
  }

  function runQuery() {
    if (running) return;
    if (!/\b(SELECT|WITH)\b/i.test(sql)) {
      notify("Add a SELECT query before running the simulation.", true);
      return;
    }
    setRunning(true);
    runTimer.current = setTimeout(() => {
      const latency = 118 + Math.floor(Math.random() * 68);
      setExecution(
        makeExecution(sql, dialect, builder, latency, manualSql !== null),
      );
      setRunning(false);
      setResultView("table");
      setScriptVisible(false);
      notify("Query simulation completed successfully.");
    }, 820);
  }

  async function copyText(text: string, successMessage: string) {
    try {
      if (navigator.clipboard?.writeText)
        await navigator.clipboard.writeText(text);
      else {
        const helper = document.createElement("textarea");
        helper.value = text;
        document.body.appendChild(helper);
        helper.select();
        document.execCommand("copy");
        helper.remove();
      }
      notify(successMessage);
    } catch {
      notify("Could not copy to clipboard.", true);
    }
  }

  function exportReport() {
    const report = [
      "# QueryPulse Query Report",
      "",
      `Dialect: ${dialect}`,
      `Generated: ${new Date().toLocaleString()}`,
      `Analysis status: ${isStale ? "Editor has changes since the last run" : "Up to date"}`,
      "",
      "## SQL Query",
      "```sql",
      sql,
      "```",
      "",
      "## Last Simulated Execution",
      `- Latency: ${execution.latency} ms`,
      `- Rows returned: ${execution.rows.toLocaleString()}`,
      `- Optimization score: ${execution.score}/100`,
      `- Estimated total cost: ${execution.plan.cost.toFixed(2)}`,
      "",
      "## Execution Plan",
      ...planLines(execution.plan),
      "",
      "## Optimizer Recommendations",
      ...recommendations.map(
        (item) =>
          `- ${item.status === "passed" ? "[x]" : "[ ]"} ${item.title}: ${item.description}`,
      ),
      "",
      "Note: Execution, costs, rows, and recommendations are simulated. No database connection is required.",
    ].join("\n");
    const url = URL.createObjectURL(
      new Blob([report], { type: "text/markdown;charset=utf-8" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `querypulse-report-${new Date().toISOString().slice(0, 10)}.md`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    notify("Query report downloaded.");
  }

  function handleEditorKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      runQuery();
    }
    if (event.key === "Tab") {
      event.preventDefault();
      const element = event.currentTarget;
      const start = element.selectionStart;
      setManualSql(
        `${sql.slice(0, start)}  ${sql.slice(element.selectionEnd)}`,
      );
      requestAnimationFrame(() =>
        editorRef.current?.setSelectionRange(start + 2, start + 2),
      );
    }
  }

  function syncEditorScroll() {
    if (!editorRef.current) return;
    if (highlightRef.current) {
      highlightRef.current.scrollTop = editorRef.current.scrollTop;
      highlightRef.current.scrollLeft = editorRef.current.scrollLeft;
    }
    if (gutterRef.current)
      gutterRef.current.scrollTop = editorRef.current.scrollTop;
  }

  const scoreTitle =
    execution.score >= 85
      ? "Looking good"
      : execution.score >= 70
        ? "Room to improve"
        : "Needs attention";

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-inner">
          <a className="brand" href="#workspace" aria-label="QueryPulse home">
            <span className="brand-mark">
              <Database size={23} strokeWidth={1.9} />
              <Zap
                className="brand-zap"
                size={10}
                fill="currentColor"
                strokeWidth={2.2}
              />
            </span>
            <span className="brand-copy">
              <strong>
                Query<span>Pulse</span>
              </strong>
              <small>SQL PERFORMANCE STUDIO</small>
            </span>
          </a>
          <nav className="dialect-nav" aria-label="SQL dialect">
            {DIALECTS.map((item) => (
              <button
                type="button"
                key={item}
                onClick={() => setDialect(item)}
                className={`dialect-tab ${dialect === item ? "active" : ""}`}
                aria-current={dialect === item ? "page" : undefined}
              >
                {item}
              </button>
            ))}
          </nav>
          <div className="header-actions">
            <div
              className="connection-status"
              title="Connected to the local query simulator; no live database is used"
            >
              <span className="status-pulse" />
              <span>
                Query Engine: <strong>Connected</strong>
              </span>
            </div>
            <span className="header-divider" />
            <button
              type="button"
              className="header-text-button"
              onClick={formatSql}
              title="Format SQL"
            >
              <WandSparkles size={16} />
              <span>Format SQL</span>
            </button>
            <button
              type="button"
              className="export-button"
              onClick={exportReport}
              title="Export query report"
            >
              <Download size={16} />
              <span>Export Report</span>
            </button>
          </div>
        </div>
      </header>

      <main className="workspace" id="workspace">
        <div className="page-heading">
          <div>
            <div className="breadcrumb">
              <span>WORKSPACE</span>
              <ChevronRight size={13} />
              <span>QUERY BUILDER</span>
              <span className="breadcrumb-muted">/ customer_revenue.sql</span>
            </div>
            <h1>
              Query workspace<span className="heading-period">.</span>
            </h1>
            <p>
              Build visually, inspect the execution path, and make every query
              count.
            </p>
          </div>
          <button
            type="button"
            className="reset-button"
            onClick={() => {
              setBuilder(newBuilderFor("users"));
              setManualSql(null);
              notify("Workspace reset to the starter query.");
            }}
          >
            <RotateCcw size={15} /> Reset workspace
          </button>
        </div>

        <section
          className="workspace-grid"
          aria-label="Visual SQL query workspace"
        >
          <div className="surface builder-panel">
            <div className="panel-header">
              <div className="panel-header-main">
                <span className="panel-icon cyan-icon">
                  <SlidersHorizontal size={18} />
                </span>
                <div>
                  <h2>Visual builder</h2>
                  <p>Shape your query step by step</p>
                </div>
              </div>
              <span className="mini-status">
                <span /> LIVE SYNC
              </span>
            </div>
            <div className="builder-body">
              <div className="builder-section first-section">
                <div className="section-label">
                  <span>01</span> FROM TABLE
                </div>
                <div className="table-options">
                  {TABLE_NAMES.map((table) => (
                    <button
                      type="button"
                      key={table}
                      className={`table-option ${builder.baseTable === table ? "selected" : ""}`}
                      onClick={() => chooseTable(table)}
                      aria-pressed={builder.baseTable === table}
                    >
                      <Database size={15} strokeWidth={1.9} />
                      <span>{table}</span>
                      <small>{TABLES[table].columns.length}</small>
                    </button>
                  ))}
                </div>
              </div>
              <div className="builder-section">
                <div className="section-label">
                  <span>02</span> SELECT COLUMNS{" "}
                  <small>{builder.selectedColumns.length} selected</small>
                </div>
                <div className="column-options">
                  {selectableColumns.map((column) => {
                    const selected = builder.selectedColumns.includes(
                      column.value,
                    );
                    return (
                      <button
                        type="button"
                        key={column.value}
                        className={`column-chip ${selected ? "selected" : ""}`}
                        onClick={() => toggleColumn(column.value)}
                        aria-pressed={selected}
                      >
                        <span className="chip-indicator">
                          {selected ? (
                            <Check size={11} strokeWidth={3} />
                          ) : (
                            <Plus size={11} />
                          )}
                        </span>
                        {column.label}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="builder-section">
                <div className="section-label with-action">
                  <span>
                    <span className="section-number">03</span> JOIN TABLE
                  </span>
                  <button
                    className={`toggle-switch ${builder.joinEnabled ? "on" : ""}`}
                    type="button"
                    role="switch"
                    aria-label="Include a table join"
                    aria-checked={builder.joinEnabled}
                    onClick={toggleJoin}
                  >
                    <span />
                  </button>
                </div>
                <div
                  className={`join-controls ${!builder.joinEnabled ? "controls-disabled" : ""}`}
                >
                  <div className="control-grid">
                    <SelectField
                      value={builder.joinType}
                      options={[
                        { value: "LEFT JOIN", label: "Left join" },
                        { value: "INNER JOIN", label: "Inner join" },
                        { value: "RIGHT JOIN", label: "Right join" },
                      ]}
                      onChange={(value) =>
                        updateBuilder((previous) => ({
                          ...previous,
                          joinType: value,
                        }))
                      }
                      ariaLabel="Join type"
                      disabled={!builder.joinEnabled}
                    />
                    <SelectField
                      value={builder.joinTable}
                      options={joinTargets.map((table) => ({
                        value: table,
                        label: table,
                      }))}
                      onChange={(value) => chooseJoinTable(value as TableName)}
                      ariaLabel="Table to join"
                      disabled={!builder.joinEnabled}
                    />
                  </div>
                  <div className="relation-caption">
                    <GitMerge size={13} /> ON CONDITION
                  </div>
                  <div className="relation-map">
                    <SelectField
                      value={builder.joinLeft}
                      options={TABLES[builder.baseTable].columns.map(
                        (column) => ({
                          value: `${baseAlias}.${column}`,
                          label: `${baseAlias}.${column}`,
                        }),
                      )}
                      onChange={(value) =>
                        updateBuilder((previous) => ({
                          ...previous,
                          joinLeft: value,
                        }))
                      }
                      ariaLabel="Left join column"
                      disabled={!builder.joinEnabled}
                    />
                    <span className="equals-sign">=</span>
                    <SelectField
                      value={builder.joinRight}
                      options={TABLES[builder.joinTable].columns.map(
                        (column) => ({
                          value: `${joinAlias}.${column}`,
                          label: `${joinAlias}.${column}`,
                        }),
                      )}
                      onChange={(value) =>
                        updateBuilder((previous) => ({
                          ...previous,
                          joinRight: value,
                        }))
                      }
                      ariaLabel="Right join column"
                      disabled={!builder.joinEnabled}
                    />
                  </div>
                </div>
              </div>
              <div className="builder-section">
                <div className="section-label with-action">
                  <span>
                    <span className="section-number">04</span> WHERE FILTERS
                  </span>
                  <Filter size={13} />
                </div>
                <div className="filter-list">
                  {builder.filters.map((filter) => (
                    <div className="filter-row" key={filter.id}>
                      <SelectField
                        value={filter.column}
                        options={columnOptions}
                        onChange={(value) =>
                          changeFilter(filter.id, { column: value })
                        }
                        ariaLabel="Filter column"
                      />
                      <SelectField
                        value={filter.operator}
                        options={["=", "!=", ">", "<", ">=", "<=", "LIKE"].map(
                          (value) => ({ value, label: value }),
                        )}
                        onChange={(value) =>
                          changeFilter(filter.id, { operator: value })
                        }
                        ariaLabel="Filter operator"
                      />
                      <input
                        className="field-input"
                        aria-label="Filter value"
                        placeholder="value"
                        value={filter.value}
                        onChange={(event) =>
                          changeFilter(filter.id, { value: event.target.value })
                        }
                      />
                      <button
                        type="button"
                        className="remove-filter"
                        aria-label="Remove filter"
                        title="Remove filter"
                        onClick={() =>
                          updateBuilder((previous) => ({
                            ...previous,
                            filters: previous.filters.filter(
                              (item) => item.id !== filter.id,
                            ),
                          }))
                        }
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))}
                </div>
                <button
                  type="button"
                  className="add-filter"
                  onClick={addFilter}
                >
                  <Plus size={14} /> Add filter
                </button>
              </div>
              <div className="builder-section last-section">
                <div className="section-label">
                  <span>05</span> ORDER &amp; LIMIT
                </div>
                <div className="order-controls">
                  <SelectField
                    value={builder.orderBy}
                    options={orderOptions}
                    onChange={(value) =>
                      updateBuilder((previous) => ({
                        ...previous,
                        orderBy: value,
                      }))
                    }
                    ariaLabel="Order by column"
                  />
                  <SelectField
                    value={builder.orderDirection}
                    options={[
                      { value: "DESC", label: "Descending" },
                      { value: "ASC", label: "Ascending" },
                    ]}
                    onChange={(value) =>
                      updateBuilder((previous) => ({
                        ...previous,
                        orderDirection: value as "ASC" | "DESC",
                      }))
                    }
                    ariaLabel="Sort direction"
                  />
                </div>
                <div className="limit-control">
                  <span>Row limit</span>
                  <input
                    type="number"
                    min="1"
                    max="10000"
                    value={builder.limit}
                    aria-label="Row limit"
                    onChange={(event) =>
                      updateBuilder((previous) => ({
                        ...previous,
                        limit: Math.min(
                          10000,
                          Math.max(0, Number(event.target.value) || 0),
                        ),
                      }))
                    }
                  />
                </div>
              </div>
            </div>
          </div>

          <div className="surface editor-panel">
            <div className="panel-header editor-panel-header">
              <div className="panel-header-main">
                <span className="panel-icon indigo-icon">
                  <Terminal size={18} />
                </span>
                <div>
                  <h2>SQL editor</h2>
                  <p>Fine-tune the query behind your data</p>
                </div>
              </div>
              <div className="editor-header-actions">
                <button
                  type="button"
                  className="icon-button"
                  onClick={() => copyText(sql, "SQL copied to clipboard.")}
                  title="Copy SQL"
                  aria-label="Copy SQL"
                >
                  <Copy size={16} />
                </button>
                {manualSql !== null && (
                  <button
                    type="button"
                    className="sync-button"
                    onClick={() => {
                      setManualSql(null);
                      notify("Editor synced with visual builder.");
                    }}
                  >
                    Sync builder
                  </button>
                )}
              </div>
            </div>
            <div className="editor-toolbar">
              <div className="editor-file">
                <FileCode2 size={15} />
                <span>customer_revenue.sql</span>
                <span className="file-dot" />
              </div>
              <div className="toolbar-right">
                <span
                  className={`editor-mode ${manualSql !== null ? "manual" : ""}`}
                >
                  <span />
                  {manualSql !== null ? "MANUAL EDIT" : "AUTO-GENERATED"}
                </span>
                <span className="toolbar-separator" />
                <span className="dialect-label">{dialect.toUpperCase()}</span>
              </div>
            </div>
            <div className="code-editor">
              <div className="line-gutter" ref={gutterRef} aria-hidden="true">
                {Array.from(
                  { length: Math.max(21, sql.split("\n").length + 1) },
                  (_, index) => (
                    <span key={index}>{index + 1}</span>
                  ),
                )}
              </div>
              <div className="code-layer">
                <pre ref={highlightRef} aria-hidden="true">
                  {highlightSql(sql)}
                  {"\n"}
                </pre>
                <textarea
                  ref={editorRef}
                  aria-label="SQL query editor"
                  value={sql}
                  onChange={(event) => setManualSql(event.target.value)}
                  onKeyDown={handleEditorKeyDown}
                  onScroll={syncEditorScroll}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoComplete="off"
                  wrap="off"
                />
              </div>
            </div>
            <div className="editor-info-bar">
              <div>
                <span className="tiny-green-dot" />
                {manualSql !== null ? "Custom SQL" : "Builder synced"}
                <span className="info-divider" />
                {sql.split("\n").length} lines
              </div>
              <span>
                UTF-8 <span className="info-divider" /> SQL
              </span>
            </div>
            <div className="query-action-bar">
              <div className="run-summary">
                <span
                  className={`run-summary-icon ${running ? "in-progress" : ""}`}
                >
                  {running ? (
                    <LoaderCircle size={16} className="spin" />
                  ) : (
                    <Check size={16} strokeWidth={2.5} />
                  )}
                </span>
                <div>
                  <strong>
                    {running
                      ? "Executing query..."
                      : isStale
                        ? "Changes ready to run"
                        : "Query completed"}
                  </strong>
                  <span>
                    {running ? (
                      "Running a local simulation"
                    ) : (
                      <>
                        <Clock3 size={12} /> {execution.latency}ms <i />{" "}
                        {execution.rows.toLocaleString()} rows returned
                      </>
                    )}
                  </span>
                </div>
              </div>
              <div className="run-controls">
                <span className="keyboard-hint">Ctrl + Enter</span>
                <button
                  type="button"
                  className="run-button"
                  onClick={runQuery}
                  disabled={running}
                >
                  {running ? (
                    <LoaderCircle size={17} className="spin" />
                  ) : (
                    <Play size={17} fill="currentColor" />
                  )}{" "}
                  {running ? "Running..." : "Run query"}
                </button>
              </div>
            </div>
          </div>
        </section>

        <section className="analysis-section" aria-labelledby="analysis-title">
          <div className="section-heading">
            <div>
              <div className="content-eyebrow">
                UNDER THE HOOD <span />
              </div>
              <h2 id="analysis-title">Execution insights</h2>
              <p>
                Understand where the work happens and where time can be saved.
              </p>
            </div>
            <span className={`analysis-state ${isStale ? "stale" : ""}`}>
              <span />
              {isStale ? "Run to refresh analysis" : "Analysis up to date"}
            </span>
          </div>
          <div className="analysis-grid">
            <div className="surface plan-panel">
              <div className="panel-header plan-panel-header">
                <div className="panel-header-main">
                  <span className="panel-icon violet-icon">
                    <GitMerge size={18} />
                  </span>
                  <div>
                    <h3>Execution plan</h3>
                    <p>Visual path through your query</p>
                  </div>
                </div>
                <span className="plan-badge">EXPLAIN ANALYZE</span>
              </div>
              <div className="plan-body">
                <div className="plan-meta">
                  <span>
                    <span className="plan-meta-dot" /> QUERY PLAN{" "}
                    <span className="plan-meta-sub">/ {execution.dialect}</span>
                  </span>
                  <span>
                    Total cost <strong>{execution.plan.cost.toFixed(2)}</strong>
                  </span>
                </div>
                <div className="plan-tree">
                  <PlanTreeNode
                    node={execution.plan}
                    totalCost={execution.plan.cost}
                  />
                </div>
              </div>
              <div className="plan-footer">
                <Info size={14} />
                <span>
                  Illustrative costs and row estimates from the local simulator,
                  not a live database.
                </span>
              </div>
            </div>
            <div className="insights-column">
              <div className="surface health-panel">
                <div className="side-panel-heading">
                  <span className="side-icon green-icon">
                    <Activity size={18} />
                  </span>
                  <div>
                    <h3>Performance health</h3>
                    <p>Query efficiency at a glance</p>
                  </div>
                </div>
                <div className="score-content">
                  <div className="score-gauge">
                    <svg viewBox="0 0 180 180" aria-hidden="true">
                      <circle className="gauge-track" cx="90" cy="90" r="70" />
                      <circle
                        className="gauge-progress"
                        cx="90"
                        cy="90"
                        r="70"
                        style={{
                          strokeDashoffset: 440 - (execution.score / 100) * 440,
                        }}
                      />
                    </svg>
                    <div className="score-number">
                      <strong>{execution.score}</strong>
                      <span>/ 100</span>
                    </div>
                  </div>
                  <div className="score-verdict">
                    <span>
                      <ShieldCheck size={15} /> OPTIMIZATION SCORE
                    </span>
                    <h4>{scoreTitle}</h4>
                    <p>
                      {execution.score >= 85
                        ? "Your query is running efficiently. A few small changes could make it even better."
                        : "The plan has opportunities to reduce unnecessary database work."}
                    </p>
                  </div>
                </div>
              </div>
              <div className="surface optimizer-teaser">
                <div className="teaser-top">
                  <span className="side-icon purple-icon">
                    <Sparkles size={18} />
                  </span>
                  <span className="suggestion-count">
                    {opportunities.length}{" "}
                    {opportunities.length === 1 ? "SUGGESTION" : "SUGGESTIONS"}
                  </span>
                </div>
                <h3>Make a good query great.</h3>
                <p>
                  {indexRecommendation ? (
                    <>
                      An index on <code>{indexRecommendation.target}</code>{" "}
                      could speed things up.
                    </>
                  ) : (
                    "Explore actionable improvements for this query."
                  )}
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setDrawerOpen(true);
                    setScriptVisible(false);
                  }}
                >
                  View recommendations <ArrowRight size={16} />
                </button>
              </div>
            </div>
          </div>
        </section>

        <section
          className="surface results-panel"
          aria-labelledby="results-title"
        >
          <div className="results-heading">
            <div className="panel-header-main">
              <span className="panel-icon cyan-icon">
                <Table2 size={18} />
              </span>
              <div>
                <h2 id="results-title">Results preview</h2>
                <p>A peek at the rows your query returns</p>
              </div>
            </div>
            <div className="results-actions">
              <div
                className="view-tabs"
                role="tablist"
                aria-label="Results view"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={resultView === "table"}
                  className={resultView === "table" ? "active" : ""}
                  onClick={() => setResultView("table")}
                >
                  <Table2 size={14} /> Table
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={resultView === "json"}
                  className={resultView === "json" ? "active" : ""}
                  onClick={() => setResultView("json")}
                >
                  <FileJson2 size={14} /> JSON
                </button>
              </div>
              <button
                type="button"
                className="icon-button"
                title="Copy preview as JSON"
                aria-label="Copy results as JSON"
                onClick={() =>
                  copyText(
                    JSON.stringify(resultRows, null, 2),
                    "Result preview copied as JSON.",
                  )
                }
              >
                <Copy size={15} />
              </button>
            </div>
          </div>
          {resultView === "table" ? (
            <div className="result-table-scroll">
              <table className="result-table">
                <thead>
                  <tr>
                    <th className="row-index-heading">#</th>
                    {execution.columns.map((column) => (
                      <th key={column}>{column}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {resultRows.map((row, index) => (
                    <tr key={index}>
                      <td className="row-index">
                        {String(index + 1).padStart(2, "0")}
                      </td>
                      {execution.columns.map((column) => {
                        const value = row[column];
                        const money =
                          /^(total|total_spent|price|revenue|amount)$/.test(
                            column.toLowerCase(),
                          );
                        return (
                          <td
                            key={column}
                            className={
                              typeof value === "number" ? "numeric-cell" : ""
                            }
                          >
                            {money && typeof value === "number"
                              ? `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                              : value}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="json-preview">
              <pre>
                <Code2 size={14} /> {JSON.stringify(resultRows, null, 2)}
              </pre>
            </div>
          )}
          <div className="results-footer">
            <span>
              <span className="tiny-green-dot" /> Showing {resultRows.length} of{" "}
              {execution.rows.toLocaleString()} simulated rows
            </span>
            <span>
              Last run{" "}
              {new Date(execution.ranAt).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
          </div>
        </section>
        <footer className="app-footer">
          <span>
            <Zap size={13} /> QueryPulse
          </span>
          <span>
            Built for curious minds and faster queries. Execution is simulated
            locally.
          </span>
          <span>Draft saved in this browser</span>
        </footer>
      </main>

      {drawerOpen && (
        <div
          className="drawer-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setDrawerOpen(false);
          }}
        >
          <aside
            className="recommendation-drawer"
            role="dialog"
            aria-modal="true"
            aria-labelledby="drawer-title"
          >
            <div className="drawer-header">
              <div>
                <div className="drawer-eyebrow">
                  <Sparkles size={14} /> QUERY OPTIMIZER
                </div>
                <h2 id="drawer-title">Smarter queries start here.</h2>
                <p>Actionable insights from your latest simulated execution.</p>
              </div>
              <button
                type="button"
                className="drawer-close"
                onClick={() => setDrawerOpen(false)}
                aria-label="Close recommendations"
              >
                <X size={20} />
              </button>
            </div>
            <div className="drawer-content">
              <div className="drawer-summary">
                <span className="drawer-summary-icon">
                  <Activity size={19} />
                </span>
                <div>
                  <strong>{execution.score}/100 efficiency score</strong>
                  <span>
                    {opportunities.length} opportunities found in your query
                    plan
                  </span>
                </div>
                <span className="drawer-summary-dot" />
              </div>
              <div className="drawer-list-heading">
                RECOMMENDATIONS{" "}
                <span>
                  {recommendations.length.toString().padStart(2, "0")}
                </span>
              </div>
              <div className="recommendation-list">
                {recommendations.map((item, index) => (
                  <div
                    className={`recommendation-item ${item.status}`}
                    key={`${item.title}-${index}`}
                  >
                    <div className="recommendation-status">
                      {item.status === "passed" ? (
                        <CheckCircle2 size={18} />
                      ) : (
                        <CircleAlert size={18} />
                      )}
                    </div>
                    <div>
                      <div className="recommendation-title-row">
                        <h3>{item.title}</h3>
                        {item.impact && <span>{item.impact}</span>}
                      </div>
                      <p>{item.description}</p>
                      {item.target && <code>{item.target}</code>}
                    </div>
                  </div>
                ))}
              </div>
              {indexRecommendation && (
                <div className="script-section">
                  <div className="drawer-list-heading">TAKE ACTION</div>
                  <p>
                    Generate a{" "}
                    {execution.dialect === "Snowflake"
                      ? "clustering"
                      : "CREATE INDEX"}{" "}
                    statement for the highest-impact recommendation.
                  </p>
                  <button
                    type="button"
                    className="generate-button"
                    onClick={() => setScriptVisible(true)}
                  >
                    <Code2 size={16} />{" "}
                    {execution.dialect === "Snowflake"
                      ? "Generate clustering script"
                      : "Generate CREATE INDEX Script"}{" "}
                    <ArrowRight size={15} />
                  </button>
                  {scriptVisible && (
                    <div className="generated-script">
                      <div>
                        <span>
                          <Terminal size={14} /> optimization.sql
                        </span>
                        <button
                          type="button"
                          onClick={() =>
                            copyText(
                              indexRecommendation.script ?? "",
                              "Optimization script copied.",
                            )
                          }
                        >
                          <Copy size={13} /> Copy
                        </button>
                      </div>
                      <pre>{indexRecommendation.script}</pre>
                    </div>
                  )}
                </div>
              )}
              <div className="drawer-note">
                <Info size={15} />
                <span>
                  Recommendations are educational estimates. Validate indexes
                  against your actual workload before applying them.
                </span>
              </div>
            </div>
          </aside>
        </div>
      )}
      {toast && (
        <div
          className={`toast ${toast.error ? "toast-error" : ""}`}
          role="status"
        >
          {toast.error ? <CircleAlert size={17} /> : <CheckCircle2 size={17} />}
          <span>{toast.message}</span>
          <button
            type="button"
            aria-label="Dismiss notification"
            onClick={() => setToast(null)}
          >
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
