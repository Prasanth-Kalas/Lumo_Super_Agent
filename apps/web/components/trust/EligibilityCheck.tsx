interface EligibilityCheckProps {
  report: Record<string, unknown> | null | undefined;
}

export function EligibilityCheck({ report }: EligibilityCheckProps) {
  const ok = report?.eligible === true;
  return (
    <div className="rounded-lg border border-lumo-hair bg-lumo-surface p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-[13px] font-medium text-lumo-fg">Eligibility</div>
          <div className="mt-1 text-[12px] text-lumo-fg-low">
            {Object.keys(report ?? {}).length === 0
              ? "TRUST-1 will compute eligibility when the queue item is created."
              : ok ? "Eligible for reviewer decision." : "Needs reviewer attention."}
          </div>
        </div>
        <span className={ok ? "text-[12px] text-emerald-300" : "text-[12px] text-yellow-300"}>
          {ok ? "eligible" : "review"}
        </span>
      </div>
    </div>
  );
}
