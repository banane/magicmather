import { describe, it, expect } from 'vitest';
import { type Family } from './constants';
import {
  buildFullInventory,
  simulate,
  monteCarloForFamily,
  computeWeekBreakdown,
  computeCabinDemand,
  computeWeekDemand,
  RESERVATION_CANCEL_RATE,
  WAITLIST_LAPSE_RATE,
  WAITLIST_FLAKE_BASE,
  WAITLIST_FLAKE_LATE,
  waitlistFlakeRate,
} from './mather-engine';

// --- Test fixtures ---

function family(rank: number, prefs: { week: number; size: '2c' | '3c' | '4c' | '6c' }[]): Family {
  return { rank, preferences: prefs };
}

const SMALL_WAITLIST: Family[] = [
  family(1, [{ week: 3, size: '4c' }, { week: 4, size: '4c' }]),
  family(2, [{ week: 3, size: '4c' }]),
  family(3, [{ week: 3, size: '6c' }, { week: 5, size: '4c' }]),
  family(4, [{ week: 3, size: '4c' }, { week: 3, size: '6c' }]),
  family(5, [{ week: 5, size: '2c' }]),
];

// --- buildFullInventory ---

describe('buildFullInventory', () => {
  it('creates inventory for all 11 weeks', () => {
    const inv = buildFullInventory();
    expect(Object.keys(inv)).toHaveLength(11);
  });

  it('each week has correct cabin counts', () => {
    const inv = buildFullInventory();
    expect(inv[1]).toEqual({ '2c': 9, '3c': 16, '4c': 15, '6c': 28 });
  });

  it('weeks are independent', () => {
    const inv = buildFullInventory();
    inv[1]['4c'] = 0;
    expect(inv[2]['4c']).toBe(15);
  });
});

// --- simulate (deterministic with expected cancellations) ---

describe('simulate', () => {
  it('assigns families in rank order', () => {
    const results = simulate(SMALL_WAITLIST);
    expect(results[0].rank).toBe(1);
    expect(results[4].rank).toBe(5);
  });

  it('low-ranked families can succeed when expected cancellations exist', () => {
    // With 13% combined rate, 4c has ~2 expected cancellations per week
    const results = simulate(SMALL_WAITLIST);
    const rank1 = results.find((r) => r.rank === 1)!;
    expect(rank1.isSuccessful).toBe(true);
  });

  it('returns empty array for empty waitlist', () => {
    expect(simulate([])).toEqual([]);
  });

  it('families compete for limited cancellation openings', () => {
    // Many families wanting same week+size — only expected cancellations available
    const waitlist: Family[] = [];
    for (let i = 1; i <= 50; i++) {
      waitlist.push(family(i, [{ week: 3, size: '4c' }]));
    }
    const results = simulate(waitlist);
    const successful = results.filter((r) => r.isSuccessful);
    const failed = results.filter((r) => !r.isSuccessful);
    // ~2 expected cancellations for 15 4c cabins at 13%
    expect(successful.length).toBeLessThan(10);
    expect(failed.length).toBeGreaterThan(40);
  });
});

// --- monteCarloForFamily ---

describe('monteCarloForFamily', () => {
  it('returns deterministic results for the same rank (seeded PRNG)', () => {
    const a = monteCarloForFamily(3, SMALL_WAITLIST, 500);
    const b = monteCarloForFamily(3, SMALL_WAITLIST, 500);
    expect(a.probability).toBe(b.probability);
  });

  it('first-ranked family has higher probability than last-ranked', () => {
    const waitlist: Family[] = [];
    for (let i = 1; i <= 20; i++) {
      waitlist.push(family(i, [{ week: 3, size: '4c' }]));
    }
    const first = monteCarloForFamily(1, waitlist, 500);
    const last = monteCarloForFamily(20, waitlist, 500);
    expect(first.probability).toBeGreaterThanOrEqual(last.probability);
  });

  it('higher cancel rate increases probability for later families', () => {
    // Small waitlist — rank 3 competing for 4c with 2 families ahead
    const waitlist = [
      family(1, [{ week: 3, size: '4c' }]),
      family(2, [{ week: 3, size: '4c' }]),
      family(3, [{ week: 3, size: '4c' }]),
    ];
    const low = monteCarloForFamily(3, waitlist, 500, 0.02);
    const high = monteCarloForFamily(3, waitlist, 500, 0.40);
    expect(high.probability).toBeGreaterThanOrEqual(low.probability);
  });

  it('tracks average cancellations per run', () => {
    const mc = monteCarloForFamily(1, SMALL_WAITLIST, 500);
    // With 20% cancel rate across 748 total cabins, expect ~150 cancellations
    expect(mc.avgCancellations).toBeGreaterThan(100);
    expect(mc.avgCancellations).toBeLessThan(200);
  });

  it('reports correct rates', () => {
    const mc = monteCarloForFamily(3, SMALL_WAITLIST, 100);
    expect(mc.reservationCancelRate).toBe(RESERVATION_CANCEL_RATE);
    expect(mc.waitlistLapseRate).toBe(WAITLIST_LAPSE_RATE);
    expect(mc.waitlistFlakeBase).toBe(WAITLIST_FLAKE_BASE);
    expect(mc.waitlistFlakeLate).toBe(WAITLIST_FLAKE_LATE);
    expect(mc.runs).toBe(100);
  });

  it('waitlist flake rate scales with week number', () => {
    const week1 = waitlistFlakeRate(1);
    const week6 = waitlistFlakeRate(6);
    const week11 = waitlistFlakeRate(11);
    expect(week1).toBeCloseTo(WAITLIST_FLAKE_BASE, 2);
    expect(week11).toBeCloseTo(WAITLIST_FLAKE_LATE, 2);
    expect(week6).toBeGreaterThan(week1);
    expect(week6).toBeLessThan(week11);
  });

  it('returns 0 probability for a rank not in the waitlist', () => {
    const mc = monteCarloForFamily(999, SMALL_WAITLIST, 500, 0);
    expect(mc.probability).toBe(0);
  });

  it('family with many options has higher probability than one with few', () => {
    const waitlist = [
      ...Array.from({ length: 10 }, (_, i) => family(i + 1, [{ week: 3, size: '4c' }])),
      family(11, [{ week: 3, size: '4c' }]), // single option
      family(12, [{ week: 3, size: '4c' }, { week: 3, size: '3c' }, { week: 5, size: '4c' }, { week: 5, size: '3c' }]), // many options
    ];
    const single = monteCarloForFamily(11, waitlist, 500);
    const multi = monteCarloForFamily(12, waitlist, 500);
    expect(multi.probability).toBeGreaterThanOrEqual(single.probability);
  });
});

// --- computeWeekBreakdown ---

describe('computeWeekBreakdown', () => {
  it('returns one entry per preference', () => {
    const bd = computeWeekBreakdown(3, SMALL_WAITLIST);
    expect(bd).toHaveLength(2);
  });

  it('counts only families ahead with the same week+size', () => {
    const bd = computeWeekBreakdown(4, SMALL_WAITLIST);
    const week3_4c = bd.find((b) => b.week === 3 && b.size === '4c')!;
    expect(week3_4c.familiesAhead).toBe(2); // families 1 and 2
    expect(week3_4c.effectiveRank).toBe(3);
  });

  it('includes expected cancellations and total cabins', () => {
    const bd = computeWeekBreakdown(2, SMALL_WAITLIST);
    const week3 = bd.find((b) => b.week === 3)!;
    expect(week3.totalCabins).toBe(15); // 4c = 15 cabins
    expect(week3.expectedCancellations).toBeGreaterThan(0);
  });

  it('calculates net openings (cancellations minus families ahead)', () => {
    const bd = computeWeekBreakdown(1, SMALL_WAITLIST);
    const week3 = bd.find((b) => b.week === 3)!;
    // Rank 1 has 0 families ahead, so net openings = expected cancellations
    expect(week3.netOpenings).toBe(week3.expectedCancellations);
  });

  it('returns empty for unknown rank', () => {
    expect(computeWeekBreakdown(999, SMALL_WAITLIST)).toEqual([]);
  });
});

// --- computeCabinDemand ---

describe('computeCabinDemand', () => {
  it('counts unique families per cabin size', () => {
    const demand = computeCabinDemand(SMALL_WAITLIST);
    const d4c = demand.find((d) => d.size === '4c')!;
    expect(d4c.totalFamilies).toBe(4); // families 1, 2, 3, 4
  });

  it('does not double-count a family requesting the same size in multiple weeks', () => {
    const waitlist = [family(1, [{ week: 3, size: '4c' }, { week: 5, size: '4c' }, { week: 7, size: '4c' }])];
    const demand = computeCabinDemand(waitlist);
    expect(demand.find((d) => d.size === '4c')!.totalFamilies).toBe(1);
  });

  it('includes expected cancellations', () => {
    const demand = computeCabinDemand(SMALL_WAITLIST);
    const d4c = demand.find((d) => d.size === '4c')!;
    expect(d4c.expectedCancellations).toBeGreaterThan(0);
    expect(d4c.totalCabins).toBe(15 * 11); // 15 per week * 11 weeks
  });

  it('returns all 4 cabin sizes even with empty waitlist', () => {
    const demand = computeCabinDemand([]);
    expect(demand).toHaveLength(4);
    demand.forEach((d) => expect(d.totalFamilies).toBe(0));
  });
});

// --- computeWeekDemand ---

describe('computeWeekDemand', () => {
  it('returns demand for requested weeks only', () => {
    const demand = computeWeekDemand([3, 5], SMALL_WAITLIST);
    expect(demand).toHaveLength(2);
    expect(demand[0].week).toBe(3);
    expect(demand[1].week).toBe(5);
  });

  it('counts families requesting each cabin type for a specific week', () => {
    const demand = computeWeekDemand([3], SMALL_WAITLIST);
    const week3 = demand[0];
    const c4c = week3.cabinDemand.find((c) => c.size === '4c')!;
    const c6c = week3.cabinDemand.find((c) => c.size === '6c')!;
    expect(c4c.families).toBe(3); // families 1, 2, 4
    expect(c6c.families).toBe(2); // families 3, 4
  });

  it('includes expected cancellations per cabin type', () => {
    const demand = computeWeekDemand([3], SMALL_WAITLIST);
    const c4c = demand[0].cabinDemand.find((c) => c.size === '4c')!;
    expect(c4c.cabins).toBe(15);
    expect(c4c.expectedCancellations).toBeGreaterThan(0);
  });

  it('returns empty array for empty weeks input', () => {
    expect(computeWeekDemand([], SMALL_WAITLIST)).toEqual([]);
  });
});
