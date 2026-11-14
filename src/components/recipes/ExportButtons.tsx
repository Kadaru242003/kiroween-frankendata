/**
 * ExportButtons (Feature 5, Requirement 1): CSV, Excel, and Parquet export of
 * one table. Feedback stays in place (a polite live region); nothing scrolls or
 * moves focus. The core exporter and the download are injectable for tests.
 */
import { useCallback, useRef, useState, type JSX } from "react";
import {
  exportTable,
  type ExportedFile,
} from "../../core/recipes/table-exporter";
import type { ExportFormat } from "../../core/recipes/types";
import type { DuckDBService, LoadedTable } from "../../core/types";
import { downloadBytes } from "./download";
import "./Recipes.css";

export interface ExportButtonsProps {
  db: DuckDBService;
  table: Pick<LoadedTable, "tableName" | "schema" | "rowCount">;
  exporter?: typeof exportTable;
  download?: (fileName: string, mime: string, data: string | Uint8Array) => void;
}

const LABELS: Record<ExportFormat, string> = {
  csv: "CSV",
  xlsx: "Excel",
  parquet: "Parquet",
};
const FORMATS: ExportFormat[] = ["csv", "xlsx", "parquet"];

export function ExportButtons({
  db,
  table,
  exporter = exportTable,
  download = downloadBytes,
}: ExportButtonsProps): JSX.Element {
  const [busy, setBusy] = useState<ExportFormat | null>(null);
  const [message, setMessage] = useState("");
  const [isError, setIsError] = useState(false);
  const busyRef = useRef(false);

  const run = useCallback(
    async (format: ExportFormat) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(format);
      setMessage("");
      try {
        const file: ExportedFile = await exporter(db, table, format);
        download(file.fileName, file.mime, file.data);
        setIsError(false);
        setMessage(`Exported ${file.fileName}`);
      } catch (error) {
        setIsError(true);
        setMessage(error instanceof Error ? error.message : "The export failed.");
      } finally {
        busyRef.current = false;
        setBusy(null);
      }
    },
    [db, table, exporter, download]
  );

  return (
    <div className="export-buttons" role="group" aria-label={`Export ${table.tableName}`}>
      <span className="export-buttons__label">Export</span>
      {FORMATS.map((format) => (
        <button
          key={format}
          type="button"
          className="export-buttons__button"
          aria-label={`Export ${table.tableName} as ${LABELS[format]}`}
          disabled={busy !== null}
          aria-busy={busy === format}
          onClick={() => void run(format)}
        >
          {busy === format ? "Exporting..." : LABELS[format]}
        </button>
      ))}
      <span
        className={`export-buttons__message${isError ? " export-buttons__message--error" : ""}`}
        role="status"
        aria-live="polite"
      >
        {message}
      </span>
      {busy === "parquet" ? null : (
        <span className="export-buttons__hint">
          Parquet is written by DuckDB and may fetch its Parquet extension once. No data is sent.
        </span>
      )}
    </div>
  );
}

export default ExportButtons;
