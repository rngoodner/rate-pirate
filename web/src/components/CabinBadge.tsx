import { CABIN_LABELS, type Cabin } from '@rate-pirate/shared';
import { CABIN_BADGE_CLASS } from '../cabinStyle';

/** Small pill marking a deal's cabin; each cabin has its own color. */
export default function CabinBadge({ cabin }: { cabin: Cabin }) {
  return (
    <span
      className={`inline-block whitespace-nowrap rounded-lg px-2 py-0.5 text-xs font-bold ${CABIN_BADGE_CLASS[cabin]}`}
    >
      {CABIN_LABELS[cabin]}
    </span>
  );
}
