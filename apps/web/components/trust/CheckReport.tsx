interface CheckReportProps {
  report: Record<string, unknown> | null | undefined;
}

export function CheckReport({ report }: CheckReportProps) {
  const checks = Array.isArray(report?.checks) ? report.checks as Array<Record<string, unknown>> : [];
  if (checks.length === 0) {
    return (
      <div className="rounded-md border border-lumo-hair bg-lumo-bg/60 p-3 text-[12.5px] text-lumo-fg-mid">
        Automated checks have not run yet.
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {checks.map((check) => (
        <div
          key={String(check.id)}
          className="flex items-start justify-between gap-3 rounded-md border border-lumo-hair bg-lumo-bg/60 p-3"
        >
          <div className="min-w-0">
            <div className="text-[13px] font-medium text-lumo-fg">
              {String(check.label ?? check.id)}
            </div>
            <div className="mt-1 text-[11.5px] text-lumo-fg-low">
              {Array.isArray(check.reason_codes) && check.reason_codes.length > 0
                ? check.reason_codes.join(", ")
                : "No blocking findings"}
            </div>
          </div>
          <span className={pillClass(String(check.outcome))}>{String(check.outcome)}</span>
        </div>
      ))}
    </div>
  );
}

function pillClass(outcome: string): string {
  if (outcome === "fail") return "rounded-full bg-red-500/10 px-2 py-1 text-[11px] text-red-300";
  if (outcome === "warn") return "rounded-full bg-yellow-500/10 px-2 py-1 text-[11px] text-yellow-300";
  return "rounded-full bg-emerald-500/10 px-2 py-1 text-[11px] text-emerald-300";
}
