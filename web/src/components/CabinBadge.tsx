import { CABIN_LABELS, type Cabin } from '@rate-pirate/shared';

/** Small pill marking a deal's cabin. Premium cabins get a purple accent. */
export default function CabinBadge({ cabin }: { cabin: Cabin }) {
  const premium = cabin !== 'economy';
  return (
    <span
      className={`inline-block whitespace-nowrap rounded-lg px-2 py-0.5 text-xs font-bold ${
        premium ? 'bg-purple-100 text-purple-700' : 'bg-gray-100 text-gray-600'
      }`}
    >
      {CABIN_LABELS[cabin]}
    </span>
  );
}
