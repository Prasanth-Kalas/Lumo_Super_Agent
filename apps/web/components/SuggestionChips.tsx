"use client";

export interface SuggestionChipItem {
  id: string;
  label: string;
  value: string;
}

export default function SuggestionChips({
  suggestions,
  onChipSelect,
  disabled = false,
}: {
  suggestions: SuggestionChipItem[];
  onChipSelect: (value: string) => void;
  disabled?: boolean;
}) {
  if (suggestions.length === 0) return null;

  return (
    <div
      className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 pt-0.5"
      aria-label="Suggested replies"
      data-testid="suggestion-chips"
    >
      {suggestions.map((suggestion) => (
        <button
          key={suggestion.id}
          type="button"
          disabled={disabled}
          onClick={() => onChipSelect(suggestion.value)}
          className="shrink-0 rounded-full border border-lumo-edge bg-lumo-surface/70 px-3.5 py-2 text-[13px] font-medium text-lumo-fg-mid shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] transition-colors hover:border-lumo-fg-low hover:bg-lumo-elevated hover:text-lumo-fg disabled:cursor-not-allowed disabled:opacity-50"
        >
          {suggestion.label}
        </button>
      ))}
    </div>
  );
}
