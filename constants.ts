export type CabinSize = '2c' | '3c' | '4c' | '6c' | '6t';

export interface Family {
  rank: number;
  preferences: { week: number; size: CabinSize }[];
}

// Cabin inventory by size. '6t' (6-person tent site) has no modeled inventory:
// availability comes from the openings PDF (first-come-first-served), not the waitlist.
export const INVENTORY_PER_WEEK: Record<CabinSize, number> = {
  '2c': 9,
  '3c': 16,
  '4c': 15,
  '6c': 28,
  '6t': 0,
};

export const TOTAL_WEEKS = 11;
