export type CabinSize = '2c' | '3c' | '4c' | '6c';

export interface Family {
  rank: number;
  preferences: { week: number; size: CabinSize }[];
}

export const INVENTORY_PER_WEEK: Record<CabinSize, number> = {
  '2c': 9,
  '3c': 16,
  '4c': 15,
  '6c': 28
};

export const TOTAL_WEEKS = 11;
