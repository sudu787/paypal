"use client";

import { useMemo, useState } from "react";
import { AgGridReact } from "ag-grid-react";
import {
  AllCommunityModule,
  ModuleRegistry,
  themeQuartz,
  type ColDef,
  type GridApi,
  type GridReadyEvent,
} from "ag-grid-community";

ModuleRegistry.registerModules([AllCommunityModule]);

export type LedgerRow = {
  event: {
    id: string;
    createdAt: string;
    category: string;
    eventType: string;
    actorType: string;
    amountCents: number | null;
    currency: string | null;
    paypalRef: string | null;
    note: string | null;
  };
  dealTitle: string | null;
  milestoneTitle: string | null;
  actorName: string | null;
};

const gridTheme = themeQuartz.withParams({
  accentColor: "#147d67",
  backgroundColor: "#ffffff",
  borderColor: "#e1e9e3",
  fontFamily: "Arial, Helvetica, sans-serif",
  fontSize: 13,
  foregroundColor: "#172c2a",
  headerBackgroundColor: "#f5f8f5",
  headerFontWeight: 600,
  rowHoverColor: "#f7faf7",
});

function formatAmount(cents: number | null, currency: string | null) {
  if (cents === null) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: currency ?? "USD" }).format(cents / 100);
}

function eventLabel(value: string) {
  return value.toLowerCase().replaceAll("_", " ");
}

function csvCell(value: string | number | null) {
  const text = value === null ? "" : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

function downloadFallback(rows: LedgerRow[]) {
  const headers = ["Time", "Event", "Category", "Agreement", "Milestone", "Actor", "Amount", "Reference"];
  const lines = rows.map(({ event, dealTitle, milestoneTitle, actorName }) => [
    event.createdAt,
    event.eventType,
    event.category,
    dealTitle,
    milestoneTitle,
    actorName ?? event.actorType,
    event.amountCents === null ? null : formatAmount(event.amountCents, event.currency),
    event.paypalRef ?? event.note,
  ].map(csvCell).join(","));
  const blob = new Blob([[headers.map(csvCell).join(","), ...lines].join("\r\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "holdfast-application-audit.csv";
  anchor.click();
  URL.revokeObjectURL(url);
}

export default function LedgerGrid({ rows }: { rows: LedgerRow[] }) {
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("ALL");
  const [gridApi, setGridApi] = useState<GridApi<LedgerRow> | null>(null);
  const categories = useMemo(() => [...new Set(rows.map((row) => row.event.category))].sort(), [rows]);
  const filteredRows = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return rows.filter((row) => {
      if (category !== "ALL" && row.event.category !== category) return false;
      if (!query) return true;
      return [row.event.eventType, row.event.category, row.dealTitle, row.milestoneTitle, row.actorName, row.event.actorType, row.event.paypalRef, row.event.note]
        .some((value) => value?.toLocaleLowerCase().includes(query));
    });
  }, [rows, search, category]);
  const amountTotals = useMemo(() => {
    const totals = new Map<string, number>();
    for (const { event } of filteredRows) if (event.amountCents !== null) {
      const currency = event.currency ?? "USD";
      totals.set(currency, (totals.get(currency) ?? 0) + event.amountCents);
    }
    return [...totals].map(([currency, cents]) => formatAmount(cents, currency)).join(" / ") || "—";
  }, [filteredRows]);

  const columnDefs = useMemo<ColDef<LedgerRow>[]>(() => [
    {
      headerName: "Time",
      field: "event.createdAt",
      sort: "desc",
      minWidth: 170,
      valueFormatter: ({ value }) => value ? new Date(value).toLocaleString() : "—",
    },
    {
      headerName: "Event",
      field: "event.eventType",
      minWidth: 185,
      valueFormatter: ({ value }) => value ? eventLabel(value) : "—",
      cellClass: "font-semibold text-[#31574a]",
    },
    {
      headerName: "Agreement / milestone",
      minWidth: 220,
      flex: 1,
      valueGetter: ({ data }) => data ? [data.dealTitle, data.milestoneTitle].filter(Boolean).join(" / ") || "Account" : "Account",
      tooltipValueGetter: ({ value }) => value,
    },
    {
      headerName: "Actor",
      minWidth: 130,
      valueGetter: ({ data }) => data?.actorName ?? data?.event.actorType.toLowerCase() ?? "—",
    },
    {
      headerName: "Amount",
      minWidth: 135,
      type: "rightAligned",
      valueGetter: ({ data }) => data?.event.amountCents === null || !data ? null : data.event.amountCents / 100,
      valueFormatter: ({ value, data }) => value === null || value === undefined ? "—" : formatAmount(Math.round(value * 100), data?.event.currency ?? "USD"),
    },
    {
      headerName: "Reference",
      minWidth: 160,
      valueGetter: ({ data }) => data?.event.paypalRef ?? data?.event.note ?? "—",
      tooltipValueGetter: ({ value }) => value,
      cellClass: "font-mono text-xs",
    },
  ], []);
  const defaultColDef = useMemo<ColDef<LedgerRow>>(() => ({ sortable: true, filter: true, resizable: true }), []);

  function exportCsv() {
    if (gridApi) gridApi.exportDataAsCsv({ fileName: "holdfast-application-audit.csv" });
    else downloadFallback(filteredRows);
  }

  return <div className="mt-8">
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="rounded-2xl border border-[#e1e9e3] bg-white p-4">
        <div className="text-xs text-[#82918b]">Matching events</div>
        <div className="mt-2 text-2xl font-semibold">{filteredRows.length}</div>
      </div>
      <div className="rounded-2xl border border-[#e1e9e3] bg-white p-4">
        <div className="text-xs text-[#82918b]">Amount references</div>
        <div className="mt-2 text-2xl font-semibold">{amountTotals}</div>
        <div className="mt-1 text-[11px] text-[#82918b]">Lifecycle events may repeat amounts; this is not a balance.</div>
      </div>
    </div>

    <div className="mt-5 flex flex-col gap-3 sm:flex-row">
      <label className="min-w-0 flex-1 text-xs font-semibold text-[#526c60]">
        Search events
        <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search agreement, event, actor, or reference" className="mt-1 h-11 w-full rounded-xl border border-[#dce5df] bg-white px-3 text-sm font-normal text-[#172c2a]" />
      </label>
      <label className="text-xs font-semibold text-[#526c60] sm:w-48">
        Event category
        <select value={category} onChange={(event) => setCategory(event.target.value)} className="mt-1 h-11 w-full rounded-xl border border-[#dce5df] bg-white px-3 text-sm font-normal text-[#172c2a]">
          <option value="ALL">All categories</option>
          {categories.map((value) => <option key={value} value={value}>{value.toLowerCase()}</option>)}
        </select>
      </label>
      <button type="button" onClick={exportCsv} disabled={filteredRows.length === 0} className="h-11 self-end rounded-xl bg-[#147d67] px-4 text-sm font-bold text-white hover:bg-[#106c5a] disabled:cursor-not-allowed disabled:opacity-50">Export CSV</button>
    </div>
    <p className="mt-2 text-xs text-[#82918b]">Showing {filteredRows.length} of {rows.length} party-visible events.</p>

    {filteredRows.length === 0 ? <div className="mt-4 rounded-2xl border border-dashed border-[#cad8ce] bg-white p-8 text-sm text-[#657572]">No events match these filters.</div> : <>
      <div className="mt-4 hidden overflow-hidden rounded-2xl border border-[#e1e9e3] bg-white md:block">
        <AgGridReact<LedgerRow>
          rowData={filteredRows}
          columnDefs={columnDefs}
          defaultColDef={defaultColDef}
          getRowId={({ data }) => data.event.id}
          pagination
          paginationPageSize={25}
          paginationPageSizeSelector={[25, 50, 100]}
          theme={gridTheme}
          domLayout="autoHeight"
          onGridReady={(event: GridReadyEvent<LedgerRow>) => setGridApi(event.api)}
        />
      </div>
      <div className="mt-4 grid gap-3 md:hidden">
        {filteredRows.map(({ event, dealTitle, milestoneTitle, actorName }) => <article key={event.id} className="rounded-2xl border border-[#e1e9e3] bg-white p-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div><div className="text-sm font-semibold capitalize text-[#31574a]">{eventLabel(event.eventType)}</div><div className="mt-1 text-[10px] font-semibold uppercase tracking-wide text-[#82918b]">{event.category}</div></div>
            <time className="text-right text-[11px] text-[#657572]">{new Date(event.createdAt).toLocaleString()}</time>
          </div>
          <div className="mt-3 text-sm font-medium">{dealTitle ?? "Account"}</div>
          {milestoneTitle && <div className="mt-1 text-xs text-[#82918b]">{milestoneTitle}</div>}
          <div className="mt-3 flex items-center justify-between gap-3 text-xs"><span className="text-[#657572]">{actorName ?? event.actorType.toLowerCase()}</span><span className="font-semibold">{formatAmount(event.amountCents, event.currency)}</span></div>
          {(event.paypalRef || event.note) && <div className="mt-2 break-all border-t border-[#edf1ee] pt-2 font-mono text-[10px] text-[#82918b]">{event.paypalRef ?? event.note}</div>}
        </article>)}
      </div>
    </>}
  </div>;
}
