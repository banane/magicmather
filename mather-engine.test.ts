import { describe, it, expect } from 'vitest';
import { type Family } from './constants';
import {
  buildFullInventory,
  simulate,
  monteCarloForFamily,
  computeWeekBreakdown,
  computeCabinDemand,
  computeWeekDemand,
  reservationCancelRate,
  waitlistFlakeRate,
  RESERVATION_CANCEL_EARLY,
  RESERVATION_CANCEL_LATE,
  WAITLIST_FLAKE_BASE,
  WAITLIST_FLAKE_LATE,
} from './mather-engine';

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
    expect(Object.keys(buildFullInventory())).toHaveLength(11);
  });

  it('each week has correct cabin counts', () => {
    expect(buildFullInventory()[1]).toEqual({ '2c': 9, '3c': 16, '4c': 15, '6c': 28, '6t': 0 });
  });
});

// --- Rate curves ---

describe('rate curves', () => {
  it('reservation cancel rate: week 1 (imminent) is higher than week 11 (far out)', () => {
    expect(reservationCancelRate(1)).toBeGreaterThan(reservationCancelRate(11));
  });

  it('reservation cancel rate stays within bounds', () => {
    for (let w = 1; w <= 11; w++) {
      const r = reservationCancelRate(w);
      expect(r).toBeGreaterThanOrEqual(RESERVATION_CANCEL_EARLY - 0.01);
      expect(r).toBeLessThanOrEqual(RESERVATION_CANCEL_LATE + 0.01);
    }
  });

  it('waitlist flake rate scales up with week number', () => {
    expect(waitlistFlakeRate(1)).toBeCloseTo(WAITLIST_FLAKE_BASE, 2);
    expect(waitlistFlakeRate(11)).toBeCloseTo(WAITLIST_FLAKE_LATE, 2);
    expect(waitlistFlakeRate(6)).toBeGreaterThan(waitlistFlakeRate(1));
  });
});

// --- simulate (temporal deterministic) ---

describe('simulate', () => {
  it('processes weeks in order — early week families resolved first', () => {
    const waitlist = [
      family(1, [{ week: 1, size: '4c' }, { week: 5, size: '4c' }]),
      family(2, [{ week: 5, size: '4c' }]),
    ];
    const results = simulate(waitlist);
    // Family 1 should get week 1 (processed first), leaving week 5 for family 2
    const r1 = results.find((r) => r.rank === 1)!;
    expect(r1.assignedWeek).toBe(1);
  });

  it('returns empty array for empty waitlist', () => {
    expect(simulate([])).toEqual([]);
  });

  it('families compete for limited cancellation openings', () => {
    const waitlist: Family[] = [];
    for (let i = 1; i <= 50; i++) {
      waitlist.push(family(i, [{ week: 3, size: '4c' }]));
    }
    const results = simulate(waitlist);
    const successful = results.filter((r) => r.isSuccessful);
    expect(successful.length).toBeLessThan(20);
    expect(successful.length).toBeGreaterThan(0);
  });
});

// --- monteCarloForFamily (temporal) ---

describe('monteCarloForFamily', () => {
  it('returns deterministic results for the same rank', () => {
    const a = monteCarloForFamily(3, SMALL_WAITLIST, 500);
    const b = monteCarloForFamily(3, SMALL_WAITLIST, 500);
    expect(a.probability).toBe(b.probability);
  });

  it('earlier ranked family has higher probability', () => {
    const waitlist: Family[] = [];
    for (let i = 1; i <= 20; i++) {
      waitlist.push(family(i, [{ week: 3, size: '4c' }]));
    }
    const first = monteCarloForFamily(1, waitlist, 500);
    const last = monteCarloForFamily(20, waitlist, 500);
    expect(first.probability).toBeGreaterThanOrEqual(last.probability);
  });

  it('tracks average cancellations per run', () => {
    const mc = monteCarloForFamily(1, SMALL_WAITLIST, 500);
    expect(mc.avgCancellations).toBeGreaterThan(50);
    expect(mc.avgCancellations).toBeLessThan(250);
  });

  it('tracks families removed before your weeks', () => {
    // Family at rank 50 wanting only week 9 — many families should be resolved by then
    const waitlist: Family[] = [];
    for (let i = 1; i <= 50; i++) {
      waitlist.push(family(i, [
        { week: i <= 30 ? 3 : 9, size: '4c' },
      ]));
    }
    const mc = monteCarloForFamily(50, waitlist, 500);
    expect(mc.avgRemovedBeforeYourWeeks).toBeGreaterThan(0);
  });

  it('family with many options has higher probability', () => {
    const waitlist = [
      ...Array.from({ length: 10 }, (_, i) => family(i + 1, [{ week: 3, size: '4c' }])),
      family(11, [{ week: 3, size: '4c' }]),
      family(12, [{ week: 3, size: '4c' }, { week: 3, size: '3c' }, { week: 5, size: '4c' }, { week: 5, size: '3c' }]),
    ];
    const single = monteCarloForFamily(11, waitlist, 500);
    const multi = monteCarloForFamily(12, waitlist, 500);
    expect(multi.probability).toBeGreaterThanOrEqual(single.probability);
  });

  it('later-week family benefits from earlier weeks clearing competitors', () => {
    // Families 1-10 want week 3 AND week 9. Family 11 only wants week 9.
    // When families 1-10 get week 3, they're off the waitlist — helping family 11 at week 9.
    const waitlist = [
      ...Array.from({ length: 10 }, (_, i) => family(i + 1, [{ week: 3, size: '4c' }, { week: 9, size: '4c' }])),
      family(11, [{ week: 9, size: '4c' }]),
    ];
    const mc = monteCarloForFamily(11, waitlist, 500);
    // Should have decent odds since competitors get resolved at week 3
    expect(mc.probability).toBeGreaterThan(0);
    expect(mc.avgRemovedBeforeYourWeeks).toBeGreaterThan(0);
  });
});

// --- computeWeekBreakdown ---

describe('computeWeekBreakdown', () => {
  it('returns one entry per preference', () => {
    expect(computeWeekBreakdown(3, SMALL_WAITLIST)).toHaveLength(2);
  });

  it('counts families ahead correctly', () => {
    const bd = computeWeekBreakdown(4, SMALL_WAITLIST);
    const week3_4c = bd.find((b) => b.week === 3 && b.size === '4c')!;
    expect(week3_4c.familiesAhead).toBe(2);
  });

  it('expected cancellations vary by week', () => {
    const bd = computeWeekBreakdown(1, [
      family(1, [{ week: 1, size: '4c' }, { week: 11, size: '4c' }]),
    ]);
    const week1 = bd.find((b) => b.week === 1)!;
    const week11 = bd.find((b) => b.week === 11)!;
    // Week 1 (imminent) should have higher cancel rate than week 11 (far out)
    expect(week1.expectedCancellations).toBeGreaterThan(week11.expectedCancellations);
  });

  it('returns empty for unknown rank', () => {
    expect(computeWeekBreakdown(999, SMALL_WAITLIST)).toEqual([]);
  });
});

// --- computeCabinDemand ---

describe('computeCabinDemand', () => {
  it('counts unique families per cabin size', () => {
    const demand = computeCabinDemand(SMALL_WAITLIST);
    expect(demand.find((d) => d.size === '4c')!.totalFamilies).toBe(4);
  });

  it('includes expected cancellations summed across all weeks', () => {
    const demand = computeCabinDemand(SMALL_WAITLIST);
    const d4c = demand.find((d) => d.size === '4c')!;
    expect(d4c.expectedCancellations).toBeGreaterThan(0);
  });

  it('returns all 5 sizes for empty waitlist', () => {
    expect(computeCabinDemand([])).toHaveLength(5);
  });
});

// --- computeWeekDemand ---

describe('computeWeekDemand', () => {
  it('returns demand for requested weeks', () => {
    const demand = computeWeekDemand([3, 5], SMALL_WAITLIST);
    expect(demand).toHaveLength(2);
  });

  it('expected cancellations vary by week', () => {
    const demand = computeWeekDemand([1, 11], [family(1, [{ week: 1, size: '4c' }, { week: 11, size: '4c' }])]);
    const w1 = demand.find((d) => d.week === 1)!.cabinDemand.find((c) => c.size === '4c')!;
    const w11 = demand.find((d) => d.week === 11)!.cabinDemand.find((c) => c.size === '4c')!;
    expect(w1.expectedCancellations).toBeGreaterThan(w11.expectedCancellations);
  });

  it('returns empty for empty weeks', () => {
    expect(computeWeekDemand([], SMALL_WAITLIST)).toEqual([]);
  });
});
