import { type CabinSize, type Family, INVENTORY_PER_WEEK, TOTAL_WEEKS } from './constants';

type Inventory = Record<number, Record<CabinSize, number>>;

// --- Simulation config ---

const MONTE_CARLO_RUNS = 2000;

// Rate for EXISTING reservation holders giving up their cabin
const RESERVATION_CANCEL_RATE = 0.20;  // 20% of current holders give up their reservation

// Rates for WAITLISTED families when offered a spot
const WAITLIST_LAPSE_RATE = 0.15;      // 15% won't answer the email in time

// Flake rate scales up as the week approaches — by late summer, many waitlisted
// families have made other plans since they've been waiting months.
const WAITLIST_FLAKE_BASE = 0.05;      // Early summer: 5% made other plans
const WAITLIST_FLAKE_LATE = 0.25;      // Late summer: 25% made other plans

// Linear interpolation: week 1 = base, week 11 = late
function waitlistFlakeRate(week: number): number {
  const t = Math.max(0, Math.min(1, (week - 1) / (TOTAL_WEEKS - 1)));
  return WAITLIST_FLAKE_BASE + t * (WAITLIST_FLAKE_LATE - WAITLIST_FLAKE_BASE);
}

export { RESERVATION_CANCEL_RATE, WAITLIST_LAPSE_RATE, WAITLIST_FLAKE_BASE, WAITLIST_FLAKE_LATE, waitlistFlakeRate, MONTE_CARLO_RUNS };

// --- Types ---

export interface SimulationResult extends Family {
  isSuccessful: boolean;
  assignedWeek?: number;
  assignedSize?: CabinSize;
  probability?: number;
}

export interface MonteCarloSummary {
  runs: number;
  reservationCancelRate: number;
  waitlistLapseRate: number;
  waitlistFlakeBase: number;
  waitlistFlakeLate: number;
  probability: number;
  assignedWeekCounts: Record<number, number>;
  mostLikelyWeek?: number;
  mostLikelySize?: CabinSize;
  avgCancellations: number;       // avg reservation cancellations per run
  avgAbsorbedElsewhere: number;
  weekIndependentProbability: Record<number, number>;
}

// --- Inventory helpers ---

export function buildFullInventory(): Inventory {
  const inventory: Inventory = {};
  for (let week = 1; week <= TOTAL_WEEKS; week++) {
    inventory[week] = { ...INVENTORY_PER_WEEK };
  }
  return inventory;
}

// --- Seeded PRNG ---

function createRng(seed: number) {
  let state = seed | 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >> 17;
    state ^= state << 5;
    return (state >>> 0) / 0xFFFFFFFF;
  };
}

// --- Core simulation ---
// All cabins are occupied. For each cabin, roll whether the holder cancels.
// Cancellations create openings. Waitlisted families fill openings in rank order.

const RANK_JITTER = 15;

// Waitlist dropout is per-week: lapse (fixed) + flake (scales with season)

function simulateOnce(
  waitlist: Family[],
  reservationRate: number,
  rng: () => number,
  protectedRank?: number,
): { assignments: Map<number, { week: number; size: CabinSize }>; totalCancellations: number } {
  const fullInventory = buildFullInventory();

  // Step 1: Roll cancellations — each reservation holder may give up their cabin
  const openings: Inventory = {};
  let totalCancellations = 0;
  for (let week = 1; week <= TOTAL_WEEKS; week++) {
    openings[week] = { '2c': 0, '3c': 0, '4c': 0, '6c': 0 };
    for (const size of ['2c', '3c', '4c', '6c'] as CabinSize[]) {
      const totalCabins = fullInventory[week][size];
      for (let c = 0; c < totalCabins; c++) {
        if (rng() < reservationRate) {
          openings[week][size]++;
          totalCancellations++;
        }
      }
    }
  }

  // Step 2: Waitlisted families compete for openings in rank order (with jitter)
  const assignments = new Map<number, { week: number; size: CabinSize }>();

  const jittered = waitlist.map((f) => ({
    family: f,
    sortKey: f.rank === protectedRank
      ? f.rank
      : f.rank + (rng() * 2 - 1) * RANK_JITTER,
  }));
  jittered.sort((a, b) => a.sortKey - b.sortKey);

  for (const { family } of jittered) {
    for (const choice of family.preferences) {
      if (openings[choice.week]?.[choice.size] > 0) {
        // Opening available — waitlisted family gets emailed an offer.
        // Protected family (the user) always accepts.
        // Other waitlisted families: may lapse (fixed) or flake (higher for later weeks).
        const weekDropout = WAITLIST_LAPSE_RATE + waitlistFlakeRate(choice.week);
        if (family.rank !== protectedRank && rng() < weekDropout) {
          break; // Didn't respond or declined — opening goes to next person
        }
        openings[choice.week][choice.size]--;
        assignments.set(family.rank, { week: choice.week, size: choice.size });
        break;
      }
    }
  }

  return { assignments, totalCancellations };
}

// --- Deterministic simulation (no cancellations, for baseline comparison) ---

export function simulate(waitlist: Family[]): SimulationResult[] {
  // In the deterministic view, we estimate expected cancellations as the "openings"
  const expectedRate = RESERVATION_CANCEL_RATE;
  const openings: Inventory = {};
  for (let week = 1; week <= TOTAL_WEEKS; week++) {
    openings[week] = {} as Record<CabinSize, number>;
    for (const size of ['2c', '3c', '4c', '6c'] as CabinSize[]) {
      openings[week][size] = Math.round(INVENTORY_PER_WEEK[size] * expectedRate);
    }
  }

  return waitlist.map((family) => {
    for (const choice of family.preferences) {
      if (openings[choice.week]?.[choice.size] > 0) {
        openings[choice.week][choice.size]--;
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

// --- Monte Carlo ---

export function monteCarloForFamily(
  rank: number,
  waitlist: Family[],
  runs = MONTE_CARLO_RUNS,
  reservationRate = RESERVATION_CANCEL_RATE,
): MonteCarloSummary {
  let successes = 0;
  const weekCounts: Record<number, number> = {};
  const sizeCounts: Record<string, number> = {};
  const rng = createRng(rank * 7919 + 42);

  const myFamily = waitlist.find((f) => f.rank === rank);
  const myPrefs = myFamily?.preferences ?? [];
  const myWeekSizes = new Set(myPrefs.map((p) => `${p.week}:${p.size}`));

  const competitors = waitlist.filter(
    (f) => f.rank < rank && f.preferences.some((p) => myWeekSizes.has(`${p.week}:${p.size}`)),
  );
  const competitorRanks = new Set(competitors.map((f) => f.rank));

  let totalAbsorbed = 0;
  let totalCancellationsSum = 0;

  for (let i = 0; i < runs; i++) {
    const { assignments, totalCancellations } = simulateOnce(waitlist, reservationRate, rng, rank);
    totalCancellationsSum += totalCancellations;
    const result = assignments.get(rank);

    if (result) {
      successes++;
      weekCounts[result.week] = (weekCounts[result.week] || 0) + 1;
      sizeCounts[result.size] = (sizeCounts[result.size] || 0) + 1;
    }

    let absorbed = 0;
    for (const compRank of competitorRanks) {
      const compAssignment = assignments.get(compRank);
      if (compAssignment && !myWeekSizes.has(`${compAssignment.week}:${compAssignment.size}`)) {
        absorbed++;
      }
    }
    totalAbsorbed += absorbed;
  }

  const probability = Math.round((successes / runs) * 100);

  let mostLikelyWeek: number | undefined;
  let mostLikelySize: CabinSize | undefined;
  let maxWeekCount = 0;
  let maxSizeCount = 0;

  for (const [week, count] of Object.entries(weekCounts)) {
    if (count > maxWeekCount) { maxWeekCount = count; mostLikelyWeek = Number(week); }
  }
  for (const [size, count] of Object.entries(sizeCounts)) {
    if (count > maxSizeCount) { maxSizeCount = count; mostLikelySize = size as CabinSize; }
  }

  // Per-week independent probability
  const weekIndependentProbability: Record<number, number> = {};
  const uniqueWeeks = [...new Set(myPrefs.map((p) => p.week))];
  const indyRuns = Math.min(runs, 500);

  for (const targetWeek of uniqueWeeks) {
    const weekOnlyPrefs = myPrefs.filter((p) => p.week === targetWeek);
    const hypotheticalFamily: Family = { rank, preferences: weekOnlyPrefs };
    const hypotheticalWaitlist = waitlist.map((f) => f.rank === rank ? hypotheticalFamily : f);

    const indyRng = createRng(rank * 7919 + targetWeek * 31 + 99);
    let indySuccesses = 0;
    for (let i = 0; i < indyRuns; i++) {
      const { assignments } = simulateOnce(hypotheticalWaitlist, reservationRate, indyRng, rank);
      if (assignments.has(rank)) indySuccesses++;
    }
    weekIndependentProbability[targetWeek] = Math.round((indySuccesses / indyRuns) * 100);
  }

  return {
    runs,
    reservationCancelRate: reservationRate,
    waitlistLapseRate: WAITLIST_LAPSE_RATE,
    waitlistFlakeBase: WAITLIST_FLAKE_BASE,
    waitlistFlakeLate: WAITLIST_FLAKE_LATE,
    probability,
    assignedWeekCounts: weekCounts,
    mostLikelyWeek,
    mostLikelySize,
    avgCancellations: Math.round(totalCancellationsSum / runs),
    avgAbsorbedElsewhere: Math.round(totalAbsorbed / runs),
    weekIndependentProbability,
  };
}

// --- Week breakdown ---

export interface WeekBreakdown {
  week: number;
  size: CabinSize;
  totalCabins: number;
  expectedCancellations: number;
  familiesAhead: number;
  effectiveRank: number;
  netOpenings: number;  // expected cancellations minus families ahead (can be negative)
}

export function computeWeekBreakdown(
  rank: number,
  waitlist: Family[],
): WeekBreakdown[] {
  const family = waitlist.find((f) => f.rank === rank);
  if (!family) return [];

  const combinedRate = RESERVATION_CANCEL_RATE;

  return family.preferences.map((pref) => {
    const familiesAhead = waitlist.filter(
      (f) => f.rank < rank && f.preferences.some((p) => p.week === pref.week && p.size === pref.size),
    ).length;

    const totalCabins = INVENTORY_PER_WEEK[pref.size];
    const expectedCancellations = Math.round(totalCabins * combinedRate * 10) / 10; // 1 decimal
    const netOpenings = Math.round((expectedCancellations - familiesAhead) * 10) / 10;

    return {
      week: pref.week,
      size: pref.size,
      totalCabins,
      expectedCancellations,
      familiesAhead,
      effectiveRank: familiesAhead + 1,
      netOpenings,
    };
  });
}

// --- Cabin demand stats ---

export interface CabinDemand {
  size: CabinSize;
  totalFamilies: number;
  totalCabins: number;
  expectedCancellations: number;
  ratio: number; // families wanting this / expected cancellations
}

export function computeCabinDemand(waitlist: Family[]): CabinDemand[] {
  const counts: Record<CabinSize, Set<number>> = {
    '2c': new Set(), '3c': new Set(), '4c': new Set(), '6c': new Set(),
  };

  for (const family of waitlist) {
    for (const pref of family.preferences) {
      counts[pref.size].add(family.rank);
    }
  }

  const combinedRate = RESERVATION_CANCEL_RATE;

  return (['4c', '6c', '3c', '2c'] as CabinSize[]).map((size) => {
    const totalFamilies = counts[size].size;
    const totalCabins = INVENTORY_PER_WEEK[size] * TOTAL_WEEKS;
    const expectedCancellations = Math.round(totalCabins * combinedRate * 10) / 10;
    return {
      size,
      totalFamilies,
      totalCabins,
      expectedCancellations,
      ratio: expectedCancellations > 0 ? totalFamilies / expectedCancellations : 0,
    };
  });
}

export interface WeekCabinDemand {
  size: CabinSize;
  families: number;
  cabins: number;
  expectedCancellations: number;
  ratio: number;
}

export interface WeekDemand {
  week: number;
  cabinDemand: WeekCabinDemand[];
  totalFamilies: number;
}

export function computeWeekDemand(
  weeks: number[],
  waitlist: Family[],
): WeekDemand[] {
  const combinedRate = RESERVATION_CANCEL_RATE;

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

    const cabinDemand: WeekCabinDemand[] = (['4c', '6c', '3c', '2c'] as CabinSize[]).map((size) => {
      const cabins = INVENTORY_PER_WEEK[size];
      const families = counts[size];
      const expectedCancellations = Math.round(cabins * combinedRate * 10) / 10;
      return { size, families, cabins, expectedCancellations, ratio: expectedCancellations > 0 ? families / expectedCancellations : 0 };
    });

    return { week, cabinDemand, totalFamilies: familiesThisWeek.size };
  });
}
