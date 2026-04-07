import { useState, useMemo } from 'react';
import {
  simulate,
  computeWeekBreakdown,
  computeCabinDemand,
  computeWeekDemand,
  monteCarloForFamily,
  FLAKE_RATE,
  TIMEOUT_RATE,
  MONTE_CARLO_RUNS,
  type SimulationResult,
  type WeekBreakdown,
  type MonteCarloSummary,
} from '../mather-engine';
import { type Family, INVENTORY_PER_WEEK } from '../constants';
import waitlistData from '../public/data.json';

const WEEK_LABELS: Record<number, string> = {
  1: 'May 31–Jun 3',
  2: 'Jun 3–6',
  3: 'Jun 7–13',
  4: 'Jun 14–20',
  5: 'Jun 21–27',
  6: 'Jun 28–Jul 4',
  7: 'Jul 5–11',
  8: 'Jul 12–18',
  9: 'Jul 19–25',
  10: 'Jul 26–Aug 1',
  11: 'Aug 2–8',
  12: 'Aug 9–15',
};

const WEEK_END_DATES: Record<number, string> = {
  1: '6/3', 2: '6/6', 3: '6/13', 4: '6/20', 5: '6/27', 6: '7/4',
  7: '7/11', 8: '7/18', 9: '7/25', 10: '8/1', 11: '8/8', 12: '8/15',
};

function weekLabel(week: number): string {
  return WEEK_LABELS[week] ?? `Week ${week}`;
}

function probabilityColor(p: number): string {
  if (p >= 75) return 'text-green-700';
  if (p >= 40) return 'text-yellow-600';
  return 'text-red-600';
}

function probabilityBg(p: number): string {
  if (p >= 75) return 'bg-green-50 border-green-200';
  if (p >= 40) return 'bg-yellow-50 border-yellow-200';
  return 'bg-orange-50 border-orange-200';
}

function buildAnalysis(
  breakdown: WeekBreakdown[],
  mc: MonteCarloSummary,
  status: SimulationResult,
  waitlist: Family[],
): string {
  if (!breakdown.length) return '';

  const familiesAhead = waitlist.filter((f) => f.rank < status.rank);
  const avgPrefs =
    familiesAhead.length > 0
      ? familiesAhead.reduce((sum, f) => sum + f.preferences.length, 0) /
        familiesAhead.length
      : 0;

  const mySizes = [...new Set(breakdown.map((b) => b.size))];
  const mySizeLabel = mySizes.join(', ');

  const competingFamilies = new Set<number>();
  for (const b of breakdown) {
    for (const f of waitlist) {
      if (
        f.rank < status.rank &&
        f.preferences.some((p) => p.week === b.week && p.size === b.size)
      ) {
        competingFamilies.add(f.rank);
      }
    }
  }
  const totalCompeting = competingFamilies.size;

  const dropRate = FLAKE_RATE + TIMEOUT_RATE;
  const estimatedDropouts = Math.round(totalCompeting * dropRate);

  const bestWeek = [...breakdown].sort(
    (a, b) => a.effectiveRank - b.effectiveRank,
  )[0];

  const latestWeekEnd =
    WEEK_END_DATES[Math.max(...breakdown.map((b) => b.week))] ?? '';

  const lines: string[] = [];

  lines.push(
    `We ran ${mc.runs.toLocaleString()} simulations where each family ahead of you has a ${Math.round(FLAKE_RATE * 100)}% chance of declining their offer and a ${Math.round(TIMEOUT_RATE * 100)}% chance of letting the 24-hour decision window lapse (${Math.round(dropRate * 100)}% combined dropout rate per family).`,
  );

  lines.push(
    `There are ${totalCompeting} families ahead of you competing for ${mySizeLabel} cabins across your ${breakdown.length} week${breakdown.length > 1 ? 's' : ''}. On average, each family ahead of you has ${avgPrefs.toFixed(1)} week preferences — when any of them accept a cabin, they're removed from all other weeks.`,
  );

  lines.push(
    `With the ${Math.round(dropRate * 100)}% dropout rate, roughly ${estimatedDropouts} of those ${totalCompeting} families drop out in each simulation run, freeing up slots.`,
  );

  lines.push(
    `Your best week is ${weekLabel(bestWeek.week)} (effectively #${bestWeek.effectiveRank} for ${bestWeek.size}, ${bestWeek.slotsRemaining} of ${bestWeek.totalSlots} slots remaining without any dropouts).`,
  );

  if (mc.mostLikelyWeek) {
    const weekHits = mc.assignedWeekCounts[mc.mostLikelyWeek] || 0;
    const weekPct = Math.round((weekHits / mc.runs) * 100);
    lines.push(
      `Across all simulations, you were most often assigned to ${weekLabel(mc.mostLikelyWeek)} (${weekPct}% of successful runs).`,
    );
  }

  lines.push(
    `Result: in ${mc.probability}% of the ${mc.runs.toLocaleString()} simulations, a ${mySizeLabel} cabin opened up for you before ${latestWeekEnd}.`,
  );

  return lines.join(' ');
}

function WeekRow({ breakdown }: { breakdown: WeekBreakdown }) {
  return (
    <tr className={breakdown.likely ? 'bg-green-50' : 'bg-orange-50'}>
      <td className="px-4 py-3 font-medium">
        {weekLabel(breakdown.week)}
      </td>
      <td className="px-4 py-3 text-center uppercase">{breakdown.size}</td>
      <td className="px-4 py-3 text-center font-mono">
        #{breakdown.effectiveRank}
      </td>
      <td className="px-4 py-3 text-center">
        {breakdown.familiesAhead}
      </td>
      <td className="px-4 py-3 text-center">
        {breakdown.slotsRemaining} / {breakdown.totalSlots}
      </td>
      <td className="px-4 py-3 text-center">
        {breakdown.likely ? (
          <span className="text-green-700 font-semibold">Likely</span>
        ) : (
          <span className="text-orange-700 font-semibold">Tough</span>
        )}
      </td>
    </tr>
  );
}

export default function MatherTracker() {
  const [userRank, setUserRank] = useState<number | ''>('');

  const results = useMemo(() => simulate(waitlistData as Family[]), []);

  const myStatus: SimulationResult | undefined = results.find(
    (f) => f.rank === userRank,
  );

  const weekBreakdown: WeekBreakdown[] = useMemo(() => {
    if (!userRank) return [];
    return computeWeekBreakdown(userRank, waitlistData as Family[]);
  }, [userRank]);

  const monteCarlo: MonteCarloSummary | null = useMemo(() => {
    if (!userRank) return null;
    return monteCarloForFamily(userRank, waitlistData as Family[]);
  }, [userRank]);

  const myWeeks = useMemo(() => {
    if (!weekBreakdown.length) return [];
    return [...new Set(weekBreakdown.map((b) => b.week))].sort((a, b) => a - b);
  }, [weekBreakdown]);

  const myWeekDemand = useMemo(
    () => computeWeekDemand(myWeeks, waitlistData as Family[]),
    [myWeeks],
  );

  const cabinDemand = useMemo(
    () => computeCabinDemand(waitlistData as Family[]),
    [],
  );

  const analysis = useMemo(() => {
    if (!myStatus || !monteCarlo) return '';
    return buildAnalysis(weekBreakdown, monteCarlo, myStatus, waitlistData as Family[]);
  }, [weekBreakdown, monteCarlo, myStatus]);

  return (
    <div className="p-6 max-w-3xl mx-auto font-sans">
      <header className="mb-8 text-center">
        <h1 className="text-3xl font-bold text-blue-800">
          Magic Mather 2026
        </h1>
        <p className="text-gray-600">Waitlist Probability Engine</p>
      </header>

      <div className="bg-gray-50 p-6 rounded-xl shadow-sm border border-gray-200">
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Enter your Waitlist Number:
        </label>
        <input
          type="number"
          className="w-full p-3 border rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
          placeholder="e.g. 142"
          value={userRank}
          onChange={(e) => {
            const val = e.target.value;
            setUserRank(val === '' ? '' : parseInt(val, 10));
          }}
        />
      </div>

      {myStatus && monteCarlo && (
        <div className="mt-8 space-y-4">
          {/* Probability banner */}
          <div className={`p-6 rounded-xl border-2 ${probabilityBg(monteCarlo.probability)}`}>
            <div className="flex items-baseline gap-3 mb-2">
              <span className={`text-4xl font-bold font-mono ${probabilityColor(monteCarlo.probability)}`}>
                {monteCarlo.probability}%
              </span>
              <h2 className="text-xl font-bold text-gray-800">
                chance of getting a cabin
              </h2>
            </div>
            <p className="text-gray-700">
              {monteCarlo.probability >= 75
                ? `The simulation predicts you will most likely get a ${monteCarlo.mostLikelySize} cabin in ${weekLabel(monteCarlo.mostLikelyWeek!)}.`
                : monteCarlo.probability >= 40
                  ? `You have a reasonable shot. Your best odds are for a ${monteCarlo.mostLikelySize} cabin in ${weekLabel(monteCarlo.mostLikelyWeek!)}.`
                  : 'Based on current demand, the odds are against you. Consider adding more weeks or different cabin sizes.'}
            </p>

            {/* Per-week probability mini bar */}
            {Object.keys(monteCarlo.assignedWeekCounts).length > 1 && (
              <div className="mt-4 pt-3 border-t border-gray-200/60">
                <span className="text-xs text-gray-500 uppercase tracking-wider font-medium">
                  Probability by week
                </span>
                <div className="mt-2 space-y-1.5">
                  {Object.entries(monteCarlo.assignedWeekCounts)
                    .sort(([, a], [, b]) => b - a)
                    .map(([week, count]) => {
                      const pct = Math.round((count / monteCarlo.runs) * 100);
                      return (
                        <div key={week} className="flex items-center gap-2 text-sm">
                          <span className="w-28 text-gray-600 text-xs shrink-0">
                            {weekLabel(Number(week))}
                          </span>
                          <div className="flex-1 bg-gray-200/60 rounded-full h-2">
                            <div
                              className="h-2 rounded-full bg-blue-500"
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                          <span className="w-10 text-right text-xs font-mono text-gray-600">
                            {pct}%
                          </span>
                        </div>
                      );
                    })}
                </div>
              </div>
            )}
          </div>

          {/* Analysis paragraph */}
          <div className="p-5 bg-white border border-gray-200 rounded-xl text-sm text-gray-700 leading-relaxed">
            <h3 className="font-semibold text-gray-800 mb-2">How we calculated this</h3>
            <p>{analysis}</p>
          </div>
        </div>
      )}

      {weekBreakdown.length > 0 && (
        <div className="mt-8">
          <h2 className="text-lg font-bold text-gray-800 mb-3">
            Your Weeks Breakdown
          </h2>
          <div className="overflow-x-auto rounded-xl border border-gray-200">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-100 text-gray-600 text-xs uppercase tracking-wider">
                  <th className="px-4 py-3 text-left">Week</th>
                  <th className="px-4 py-3 text-center">Cabin</th>
                  <th className="px-4 py-3 text-center">Your Rank</th>
                  <th className="px-4 py-3 text-center">Ahead of You</th>
                  <th className="px-4 py-3 text-center">Slots Left</th>
                  <th className="px-4 py-3 text-center">Outlook</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {weekBreakdown.map((b, i) => (
                  <WeekRow key={i} breakdown={b} />
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-gray-500">
            "Your Rank" = families ahead requesting the same week + cabin. "Slots Left" = inventory remaining (deterministic, before dropouts).
          </p>
        </div>
      )}

      {myWeekDemand.length > 0 && (
        <div className="mt-8">
          <h2 className="text-lg font-bold text-gray-800 mb-3">
            Demand For Your Weeks
          </h2>
          <div className="space-y-4">
            {myWeekDemand.map((wd) => (
              <div
                key={wd.week}
                className="bg-white border rounded-xl p-4 shadow-sm"
              >
                <div className="flex items-baseline justify-between mb-3">
                  <h3 className="font-semibold text-gray-800">
                    {weekLabel(wd.week)}
                  </h3>
                  <span className="text-xs text-gray-500">
                    {wd.totalFamilies} families want this week
                  </span>
                </div>
                <div className="grid grid-cols-4 gap-2">
                  {wd.cabins.map((c) => {
                    const isMySize = weekBreakdown.some(
                      (b) => b.week === wd.week && b.size === c.size,
                    );
                    return (
                      <div
                        key={c.size}
                        className={`rounded-lg p-2 text-center ${isMySize ? 'ring-2 ring-blue-400 bg-blue-50' : 'bg-gray-50'}`}
                      >
                        <span className="block text-xs text-gray-500 uppercase">
                          {c.size}
                        </span>
                        <span className="block text-lg font-mono font-bold">
                          {c.families}
                        </span>
                        <div className="mt-1 w-full bg-gray-200 rounded-full h-1.5">
                          <div
                            className={`h-1.5 rounded-full ${c.ratio > 1 ? 'bg-red-400' : c.ratio > 0.7 ? 'bg-orange-400' : 'bg-green-400'}`}
                            style={{
                              width: `${Math.min(100, c.ratio * 100)}%`,
                            }}
                          />
                        </div>
                        <span className="block text-[10px] text-gray-400 mt-0.5">
                          {c.slots} slots
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
          <p className="mt-2 text-xs text-gray-500">
            Your cabin size is highlighted in blue.
          </p>
        </div>
      )}

      <div className="mt-10">
        <h2 className="text-lg font-bold text-gray-800 mb-3">
          Overall Cabin Demand
        </h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {cabinDemand.map((d) => (
            <div
              key={d.size}
              className="bg-white border rounded-xl p-4 shadow-sm"
            >
              <span className="block text-xs text-gray-500 uppercase tracking-wider">
                {d.size} cabin
              </span>
              <span className="block text-2xl font-mono font-bold mt-1">
                {d.totalFamilies}
              </span>
              <span className="block text-xs text-gray-500">
                families want this
              </span>
              <div className="mt-2 pt-2 border-t">
                <span className="block text-xs text-gray-500">
                  {d.totalSlots} total slots across all weeks
                </span>
                <div className="mt-1 w-full bg-gray-200 rounded-full h-2">
                  <div
                    className={`h-2 rounded-full ${d.ratio > 1 ? 'bg-red-400' : d.ratio > 0.7 ? 'bg-orange-400' : 'bg-green-400'}`}
                    style={{ width: `${Math.min(100, d.ratio * 100)}%` }}
                  />
                </div>
                <span className="block text-xs mt-1 font-medium">
                  {d.ratio > 1 ? (
                    <span className="text-red-600">
                      {d.ratio.toFixed(1)}x oversubscribed
                    </span>
                  ) : (
                    <span className="text-green-600">
                      {Math.round((1 - d.ratio) * 100)}% slots available
                    </span>
                  )}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
