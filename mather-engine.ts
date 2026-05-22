import { type CabinSize, type Family, INVENTORY_PER_WEEK, TOTAL_WEEKS } from './constants';

// --- Simulation config ---

const MONTE_CARLO_RUNS = 2000;

// Reservation holders: cancel rate varies by how far out the week is.
// Right after deposit → low. As the week approaches → higher.
const RESERVATION_CANCEL_EARLY = 0.10; // Weeks far in the future: 10%
const RESERVATION_CANCEL_LATE = 0.30;  // Weeks approaching soon: 30%

function reservationCancelRate(week: number): number {
  // Later weeks are further out when waitlist opens → lower initial cancel rate
  // Earlier weeks are imminent → higher cancel rate sooner
  // Week 1 = most imminent = highest cancel rate, week 11 = furthest = lowest
  const t = Math.max(0, Math.min(1, (TOTAL_WEEKS - week) / (TOTAL_WEEKS - 1)));
  return RESERVATION_CANCEL_EARLY + t * (RESERVATION_CANCEL_LATE - RESERVATION_CANCEL_EARLY);
}

// Waitlisted families: when offered a spot
const WAITLIST_LAPSE_RATE = 0.15; // 15% don't answer the 24h email

// Flake rate scales: early summer families are eager, late summer families have made other plans
const WAITLIST_FLAKE_BASE = 0.05; // Early summer: 5%
const WAITLIST_FLAKE_LATE = 0.25; // Late summer: 25%

function waitlistFlakeRate(week: number): number {
  const t = Math.max(0, Math.min(1, (week - 1) / (TOTAL_WEEKS - 1)));
  return WAITLIST_FLAKE_BASE + t * (WAITLIST_FLAKE_LATE - WAITLIST_FLAKE_BASE);
}

export {
  RESERVATION_CANCEL_EARLY, RESERVATION_CANCEL_LATE, reservationCancelRate,
  WAITLIST_LAPSE_RATE, WAITLIST_FLAKE_BASE, WAITLIST_FLAKE_LATE, waitlistFlakeRate,
  MONTE_CARLO_RUNS,
};

// --- Types ---

export interface SimulationResult extends Family {
  isSuccessful: boolean;
  assignedWeek?: number;
  assignedSize?: CabinSize;
  probability?: number;
}

export interface MonteCarloSummary {
  runs: number;
  probability: number;
  assignedWeekCounts: Record<number, number>;
  mostLikelyWeek?: number;
  mostLikelySize?: CabinSize;
  avgCancellations: number;
  avgAbsorbedElsewhere: number;
  avgRemovedBeforeYourWeeks: number; // families resolved in earlier weeks
  weekIndependentProbability: Record<number, number>;
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

// --- Temporal simulation ---
// Processes weeks in chronological order. For each week:
//   1. Roll cancellations for that week's occupied cabins
//   2. Offer openings to waitlisted families (rank order) who want that week
//   3. Accept or decline → removed from waitlist entirely
//   4. Remaining families carry forward to next week with a shrinking competitor pool

const RANK_JITTER = 15;

function simulateTemporalOnce(
  waitlist: Family[],
  rng: () => number,
  protectedRank?: number,
): {
  assignments: Map<number, { week: number; size: CabinSize }>;
  totalCancellations: number;
  removedBeforeWeek: Record<number, number>; // week -> families removed before this week
} {
  const assignments = new Map<number, { week: number; size: CabinSize }>();
  const resolved = new Set<number>(); // ranks removed from waitlist (accepted or declined)
  let totalCancellations = 0;
  const removedBeforeWeek: Record<number, number> = {};

  for (let week = 1; week <= TOTAL_WEEKS; week++) {
    removedBeforeWeek[week] = resolved.size;

    // Step 1: Roll cancellations for this week's cabins
    const cancelRate = reservationCancelRate(week);
    const openings: Record<CabinSize, number> = { '2c': 0, '3c': 0, '4c': 0, '6c': 0, '6t': 0 };

    for (const size of ['2c', '3c', '4c', '6c', '6t'] as CabinSize[]) {
      for (let c = 0; c < INVENTORY_PER_WEEK[size]; c++) {
        if (rng() < cancelRate) {
          openings[size]++;
          totalCancellations++;
        }
      }
    }

    // Step 2: Find eligible waitlisted families for this week
    // Must: still on waitlist AND requested this week
    const eligible = waitlist
      .filter((f) => !resolved.has(f.rank) && f.preferences.some((p) => p.week === week))
      .map((f) => ({
        family: f,
        sortKey: f.rank === protectedRank
          ? f.rank
          : f.rank + (rng() * 2 - 1) * RANK_JITTER,
      }))
      .sort((a, b) => a.sortKey - b.sortKey);

    // Step 3: Offer openings to eligible families
    for (const { family } of eligible) {
      if (resolved.has(family.rank)) continue; // may have been resolved earlier in this loop

      const weekPrefs = family.preferences.filter((p) => p.week === week);

      for (const pref of weekPrefs) {
        if (openings[pref.size] > 0) {
          // Opening available — email sent to family
          const dropout = WAITLIST_LAPSE_RATE + waitlistFlakeRate(week);

          if (family.rank !== protectedRank && rng() < dropout) {
            // Declined or didn't respond — off the waitlist, opening stays
            resolved.add(family.rank);
            break;
          }

          // Accepted — cabin assigned, off the waitlist
          openings[pref.size]--;
          assignments.set(family.rank, { week, size: pref.size });
          resolved.add(family.rank);
          break;
        }
      }
    }

    // Families whose ALL preferences are for this week or earlier and weren't offered
    // naturally have nothing left — but they stay "on" the waitlist technically.
    // They just won't match any future week. No explicit cleanup needed.
  }

  return { assignments, totalCancellations, removedBeforeWeek };
}

// --- Deterministic simulation ---

export function simulate(waitlist: Family[]): SimulationResult[] {
  const resolved = new Set<number>();
  const results: SimulationResult[] = [];

  // Process week by week with expected cancellations
  const resultMap = new Map<number, SimulationResult>();

  for (let week = 1; week <= TOTAL_WEEKS; week++) {
    const cancelRate = reservationCancelRate(week);
    const openings: Record<CabinSize, number> = { '2c': 0, '3c': 0, '4c': 0, '6c': 0, '6t': 0 };
    for (const size of ['2c', '3c', '4c', '6c', '6t'] as CabinSize[]) {
      openings[size] = Math.round(INVENTORY_PER_WEEK[size] * cancelRate);
    }

    const eligible = waitlist.filter(
      (f) => !resolved.has(f.rank) && f.preferences.some((p) => p.week === week),
    );

    for (const family of eligible) {
      if (resolved.has(family.rank)) continue;
      const weekPrefs = family.preferences.filter((p) => p.week === week);
      for (const pref of weekPrefs) {
        if (openings[pref.size] > 0) {
          openings[pref.size]--;
          resultMap.set(family.rank, {
            ...family, isSuccessful: true, assignedWeek: week, assignedSize: pref.size,
          });
          resolved.add(family.rank);
          break;
        }
      }
    }
  }

  return waitlist.map((f) => resultMap.get(f.rank) ?? { ...f, isSuccessful: false });
}

// --- Monte Carlo ---

export function monteCarloForFamily(
  rank: number,
  waitlist: Family[],
  runs = MONTE_CARLO_RUNS,
): MonteCarloSummary {
  let successes = 0;
  const weekCounts: Record<number, number> = {};
  const sizeCounts: Record<string, number> = {};
  const rng = createRng(rank * 7919 + 42);

  const myFamily = waitlist.find((f) => f.rank === rank);
  const myPrefs = myFamily?.preferences ?? [];
  const myWeekSizes = new Set(myPrefs.map((p) => `${p.week}:${p.size}`));
  const myWeeks = [...new Set(myPrefs.map((p) => p.week))].sort((a, b) => a - b);
  const myEarliestWeek = myWeeks[0] ?? 1;

  const competitors = waitlist.filter(
    (f) => f.rank < rank && f.preferences.some((p) => myWeekSizes.has(`${p.week}:${p.size}`)),
  );
  const competitorRanks = new Set(competitors.map((f) => f.rank));

  let totalAbsorbed = 0;
  let totalCancellationsSum = 0;
  let totalRemovedBefore = 0;

  for (let i = 0; i < runs; i++) {
    const { assignments, totalCancellations, removedBeforeWeek } =
      simulateTemporalOnce(waitlist, rng, rank);
    totalCancellationsSum += totalCancellations;
    totalRemovedBefore += removedBeforeWeek[myEarliestWeek] ?? 0;

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

  // Per-week independent probability (also temporal)
  const weekIndependentProbability: Record<number, number> = {};
  const indyRuns = Math.min(runs, 500);

  for (const targetWeek of myWeeks) {
    const weekOnlyPrefs = myPrefs.filter((p) => p.week === targetWeek);
    const hypotheticalFamily: Family = { rank, preferences: weekOnlyPrefs };
    const hypotheticalWaitlist = waitlist.map((f) => f.rank === rank ? hypotheticalFamily : f);

    const indyRng = createRng(rank * 7919 + targetWeek * 31 + 99);
    let indySuccesses = 0;
    for (let i = 0; i < indyRuns; i++) {
      const { assignments } = simulateTemporalOnce(hypotheticalWaitlist, indyRng, rank);
      if (assignments.has(rank)) indySuccesses++;
    }
    weekIndependentProbability[targetWeek] = Math.round((indySuccesses / indyRuns) * 100);
  }

  return {
    runs,
    probability,
    assignedWeekCounts: weekCounts,
    mostLikelyWeek,
    mostLikelySize,
    avgCancellations: Math.round(totalCancellationsSum / runs),
    avgAbsorbedElsewhere: Math.round(totalAbsorbed / runs),
    avgRemovedBeforeYourWeeks: Math.round(totalRemovedBefore / runs),
    weekIndependentProbability,
  };
}

// --- Week breakdown ---

export interface CompetitorSpread {
  total: number;           // families ahead wanting this week+size
  onlyThisWeek: number;    // of those, families who ONLY want this week (stuck here)
  haveEarlierWeeks: number; // of those, also want earlier weeks (likely resolved before you)
  haveLaterWeeks: number;  // of those, also want later weeks
  avgOptions: number;      // avg total options per competitor (higher = more likely to get absorbed)
}

export interface WeekBreakdown {
  week: number;
  size: CabinSize;
  totalCabins: number;
  expectedCancellations: number;
  familiesAhead: number;
  effectiveRank: number;
  netOpenings: number;
  spread: CompetitorSpread;
}

export function computeWeekBreakdown(
  rank: number,
  waitlist: Family[],
): WeekBreakdown[] {
  const family = waitlist.find((f) => f.rank === rank);
  if (!family) return [];

  return family.preferences.map((pref) => {
    const competitors = waitlist.filter(
      (f) => f.rank < rank && f.preferences.some((p) => p.week === pref.week && p.size === pref.size),
    );

    const familiesAhead = competitors.length;

    // Analyze how spread out the competitors are
    let onlyThisWeek = 0;
    let haveEarlierWeeks = 0;
    let haveLaterWeeks = 0;
    let totalOptions = 0;

    for (const comp of competitors) {
      const compWeeks = [...new Set(comp.preferences.map((p) => p.week))];
      totalOptions += comp.preferences.length;

      if (compWeeks.length === 1 && compWeeks[0] === pref.week) {
        onlyThisWeek++;
      }
      if (compWeeks.some((w) => w < pref.week)) {
        haveEarlierWeeks++;
      }
      if (compWeeks.some((w) => w > pref.week)) {
        haveLaterWeeks++;
      }
    }

    const totalCabins = INVENTORY_PER_WEEK[pref.size];
    const cancelRate = reservationCancelRate(pref.week);
    const expectedCancellations = Math.round(totalCabins * cancelRate * 10) / 10;
    const netOpenings = Math.round((expectedCancellations - familiesAhead) * 10) / 10;

    return {
      week: pref.week,
      size: pref.size,
      totalCabins,
      expectedCancellations,
      familiesAhead,
      effectiveRank: familiesAhead + 1,
      netOpenings,
      spread: {
        total: familiesAhead,
        onlyThisWeek,
        haveEarlierWeeks,
        haveLaterWeeks,
        avgOptions: familiesAhead > 0 ? Math.round((totalOptions / familiesAhead) * 10) / 10 : 0,
      },
    };
  });
}

// --- Cabin demand stats ---

export interface CabinDemand {
  size: CabinSize;
  totalFamilies: number;
  totalCabins: number;
  expectedCancellations: number;
  ratio: number;
}

export function computeCabinDemand(waitlist: Family[]): CabinDemand[] {
  const counts: Record<CabinSize, Set<number>> = {
    '2c': new Set(), '3c': new Set(), '4c': new Set(), '6c': new Set(), '6t': new Set(),
  };

  for (const family of waitlist) {
    for (const pref of family.preferences) {
      counts[pref.size].add(family.rank);
    }
  }

  return (['4c', '6c', '3c', '2c', '6t'] as CabinSize[]).map((size) => {
    const totalFamilies = counts[size].size;
    const totalCabins = INVENTORY_PER_WEEK[size] * TOTAL_WEEKS;
    // Sum expected cancellations across all weeks (rate varies per week)
    let expectedCancellations = 0;
    for (let w = 1; w <= TOTAL_WEEKS; w++) {
      expectedCancellations += INVENTORY_PER_WEEK[size] * reservationCancelRate(w);
    }
    expectedCancellations = Math.round(expectedCancellations * 10) / 10;
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
  return weeks.map((week) => {
    const familiesThisWeek = new Set<number>();
    const counts: Record<CabinSize, number> = { '2c': 0, '3c': 0, '4c': 0, '6c': 0, '6t': 0 };

    for (const family of waitlist) {
      for (const pref of family.preferences) {
        if (pref.week === week) {
          counts[pref.size]++;
          familiesThisWeek.add(family.rank);
        }
      }
    }

    const cancelRate = reservationCancelRate(week);
    const cabinDemand: WeekCabinDemand[] = (['4c', '6c', '3c', '2c'] as CabinSize[]).map((size) => {
      const cabins = INVENTORY_PER_WEEK[size];
      const families = counts[size];
      const expectedCancellations = Math.round(cabins * cancelRate * 10) / 10;
      return { size, families, cabins, expectedCancellations, ratio: expectedCancellations > 0 ? families / expectedCancellations : 0 };
    });

    return { week, cabinDemand, totalFamilies: familiesThisWeek.size };
  });
}

// Re-export for convenience
export function buildFullInventory() {
  const inventory: Record<number, Record<CabinSize, number>> = {};
  for (let week = 1; week <= TOTAL_WEEKS; week++) {
    inventory[week] = { ...INVENTORY_PER_WEEK };
  }
  return inventory;
}
