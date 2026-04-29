interface HealthSignalsTrendProps {
  report: Record<string, unknown> | null | undefined;
}

export function HealthSignalsTrend({ report }: HealthSignalsTrendProps) {
  return (
    <div className="rounded-lg border border-lumo-hair bg-lumo-surface p-4">
      <div className="text-[13px] font-medium text-lumo-fg">Health signals</div>
      <pre className="mt-2 max-h-56 overflow-auto rounded-md bg-lumo-bg p-3 text-[11px] text-lumo-fg-mid">
        {JSON.stringify(report ?? {}, null, 2)}
      </pre>
    </div>
  );
}
