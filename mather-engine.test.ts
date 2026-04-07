import { describe, it, expect } from 'vitest';
import { type Family } from './constants';
import {
  buildInventory,
  simulate,
  monteCarloForFamily,
  computeWeekBreakdown,
  computeCabinDemand,
  computeWeekDemand,
  FLAKE_RATE,
  TIMEOUT_RATE,
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

// --- buildInventory ---

describe('buildInventory', () => {
  it('creates inventory for all 11 weeks', () => {
    const inv = buildInventory();
    expect(Object.keys(inv)).toHaveLength(11);
  });

  it('each week has correct slot counts', () => {
    const inv = buildInventory();
    expect(inv[1]).toEqual({ '2c': 9, '3c': 16, '4c': 15, '6c': 28 });
    expect(inv[11]).toEqual({ '2c': 9, '3c': 16, '4c': 15, '6c': 28 });
  });

  it('weeks are independent (mutating one does not affect another)', () => {
    const inv = buildInventory();
    inv[1]['4c'] = 0;
    expect(inv[2]['4c']).toBe(15);
  });
});

// --- simulate (deterministic) ---

describe('simulate', () => {
  it('assigns families in rank order', () => {
    const results = simulate(SMALL_WAITLIST);
    expect(results[0].rank).toBe(1);
    expect(results[4].rank).toBe(5);
  });

  it('assigns first available preference', () => {
    const results = simulate(SMALL_WAITLIST);
    const rank1 = results.find((r) => r.rank === 1)!;
    expect(rank1.isSuccessful).toBe(true);
    expect(rank1.assignedWeek).toBe(3);
    expect(rank1.assignedSize).toBe('4c');
  });

  it('depletes inventory correctly', () => {
    // Fill all 15 4c slots in week 3
    const waitlist: Family[] = [];
    for (let i = 1; i <= 20; i++) {
      waitlist.push(family(i, [{ week: 3, size: '4c' }]));
    }
    const results = simulate(waitlist);

    const successful = results.filter((r) => r.isSuccessful);
    const failed = results.filter((r) => !r.isSuccessful);
    expect(successful).toHaveLength(15);
    expect(failed).toHaveLength(5);
  });

  it('falls back to second preference when first is full', () => {
    const waitlist: Family[] = [];
    // Fill all 9 2c slots in week 1
    for (let i = 1; i <= 9; i++) {
      waitlist.push(family(i, [{ week: 1, size: '2c' }]));
    }
    // Family 10 wants week 1 2c, then week 2 2c
    waitlist.push(family(10, [{ week: 1, size: '2c' }, { week: 2, size: '2c' }]));

    const results = simulate(waitlist);
    const rank10 = results.find((r) => r.rank === 10)!;
    expect(rank10.isSuccessful).toBe(true);
    expect(rank10.assignedWeek).toBe(2);
  });

  it('returns unsuccessful when no preferences have availability', () => {
    const waitlist: Family[] = [];
    for (let i = 1; i <= 10; i++) {
      waitlist.push(family(i, [{ week: 1, size: '2c' }]));
    }
    const results = simulate(waitlist);
    const rank10 = results.find((r) => r.rank === 10)!;
    expect(rank10.isSuccessful).toBe(false);
    expect(rank10.assignedWeek).toBeUndefined();
  });

  it('returns empty array for empty waitlist', () => {
    expect(simulate([])).toEqual([]);
  });

  it('family consuming one week does not block their other preferences for other families', () => {
    const waitlist: Family[] = [
      family(1, [{ week: 3, size: '4c' }, { week: 5, size: '4c' }]),
      family(2, [{ week: 5, size: '4c' }]),
    ];
    const results = simulate(waitlist);
    // Family 1 takes week 3, so week 5 is still open for family 2
    expect(results.find((r) => r.rank === 1)!.assignedWeek).toBe(3);
    expect(results.find((r) => r.rank === 2)!.assignedWeek).toBe(5);
  });
});

// --- monteCarloForFamily ---

describe('monteCarloForFamily', () => {
  it('returns deterministic results for the same rank (seeded PRNG)', () => {
    const a = monteCarloForFamily(3, SMALL_WAITLIST, 500);
    const b = monteCarloForFamily(3, SMALL_WAITLIST, 500);
    expect(a.probability).toBe(b.probability);
    expect(a.avgAbsorbedElsewhere).toBe(b.avgAbsorbedElsewhere);
    expect(a.avgDropouts).toBe(b.avgDropouts);
  });

  it('first-ranked family always succeeds (queried family never drops out)', () => {
    const mc = monteCarloForFamily(1, SMALL_WAITLIST, 1000);
    expect(mc.probability).toBe(100);
  });

  it('family with no competition gets 100% when not dropped', () => {
    const waitlist = [family(1, [{ week: 5, size: '2c' }])];
    const mc = monteCarloForFamily(1, waitlist, 1000, 0, 0);
    expect(mc.probability).toBe(100);
  });

  it('with 0% dropout, family well beyond capacity has ~0% chance', () => {
    // 30 families competing for 15 4c week-3 slots, rank 30 is far from the cutoff
    const waitlist: Family[] = [];
    for (let i = 1; i <= 30; i++) {
      waitlist.push(family(i, [{ week: 3, size: '4c' }]));
    }
    const mc = monteCarloForFamily(30, waitlist, 500, 0, 0);
    // Even with rank jitter (+/- 15), rank 30 rarely gets into the top 15
    expect(mc.probability).toBeLessThanOrEqual(5);
  });

  it('higher dropout rate increases probability for later families', () => {
    const waitlist: Family[] = [];
    for (let i = 1; i <= 20; i++) {
      waitlist.push(family(i, [{ week: 3, size: '4c' }]));
    }
    const lowDrop = monteCarloForFamily(18, waitlist, 1000, 0.05, 0.05);
    const highDrop = monteCarloForFamily(18, waitlist, 1000, 0.15, 0.20);
    expect(highDrop.probability).toBeGreaterThan(lowDrop.probability);
  });

  it('tracks absorbed and dropout counts', () => {
    // Use a larger waitlist so dropout averages are non-zero even at low rates
    const waitlist: Family[] = [];
    for (let i = 1; i <= 50; i++) {
      waitlist.push(family(i, [{ week: 3, size: '4c' }, { week: 5, size: '6c' }]));
    }
    const mc = monteCarloForFamily(50, waitlist, 1000);
    expect(mc.avgAbsorbedElsewhere + mc.avgDropouts).toBeGreaterThan(0);
  });

  it('reports correct flakeRate and timeoutRate', () => {
    const mc = monteCarloForFamily(3, SMALL_WAITLIST, 100);
    expect(mc.flakeRate).toBe(FLAKE_RATE);
    expect(mc.timeoutRate).toBe(TIMEOUT_RATE);
    expect(mc.runs).toBe(100);
  });

  it('mostLikelyWeek is the most frequently assigned week', () => {
    const waitlist = [
      family(1, [{ week: 3, size: '4c' }]),
      family(2, [{ week: 3, size: '4c' }, { week: 7, size: '4c' }]),
    ];
    const mc = monteCarloForFamily(2, waitlist, 1000, 0, 0);
    // Family 2 always gets week 3 (plenty of slots), so that's the most likely
    expect(mc.mostLikelyWeek).toBe(3);
  });

  it('returns 0 probability for a rank not in the waitlist', () => {
    const mc = monteCarloForFamily(999, SMALL_WAITLIST, 500, 0, 0);
    expect(mc.probability).toBe(0);
  });
});

// --- computeWeekBreakdown ---

describe('computeWeekBreakdown', () => {
  it('returns one entry per preference', () => {
    const bd = computeWeekBreakdown(3, SMALL_WAITLIST);
    // Family 3 has 2 preferences
    expect(bd).toHaveLength(2);
  });

  it('counts only families ahead with the same week+size', () => {
    const bd = computeWeekBreakdown(4, SMALL_WAITLIST);
    // Family 4 wants week 3 4c: families 1 and 2 also want week 3 4c
    const week3_4c = bd.find((b) => b.week === 3 && b.size === '4c')!;
    expect(week3_4c.familiesAhead).toBe(2);
    expect(week3_4c.effectiveRank).toBe(3);
  });

  it('calculates slotsRemaining correctly', () => {
    const bd = computeWeekBreakdown(2, SMALL_WAITLIST);
    const week3 = bd.find((b) => b.week === 3)!;
    // 15 4c slots, 1 family ahead (rank 1) = 14 remaining
    expect(week3.totalSlots).toBe(15);
    expect(week3.slotsRemaining).toBe(14);
    expect(week3.likely).toBe(true);
  });

  it('returns empty for unknown rank', () => {
    expect(computeWeekBreakdown(999, SMALL_WAITLIST)).toEqual([]);
  });

  it('slotsRemaining never goes below 0', () => {
    const waitlist: Family[] = [];
    for (let i = 1; i <= 20; i++) {
      waitlist.push(family(i, [{ week: 1, size: '2c' }]));
    }
    const bd = computeWeekBreakdown(20, waitlist);
    expect(bd[0].slotsRemaining).toBe(0);
    expect(bd[0].likely).toBe(false);
  });
});

// --- computeCabinDemand ---

describe('computeCabinDemand', () => {
  it('counts unique families per cabin size', () => {
    const demand = computeCabinDemand(SMALL_WAITLIST);
    const d4c = demand.find((d) => d.size === '4c')!;
    // Families 1, 2, 3, 4 want 4c
    expect(d4c.totalFamilies).toBe(4);
  });

  it('does not double-count a family requesting the same size in multiple weeks', () => {
    const waitlist = [
      family(1, [{ week: 3, size: '4c' }, { week: 5, size: '4c' }, { week: 7, size: '4c' }]),
    ];
    const demand = computeCabinDemand(waitlist);
    expect(demand.find((d) => d.size === '4c')!.totalFamilies).toBe(1);
  });

  it('computes ratio as families / (slots * weeks)', () => {
    const demand = computeCabinDemand(SMALL_WAITLIST);
    const d2c = demand.find((d) => d.size === '2c')!;
    // 1 family wants 2c, total slots = 9 * 11 = 99
    expect(d2c.totalFamilies).toBe(1);
    expect(d2c.totalSlots).toBe(99);
    expect(d2c.ratio).toBeCloseTo(1 / 99, 4);
  });

  it('returns all 4 cabin sizes even with empty waitlist', () => {
    const demand = computeCabinDemand([]);
    expect(demand).toHaveLength(4);
    demand.forEach((d) => {
      expect(d.totalFamilies).toBe(0);
      expect(d.ratio).toBe(0);
    });
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
    const c4c = week3.cabins.find((c) => c.size === '4c')!;
    const c6c = week3.cabins.find((c) => c.size === '6c')!;
    // Week 3 4c: families 1, 2, 4 = 3
    expect(c4c.families).toBe(3);
    // Week 3 6c: families 3, 4 = 2
    expect(c6c.families).toBe(2);
  });

  it('counts total unique families for a week', () => {
    const demand = computeWeekDemand([3], SMALL_WAITLIST);
    // Families 1, 2, 3, 4 all have week 3 preferences
    expect(demand[0].totalFamilies).toBe(4);
  });

  it('returns empty cabins for weeks nobody wants', () => {
    const demand = computeWeekDemand([11], SMALL_WAITLIST);
    expect(demand[0].totalFamilies).toBe(0);
    demand[0].cabins.forEach((c) => {
      expect(c.families).toBe(0);
    });
  });

  it('returns empty array for empty weeks input', () => {
    expect(computeWeekDemand([], SMALL_WAITLIST)).toEqual([]);
  });
});
