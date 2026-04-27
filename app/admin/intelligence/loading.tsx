/**
 * /admin/intelligence loading skeleton.
 *
 * Mirrors the section grid of the dashboard so the perceived load is
 * smooth — header, filter row, four chart frames, then the endpoint
 * table. Pure server component, zero JS.
 */

export default function IntelligenceLoading() {
  return (
    <div className="space-y-6">
      <header className="flex items-baseline justify-between">
        <div className="space-y-2">
          <div className="h-6 w-40 rounded bg-lumo-elevated/70 animate-pulse" />
          <div className="h-3.5 w-72 rounded bg-lumo-elevated/40 animate-pulse" />
        </div>
        <div className="h-7 w-56 rounded-md bg-lumo-elevated/60 animate-pulse" />
      </header>

      <section className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <SkeletonCard h="h-[140px]" />
        <SkeletonCard h="h-[140px]" />
        <SkeletonCard h="h-[140px]" />
      </section>

      <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <SkeletonCard h="h-[280px]" />
        <SkeletonCard h="h-[280px]" />
      </section>

      <SkeletonCard h="h-[160px]" />
      <SkeletonCard h="h-[320px]" />
    </div>
  );
}

function SkeletonCard({ h }: { h: string }) {
  return (
    <div
      className={
        "rounded-xl border border-lumo-hair bg-lumo-surface p-5 " +
        "animate-pulse " +
        h
      }
    >
      <div className="h-3.5 w-32 rounded bg-lumo-elevated/70" />
      <div className="mt-2 h-3 w-56 rounded bg-lumo-elevated/40" />
      <div className="mt-5 h-[60%] w-full rounded bg-lumo-elevated/30" />
    </div>
  );
}
