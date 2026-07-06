import type { Cabin } from '@rate-pirate/shared';

// Full class strings (Tailwind needs them literal, not built dynamically).
// One hue per cabin so the badge in the feed matches the chip in Settings.

/** Soft badge style for a cabin label pill. */
export const CABIN_BADGE_CLASS: Record<Cabin, string> = {
  economy: 'bg-gray-100 text-gray-700',
  premium_economy: 'bg-sky-100 text-sky-700',
  business: 'bg-purple-100 text-purple-700',
  first: 'bg-amber-100 text-amber-800',
};

/** Filled style for a selected cabin chip in Settings. */
export const CABIN_CHIP_SELECTED_CLASS: Record<Cabin, string> = {
  economy: 'border-gray-500 bg-gray-500 text-white',
  premium_economy: 'border-sky-500 bg-sky-500 text-white',
  business: 'border-purple-500 bg-purple-500 text-white',
  first: 'border-amber-500 bg-amber-500 text-white',
};
