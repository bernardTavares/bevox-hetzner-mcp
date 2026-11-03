/**
 * console/src/components/EntityTable.tsx
 *
 * Generic, configurable hairline+zebra table. Dumb/presentational — no data fetching.
 * Screens pass rows and columns; render? fn overrides default cell rendering.
 *
 * Row keying: provide either `rowKey` (field name on T) or `rowKeyFn` (computed
 * key from row + index). `rowKeyFn` takes precedence when both are supplied.
 * Existing callers using `rowKey` continue to compile unchanged.
 */

interface Column<T> {
  key: keyof T & string;
  /** Optional stable React key for this column — use when two columns share the same `key` field. */
  id?: string;
  header: string;
  render?: (row: T) => React.ReactNode;
}

interface EntityTableProps<T extends Record<string, unknown>> {
  columns: Column<T>[];
  rows: T[];
  /** Field on T whose value is used as the React row key. */
  rowKey?: keyof T & string;
  /**
   * Compute the React row key from the row and its index.
   * Takes precedence over `rowKey` when provided.
   * Use when rows have no natural unique field (e.g. StateEvent audit log).
   */
  rowKeyFn?: (row: T, index: number) => string;
  onRowClick?: (row: T) => void;
}

export function EntityTable<T extends Record<string, unknown>>({
  columns,
  rows,
  rowKey,
  rowKeyFn,
  onRowClick,
}: EntityTableProps<T>) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {columns.map((col) => (
              <th key={col.id ?? col.key} scope="col">{col.header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const key = rowKeyFn
              ? rowKeyFn(row, index)
              : String(row[rowKey as keyof T] ?? index);
            return (
              <tr
                key={key}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                style={onRowClick ? { cursor: "pointer" } : undefined}
              >
                {columns.map((col) => (
                  <td key={col.id ?? col.key}>
                    {col.render
                      ? col.render(row)
                      : String(row[col.key] ?? "")}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
