/** Compact muted airline label (tiny plane glyph + name). Shows the primary
 *  marketing carrier of a deal; renders nothing when the airline is unknown. */
export default function AirlineLabel({ airline }: { airline: string | null }) {
  if (!airline) return null;
  return (
    <span className="flex items-center gap-1 text-xs text-gray-400">
      <svg viewBox="0 0 24 24" className="h-3 w-3 shrink-0" fill="currentColor" aria-hidden="true">
        <path d="M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5L21 16Z" />
      </svg>
      {airline}
    </span>
  );
}
