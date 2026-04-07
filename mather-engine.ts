import { type CabinSize, type Family, INVENTORY_PER_WEEK, TOTAL_WEEKS } from './constants';

type Inventory = Record<number, Record<CabinSize, number>>;

export interface SimulationResult extends Family {
  isSuccessful: boolean;
  assignedWeek?: number;
  assignedSize?: CabinSize;
}

export function buildInventory(): Inventory {
  const inventory: Inventory = {};
  for (let week = 1; week <= TOTAL_WEEKS; week++) {
    inventory[week] = { ...INVENTORY_PER_WEEK };
  }
  return inventory;
}

export function simulate(waitlist: Family[]): SimulationResult[] {
  const state = buildInventory();

  return waitlist.map((family) => {
    for (const choice of family.preferences) {
      const weekState = state[choice.week];
      if (weekState && weekState[choice.size] > 0) {
        weekState[choice.size]--;
        return {
          ...family,
          isSuccessful: true,
          assignedWeek: choice.week,
          assignedSize: choice.size,
        };
      }
    }
    return { ...family, isSuccessful: false };
  });
}
