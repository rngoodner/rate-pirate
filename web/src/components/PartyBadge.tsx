/** Small passenger icon + count, shown above a price to mark the party size it
 *  covers (fares are quoted per party, not per person). */
export default function PartyBadge({ adults }: { adults: number }) {
  return (
    <span
      className="flex items-center gap-0.5 text-xs font-semibold text-gray-500"
      aria-label={`Price for ${adults} ${adults === 1 ? 'adult' : 'adults'}`}
    >
      <svg viewBox="0 0 24 24" fill="currentColor" className="h-3.5 w-3.5" aria-hidden>
        <path d="M12 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10Zm0 2c-4.42 0-8 2.24-8 5v1h16v-1c0-2.76-3.58-5-8-5Z" />
      </svg>
      {adults}
    </span>
  );
}
