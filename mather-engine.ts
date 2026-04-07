import { type CabinSize, type Family, INVENTORY_PER_WEEK, TOTAL_WEEKS } from './constants';

type Inventory = Record<number, Record<CabinSize, number>>;

// --- Simulation config ---

const MONTE_CARLO_RUNS = 2000;
// Everyone on the waitlist has paid a $200 deposit, so commitment is higher
// than a free signup. Rates reflect paid-deposit behavior.
const FLAKE_RATE = 0.05;        // 5% actively decline (schedule conflict, changed plans)
const TIMEOUT_RATE = 0.08;      // 8% let the 24h decision window lapse (missed email, on vacation)

export { FLAKE_RATE, TIMEOUT_RATE, MONTE_CARLO_RUNS };

// --- Types ---

export interface SimulationResult extends Family {
  isSuccessful: boolean;
  assignedWeek?: number;
  assignedSize?: CabinSize;
  probability?: number; // 0-100, from Monte Carlo
}

export interface MonteCarloSummary {
  runs: number;
  flakeRate: number;
  timeoutRate: number;
  probability: number;            // 0-100
  assignedWeekCounts: Record<number, number>; // week -> times assigned
  mostLikelyWeek?: number;
  mostLikelySize?: CabinSize;
  avgAbsorbedElsewhere: number;   // avg families ahead absorbed by other weeks per run
  avgDropouts: number;            // avg families ahead who flaked/timed out per run
  weekIndependentProbability: Record<number, number>; // week -> probability if ONLY that week existed
}

// --- Inventory ---

export function buildInventory(): Inventory {
  const inventory: Inventory = {};
  for (let week = 1; week <= TOTAL_WEEKS; week++) {
    inventory[week] = { ...INVENTORY_PER_WEEK };
  }
  return inventory;
}

// --- Deterministic simulation (baseline, no randomness) ---

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

// --- Monte Carlo simulation ---

// Seeded PRNG (xorshift32) for reproducible results
function createRng(seed: number) {
  let state = seed | 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >> 17;
    state ^= state << 5;
    return (state >>> 0) / 0xFFFFFFFF;
  };
}

// Jitter range: families can shift +/- this many positions in each run.
// Models real-world variation in response timing and admin processing order.
const RANK_JITTER = 15;

// Dropout rate varies per family per run: base rate +/- this spread.
// Models that some families are flakier than others.
const DROPOUT_SPREAD = 0.12;

function simulateOnce(
  waitlist: Family[],
  baseDropRate: number,
  rng: () => number,
  protectedRank?: number,
): Map<number, { week: number; size: CabinSize }> {
  const state = buildInventory();
  const assignments = new Map<number, { week: number; size: CabinSize }>();

  // Jitter the processing order slightly each run
  const jittered = waitlist.map((f) => ({
    family: f,
    sortKey: f.rank === protectedRank
      ? f.rank // protected family keeps exact position
      : f.rank + (rng() * 2 - 1) * RANK_JITTER,
  }));
  jittered.sort((a, b) => a.sortKey - b.sortKey);

  for (const { family } of jittered) {
    for (const choice of family.preferences) {
      const weekState = state[choice.week];
      if (weekState && weekState[choice.size] > 0) {
        // Slot is available — family gets offered this cabin.
        // Protected family (the user) always accepts.
        // Other families: per-family dropout rate varies around the base.
        if (family.rank !== protectedRank) {
          const familyDropRate = Math.max(0, Math.min(1,
            baseDropRate + (rng() * 2 - 1) * DROPOUT_SPREAD,
          ));
          if (rng() < familyDropRate) {
            break;
          }
        }
        weekState[choice.size]--;
        assignments.set(family.rank, { week: choice.week, size: choice.size });
        break;
      }
    }
  }

  return assignments;
}

export function monteCarloForFamily(
  rank: number,
  waitlist: Family[],
  runs = MONTE_CARLO_RUNS,
  flakeRate = FLAKE_RATE,
  timeoutRate = TIMEOUT_RATE,
): MonteCarloSummary {
  const dropRate = flakeRate + timeoutRate;
  let successes = 0;
  const weekCounts: Record<number, number> = {};
  const sizeCounts: Record<string, number> = {};
  const rng = createRng(rank * 7919 + 42);

  // Identify which week+size combos this family wants
  const myFamily = waitlist.find((f) => f.rank === rank);
  const myPrefs = myFamily?.preferences ?? [];
  const myWeekSizes = new Set(myPrefs.map((p) => `${p.week}:${p.size}`));

  // Find families ahead who compete for any of my week+size combos
  const competitors = waitlist.filter(
    (f) =>
      f.rank < rank &&
      f.preferences.some((p) => myWeekSizes.has(`${p.week}:${p.size}`)),
  );
  const competitorRanks = new Set(competitors.map((f) => f.rank));

  let totalAbsorbed = 0;
  let totalDropouts = 0;

  for (let i = 0; i < runs; i++) {
    const assignments = simulateOnce(waitlist, dropRate, rng, rank);
    const result = assignments.get(rank);

    if (result) {
      successes++;
      weekCounts[result.week] = (weekCounts[result.week] || 0) + 1;
      sizeCounts[result.size] = (sizeCounts[result.size] || 0) + 1;
    }

    // Count competitors who got absorbed by a DIFFERENT week than mine
    let absorbed = 0;
    let dropped = 0;
    for (const compRank of competitorRanks) {
      const compAssignment = assignments.get(compRank);
      if (!compAssignment) {
        // Not assigned at all = dropped out
        dropped++;
      } else if (!myWeekSizes.has(`${compAssignment.week}:${compAssignment.size}`)) {
        // Assigned to a week+size that doesn't compete with me
        absorbed++;
      }
    }
    totalAbsorbed += absorbed;
    totalDropouts += dropped;
  }

  const probability = Math.round((successes / runs) * 100);

  // Find most likely assignment
  let mostLikelyWeek: number | undefined;
  let mostLikelySize: CabinSize | undefined;
  let maxWeekCount = 0;
  let maxSizeCount = 0;

  for (const [week, count] of Object.entries(weekCounts)) {
    if (count > maxWeekCount) {
      maxWeekCount = count;
      mostLikelyWeek = Number(week);
    }
  }
  for (const [size, count] of Object.entries(sizeCounts)) {
    if (count > maxSizeCount) {
      maxSizeCount = count;
      mostLikelySize = size as CabinSize;
    }
  }

  // Per-week independent probability: "if I only had this week, what are my odds?"
  const weekIndependentProbability: Record<number, number> = {};
  const uniqueWeeks = [...new Set(myPrefs.map((p) => p.week))];
  const indyRuns = Math.min(runs, 500); // fewer runs per week to keep it fast

  for (const targetWeek of uniqueWeeks) {
    const weekOnlyPrefs = myPrefs.filter((p) => p.week === targetWeek);
    const hypotheticalFamily: Family = { rank, preferences: weekOnlyPrefs };
    const hypotheticalWaitlist = waitlist.map((f) =>
      f.rank === rank ? hypotheticalFamily : f,
    );

    const indyRng = createRng(rank * 7919 + targetWeek * 31 + 99);
    let indySuccesses = 0;
    for (let i = 0; i < indyRuns; i++) {
      const assignments = simulateOnce(hypotheticalWaitlist, dropRate, indyRng, rank);
      if (assignments.has(rank)) indySuccesses++;
    }
    weekIndependentProbability[targetWeek] = Math.round((indySuccesses / indyRuns) * 100);
  }

  return {
    runs,
    flakeRate,
    timeoutRate,
    probability,
    assignedWeekCounts: weekCounts,
    mostLikelyWeek,
    mostLikelySize,
    avgAbsorbedElsewhere: Math.round(totalAbsorbed / runs),
    avgDropouts: Math.round(totalDropouts / runs),
    weekIndependentProbability,
  };
}

// --- Week breakdown (deterministic, for the table) ---

export interface WeekBreakdown {
  week: number;
  size: CabinSize;
  totalSlots: number;
  familiesAhead: number;
  effectiveRank: number;
  slotsRemaining: number;
  likely: boolean;
}

export function computeWeekBreakdown(
  rank: number,
  waitlist: Family[],
): WeekBreakdown[] {
  const family = waitlist.find((f) => f.rank === rank);
  if (!family) return [];

  return family.preferences.map((pref) => {
    const familiesAhead = waitlist.filter(
      (f) =>
        f.rank < rank &&
        f.preferences.some(
          (p) => p.week === pref.week && p.size === pref.size,
        ),
    ).length;

    const totalSlots = INVENTORY_PER_WEEK[pref.size];
    const slotsRemaining = Math.max(0, totalSlots - familiesAhead);

    return {
      week: pref.week,
      size: pref.size,
      totalSlots,
      familiesAhead,
      effectiveRank: familiesAhead + 1,
      slotsRemaining,
      likely: familiesAhead < totalSlots,
    };
  });
}

// --- Cabin demand stats ---

export interface CabinDemand {
  size: CabinSize;
  totalFamilies: number;
  totalSlots: number;
  ratio: number;
}

export function computeCabinDemand(waitlist: Family[]): CabinDemand[] {
  const counts: Record<CabinSize, Set<number>> = {
    '2c': new Set(),
    '3c': new Set(),
    '4c': new Set(),
    '6c': new Set(),
  };

  for (const family of waitlist) {
    for (const pref of family.preferences) {
      counts[pref.size].add(family.rank);
    }
  }

  return (['4c', '6c', '3c', '2c'] as CabinSize[]).map((size) => {
    const totalFamilies = counts[size].size;
    const totalSlots = INVENTORY_PER_WEEK[size] * TOTAL_WEEKS;
    return {
      size,
      totalFamilies,
      totalSlots,
      ratio: totalSlots > 0 ? totalFamilies / totalSlots : 0,
    };
  });
}

export interface WeekCabinDemand {
  size: CabinSize;
  families: number;
  slots: number;
  ratio: number;
}

export interface WeekDemand {
  week: number;
  cabins: WeekCabinDemand[];
  totalFamilies: number;
}

export function computeWeekDemand(
  weeks: number[],
  waitlist: Family[],
): WeekDemand[] {
  return weeks.map((week) => {
    const familiesThisWeek = new Set<number>();
    const counts: Record<CabinSize, number> = { '2c': 0, '3c': 0, '4c': 0, '6c': 0 };

    for (const family of waitlist) {
      for (const pref of family.preferences) {
        if (pref.week === week) {
          counts[pref.size]++;
          familiesThisWeek.add(family.rank);
        }
      }
    }

    const cabins: WeekCabinDemand[] = (['4c', '6c', '3c', '2c'] as CabinSize[]).map((size) => {
      const slots = INVENTORY_PER_WEEK[size];
      const families = counts[size];
      return { size, families, slots, ratio: slots > 0 ? families / slots : 0 };
    });

    return { week, cabins, totalFamilies: familiesThisWeek.size };
  });
}
