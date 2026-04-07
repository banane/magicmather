import { useState, useMemo } from 'react';
import {
  simulate,
  computeWeekBreakdown,
  computeCabinDemand,
  computeWeekDemand,
  monteCarloForFamily,
  FLAKE_RATE,
  TIMEOUT_RATE,
  type SimulationResult,
  type WeekBreakdown,
  type MonteCarloSummary,
  type WeekDemand,
} from '../mather-engine';
import { type CabinSize, type Family, INVENTORY_PER_WEEK } from '../constants';
import waitlistData from '../public/data.json';

// --- Constants ---

const WEEK_LABELS: Record<number, string> = {
  1: 'May 31 – Jun 3', 2: 'Jun 3 – 6', 3: 'Jun 7 – 13', 4: 'Jun 14 – 20',
  5: 'Jun 21 – 27', 6: 'Jun 28 – Jul 4', 7: 'Jul 5 – 11', 8: 'Jul 12 – 18',
  9: 'Jul 19 – 25', 10: 'Jul 26 – Aug 1', 11: 'Aug 2 – 8', 12: 'Aug 9 – 15',
};
const WEEK_START_DATES: Record<number, string> = {
  1: '5/31', 2: '6/3', 3: '6/7', 4: '6/14', 5: '6/21', 6: '6/28',
  7: '7/5', 8: '7/12', 9: '7/19', 10: '7/26', 11: '8/2', 12: '8/9',
};
const EARLY_WEEKS = new Set([1, 2, 3]);
const PEAK_WEEKS = new Set([4, 5, 6, 7, 8]);
const LATE_WEEKS = new Set([9, 10, 11]);
const LESS_POPULAR_SIZES = new Set<CabinSize>(['2c', '3c']);

function weekLabel(week: number) { return WEEK_LABELS[week] ?? `Week ${week}`; }

function seasonTag(week: number) {
  if (EARLY_WEEKS.has(week)) return { label: 'Early Summer', emoji: '🌲', cls: 'bg-green-100 text-green-700' };
  if (PEAK_WEEKS.has(week)) return { label: 'Peak Summer', emoji: '☀️', cls: 'bg-red-100 text-red-700' };
  if (LATE_WEEKS.has(week)) return { label: 'Late Summer', emoji: '🌅', cls: 'bg-amber-100 text-amber-700' };
  return { label: '', emoji: '', cls: '' };
}

function seasonNote(week: number) {
  if (EARLY_WEEKS.has(week)) return "🌲 SFUSD doesn't let out until 6/10 — most families can't make this week. Low competition! 🦌";
  if (LATE_WEEKS.has(week)) return "🌅 End of summer — fewer options remain, but many families ahead get absorbed by earlier weeks 🪵";
  return "☀️ Prime summer — highest demand across all cabin types 🏊 🦟";
}

function pctColor(p: number) {
  if (p >= 75) return 'text-green-700';
  if (p >= 40) return 'text-yellow-600';
  return 'text-red-600';
}

function pctBg(p: number) {
  if (p >= 75) return 'bg-green-50 border-green-200';
  if (p >= 40) return 'bg-yellow-50 border-yellow-200';
  return 'bg-orange-50 border-orange-200';
}

// --- Week Card ---

function WeekCard({
  week,
  breakdowns,
  demand,
  mcWeekPct,
  independentPct,
}: {
  week: number;
  breakdowns: WeekBreakdown[];
  demand: WeekDemand;
  mcWeekPct: number;
  independentPct: number;
}) {
  const season = seasonTag(week);

  return (
    <div className="bg-white border border-gray-200 rounded-xl overflow-hidden shadow-sm">
      {/* Header */}
      <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
        <div>
          <h3 className="text-lg font-bold text-gray-800">📆 {weekLabel(week)}</h3>
          <span className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full mt-1 ${season.cls}`}>
            {season.emoji} {season.label}
          </span>
        </div>
        <div className="text-right space-y-1">
          <div>
            <span className={`text-2xl font-bold font-mono ${pctColor(independentPct)}`}>{independentPct}%</span>
            <span className="block text-[10px] text-gray-400 uppercase tracking-wider">if only this week</span>
          </div>
          {mcWeekPct > 0 && (
            <div className="text-xs text-gray-400">
              🎯 {mcWeekPct}% assigned here across all weeks
            </div>
          )}
        </div>
      </div>

      {/* Your cabin choices for this week */}
      <div className="px-5 py-3 border-b border-gray-50">
        <span className="text-xs text-gray-400 uppercase tracking-wider font-medium">🏕️ Your choices this week</span>
        <div className="mt-2 grid gap-2" style={{ gridTemplateColumns: `repeat(${breakdowns.length}, 1fr)` }}>
          {breakdowns.map((b) => (
            <div key={b.size} className={`rounded-lg p-3 border-2 ${b.likely ? 'border-green-300 bg-green-50' : 'border-orange-300 bg-orange-50'}`}>
              <div className="flex items-baseline justify-between">
                <span className="font-bold text-gray-800 uppercase">{b.size}</span>
                <span className={`text-xs font-semibold ${b.likely ? 'text-green-700' : 'text-orange-700'}`}>
                  {b.likely ? '✅ Likely' : '⛔ Tough'}
                </span>
              </div>
              <div className="mt-2 space-y-1 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-500">🏅 Your rank</span>
                  <span className="font-mono font-semibold text-blue-700">#{b.effectiveRank}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">👥 Families ahead</span>
                  <span className="font-semibold text-gray-700">{b.familiesAhead}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">🛏️ Slots left</span>
                  <span className="font-semibold text-gray-700">{b.slotsRemaining} / {b.totalSlots}</span>
                </div>
              </div>
              {/* Slot fill bar */}
              <div className="mt-2 w-full bg-gray-200 rounded-full h-1.5">
                <div
                  className={`h-1.5 rounded-full ${b.likely ? 'bg-green-500' : 'bg-orange-500'}`}
                  style={{ width: `${Math.min(100, (b.familiesAhead / b.totalSlots) * 100)}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* All cabin demand for this week */}
      <div className="px-5 py-3">
        <span className="text-xs text-gray-400 uppercase tracking-wider font-medium">📊 All cabin demand this week</span>
        <div className="mt-2 grid grid-cols-4 gap-1.5">
          {demand.cabins.map((c) => {
            const isMine = breakdowns.some((b) => b.size === c.size);
            return (
              <div key={c.size} className={`rounded-md p-1.5 text-center ${isMine ? 'ring-2 ring-blue-400 bg-blue-50' : 'bg-gray-50'}`}>
                <span className="block text-[10px] text-gray-400 uppercase">{c.size}</span>
                <span className="block text-sm font-mono font-bold">{c.families}</span>
                <div className="mt-0.5 w-full bg-gray-200 rounded-full h-1">
                  <div
                    className={`h-1 rounded-full ${c.ratio > 1 ? 'bg-red-400' : c.ratio > 0.7 ? 'bg-orange-400' : 'bg-green-400'}`}
                    style={{ width: `${Math.min(100, c.ratio * 100)}%` }}
                  />
                </div>
                <span className="block text-[9px] text-gray-400">{c.slots} slots</span>
              </div>
            );
          })}
        </div>
        <p className="mt-2 text-xs text-gray-400 italic">{seasonNote(week)}</p>
      </div>
    </div>
  );
}

// --- Factors ---

const CABIN_SIZE_LABELS: Record<string, string> = {
  '2c': '2-person', '3c': '3-person', '4c': '4-person', '6c': '6-person',
};

interface Factor { emoji: string; text: string; type: 'positive' | 'negative' | 'neutral' }

function buildFactors(breakdown: WeekBreakdown[]): Factor[] {
  const factors: Factor[] = [];
  const weeks = [...new Set(breakdown.map((b) => b.week))];
  const sizes = [...new Set(breakdown.map((b) => b.size))];

  const earlyWeeks = weeks.filter((w) => EARLY_WEEKS.has(w));
  const peakWeeks = weeks.filter((w) => PEAK_WEEKS.has(w));
  const lateWeeks = weeks.filter((w) => LATE_WEEKS.has(w));

  if (earlyWeeks.length > 0) {
    factors.push({ emoji: '🌲', type: 'positive',
      text: `Early-summer weeks are undersubscribed — SFUSD lets out 6/10, so most families can't go before mid-June 🦌`,
    });
  }
  if (peakWeeks.length > 0 && peakWeeks.length === weeks.length) {
    factors.push({ emoji: '☀️', type: 'negative',
      text: 'All your weeks are peak summer 🏊 — highest competition for every cabin type 🦟',
    });
  }
  if (lateWeeks.length > 0 && lateWeeks.length === weeks.length) {
    factors.push({ emoji: '🌅', type: 'negative',
      text: 'End-of-summer only — fewer slots remain by then, since families ahead claimed earlier weeks 🪵',
    });
  } else if (lateWeeks.length > 0 && (earlyWeeks.length > 0 || peakWeeks.length > 0)) {
    factors.push({ emoji: '🌲', type: 'positive',
      text: "Your weeks span different parts of summer — you're not competing with the same pool every week 🏕️",
    });
  }

  if (sizes.length >= 2) {
    const sizeNames = sizes.map((s) => CABIN_SIZE_LABELS[s] || s).join(' + ');
    factors.push({ emoji: '🛖', type: 'positive',
      text: `Flexible on cabin size (${sizeNames}). If one fills up, the other is a fallback 🏕️`,
    });
  } else if (sizes.length === 1 && !LESS_POPULAR_SIZES.has(sizes[0])) {
    factors.push({ emoji: '🛖', type: 'negative',
      text: `Only ${CABIN_SIZE_LABELS[sizes[0]] || sizes[0]} cabins — the most in-demand. Adding 3-person or 2-person would boost your odds 🤔`,
    });
  }

  if (sizes.some((s) => LESS_POPULAR_SIZES.has(s))) {
    const names = sizes.filter((s) => LESS_POPULAR_SIZES.has(s)).map((s) => CABIN_SIZE_LABELS[s] || s);
    factors.push({ emoji: '💎', type: 'positive',
      text: `${names.join(' and ')} cabins are significantly less competitive — fewer families request them 🌿`,
    });
  }

  const totalOptions = breakdown.length;
  if (totalOptions >= 6) {
    factors.push({ emoji: '🎣', type: 'positive',
      text: `${totalOptions} total week + cabin combinations — lots of bites at the apple 🍎`,
    });
  } else if (totalOptions <= 2) {
    factors.push({ emoji: '🪵', type: 'negative',
      text: `Only ${totalOptions} option${totalOptions > 1 ? 's' : ''} — consider adding more weeks or cabin types 🤞`,
    });
  }

  return factors;
}

// --- Collapsible methodology ---

function MethodologySection({
  mc, breakdown, waitlist, status,
}: {
  mc: MonteCarloSummary; breakdown: WeekBreakdown[]; waitlist: Family[]; status: SimulationResult;
}) {
  const [open, setOpen] = useState(false);

  const familiesAhead = waitlist.filter((f) => f.rank < status.rank);
  const avgOptions = familiesAhead.length > 0
    ? familiesAhead.reduce((sum, f) => sum + f.preferences.length, 0) / familiesAhead.length : 0;

  const competingFamilies = new Set<number>();
  for (const b of breakdown) {
    for (const f of waitlist) {
      if (f.rank < status.rank && f.preferences.some((p) => p.week === b.week && p.size === b.size)) {
        competingFamilies.add(f.rank);
      }
    }
  }

  const dropRate = FLAKE_RATE + TIMEOUT_RATE;
  const totalCleared = mc.avgAbsorbedElsewhere + mc.avgDropouts;

  return (
    <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
      <button
        type="button"
        className="w-full px-5 py-3 flex items-center justify-between text-sm font-semibold text-gray-700 hover:bg-gray-50"
        onClick={() => setOpen((v) => !v)}
      >
        <span>🔬 How we calculated this</span>
        <span className="text-gray-400">{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div className="px-5 pb-4 text-sm text-gray-600 leading-relaxed space-y-2 border-t border-gray-100 pt-3">
          <p>
            🎲 We ran <strong>{mc.runs.toLocaleString()} Monte Carlo simulations</strong>.
            Everyone on the waitlist has paid a <strong>$200 deposit</strong>, so commitment is high.
            Each family ahead still has a {Math.round(FLAKE_RATE * 100)}% chance of declining (schedule conflict, changed plans 🏔️) +{' '}
            {Math.round(TIMEOUT_RATE * 100)}% chance of missing the 24h decision window (on vacation? 🏖️).
            That's {Math.round(dropRate * 100)}% combined. You always accept 🤞.
          </p>
          <p>
            👨‍👩‍👧‍👦 <strong>{competingFamilies.size} families</strong> ahead overlap with your choices.
            On average they each have <strong>{avgOptions.toFixed(1)} options</strong> — when any comes through, they grab their cabin and leave your pool 🏕️
          </p>
          <p>
            🔄 Per run, <strong className="text-blue-700">{mc.avgAbsorbedElsewhere}</strong> get absorbed by other weeks 🌊 +{' '}
            <strong className="text-purple-700">~{mc.avgDropouts}</strong> drop out 👋 ={' '}
            <strong className="text-green-700">{totalCleared} cleared</strong> of {competingFamilies.size} competitors 🌲
          </p>
          <p className="pt-1 border-t border-gray-100">
            📄 Source: <a href="https://sfrecpark.org/DocumentCenter/View/28472/Camp-Mather-WaitListCrosstab2026" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:text-blue-800 underline">Official SF Rec & Park Waitlist PDF</a>
          </p>
        </div>
      )}
    </div>
  );
}

// --- Main component ---

function getRankFromUrl(): number | '' {
  const params = new URLSearchParams(window.location.search);
  const val = params.get('rank') || params.get('r');
  if (val) {
    const n = parseInt(val, 10);
    if (!isNaN(n) && n > 0) return n;
  }
  return '';
}

function updateUrl(rank: number | '') {
  const url = new URL(window.location.href);
  if (rank === '') {
    url.searchParams.delete('rank');
  } else {
    url.searchParams.set('rank', String(rank));
  }
  window.history.replaceState({}, '', url.toString());
}

export default function MatherTracker() {
  const [userRank, setUserRank] = useState<number | ''>(getRankFromUrl);

  const results = useMemo(() => simulate(waitlistData as Family[]), []);
  const myStatus = results.find((f) => f.rank === userRank);

  const weekBreakdown = useMemo(() => {
    if (!userRank) return [];
    return computeWeekBreakdown(userRank, waitlistData as Family[]);
  }, [userRank]);

  const monteCarlo = useMemo(() => {
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

  const cabinDemand = useMemo(() => computeCabinDemand(waitlistData as Family[]), []);
  const factors = useMemo(() => buildFactors(weekBreakdown), [weekBreakdown]);

  const mySizes = [...new Set(weekBreakdown.map((b) => b.size))];
  const positive = factors.filter((f) => f.type === 'positive');
  const negative = factors.filter((f) => f.type === 'negative');

  return (
    <div className="p-6 max-w-3xl mx-auto font-sans">
      {/* Hero */}
      <div className="mb-6 text-center">
        <p className="text-4xl">🌲🏕️🌲</p>
        <h1 className="text-3xl font-bold text-blue-800 mt-2">Magic Mather 2026</h1>
        <p className="text-gray-600 mt-1">🎯 Waitlist Probability Engine</p>
      </div>

      {/* Hero photos */}
      <div className="mb-4 grid grid-cols-2 gap-3">
        <div className="aspect-[4/3] rounded-xl overflow-hidden bg-green-900/10">
          <img
            src="/kevin-cabin.png"
            alt="Cabin at Camp Mather"
            className="w-full h-full object-cover"
            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
          />
        </div>
        <div className="aspect-[4/3] rounded-xl overflow-hidden bg-blue-900/10">
          <img
            src="/falls.jpg"
            alt="Waterfall near Camp Mather"
            className="w-full h-full object-cover"
            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
          />
        </div>
      </div>

      <div className="mb-8 px-5 py-4 bg-amber-50 border border-amber-200 rounded-xl text-sm text-amber-900 leading-relaxed text-center">
        <p className="font-semibold text-base mb-1">
          🏔️ Camp Mather — SF's Best Kept Family Secret! 🌊
        </p>
        <p>
          Nestled near Yosemite since 1924, Camp Mather is San Francisco's own slice of paradise 🌲
          Swimming, hiking, campfires, stargazing, and zero cell service 📵 — just pure family time.
          If you know, you know. From a super fan who's been dreaming about it since last August 🤩
        </p>
        <p className="mt-2 text-xs text-amber-700">
          🦌 This tool helps you figure out your odds of getting off the waitlist.
          Punch in your number and see the magic ✨
        </p>
      </div>

      <header className="mb-8 text-center">
        <p className="text-xs text-gray-400">
          🔄 Data refreshed {new Date(__BUILD_TIME__).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} at {new Date(__BUILD_TIME__).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
        </p>
      </header>

      {/* Input */}
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
            const rank = val === '' ? '' : parseInt(val, 10);
            setUserRank(rank);
            updateUrl(rank);
          }}
        />
      </div>

      {myStatus && monteCarlo && (
        <div className="mt-8 space-y-5">

          {/* Overall probability banner */}
          <div className={`p-6 rounded-xl border-2 ${pctBg(monteCarlo.probability)}`}>
            <div className="flex items-baseline gap-3 mb-1">
              <span className={`text-5xl font-bold font-mono ${pctColor(monteCarlo.probability)}`}>
                {monteCarlo.probability}%
              </span>
              <h2 className="text-xl font-bold text-gray-800">chance of getting a cabin 🤞</h2>
            </div>
            <p className="text-sm text-gray-600">
              🏕️ Waitlist <strong>#{myStatus.rank}</strong> &middot;{' '}
              🗓️ {myWeeks.length} week{myWeeks.length !== 1 ? 's' : ''} &middot;{' '}
              🛖 {mySizes.length} cabin type{mySizes.length !== 1 ? 's' : ''} ({mySizes.join(', ')}) &middot;{' '}
              🎣 {weekBreakdown.length} total options
            </p>

            {/* Per-week probability bars */}
            {Object.keys(monteCarlo.assignedWeekCounts).length > 0 && (
              <div className="mt-4 pt-3 border-t border-gray-200/60">
                <span className="text-xs text-gray-500 uppercase tracking-wider font-medium">🎲 Probability by week</span>
                <div className="mt-2 space-y-1.5">
                  {myWeeks.map((week) => {
                    const count = monteCarlo.assignedWeekCounts[week] || 0;
                    const pct = Math.round((count / monteCarlo.runs) * 100);
                    return (
                      <div key={week} className="flex items-center gap-2 text-sm">
                        <span className="w-28 text-gray-600 text-xs shrink-0">{weekLabel(week)}</span>
                        <div className="flex-1 bg-gray-200/60 rounded-full h-2.5">
                          <div className="h-2.5 rounded-full bg-blue-500" style={{ width: `${pct}%` }} />
                        </div>
                        <span className={`w-10 text-right text-xs font-mono font-semibold ${pctColor(pct)}`}>{pct}%</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {/* Share button */}
          <button
            type="button"
            className="w-full py-2.5 rounded-xl border border-gray-200 bg-white text-sm font-medium text-gray-700 hover:bg-gray-50 flex items-center justify-center gap-2"
            onClick={() => {
              const weekLines = myWeeks.map((w) => {
                const bds = weekBreakdown.filter((b) => b.week === w);
                const indyPct = monteCarlo.weekIndependentProbability[w] ?? 0;
                const cabins = bds.map((b) => `${b.size} (#${b.effectiveRank}, ${b.slotsRemaining}/${b.totalSlots} slots)`).join(', ');
                return `  ${weekLabel(w)}: ${indyPct}% — ${cabins}`;
              }).join('\n');

              const text = [
                `🏕️ Camp Mather 2026 — Waitlist #${myStatus.rank}`,
                `🤞 ${monteCarlo.probability}% overall chance of getting a cabin`,
                `🛖 ${mySizes.join(', ')} · ${myWeeks.length} weeks · ${weekBreakdown.length} options`,
                '',
                '🗓️ Per-week odds (if only that week):',
                weekLines,
                '',
                `🔬 Based on ${monteCarlo.runs.toLocaleString()} Monte Carlo simulations`,
                `📄 Source: sfrecpark.org waitlist PDF`,
                `🎯 Try it: ${window.location.origin}${window.location.pathname}?rank=${myStatus.rank}`,
              ].join('\n');

              if (navigator.share) {
                navigator.share({ text }).catch(() => {});
              } else {
                navigator.clipboard.writeText(text);
                alert('📋 Copied to clipboard!');
              }
            }}
          >
            📤 Share my results
          </button>

          {/* Factors */}
          {factors.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {positive.map((f, i) => (
                <span key={`p${i}`} className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-full bg-green-100 text-green-800">
                  {f.emoji} {f.text}
                </span>
              ))}
              {negative.map((f, i) => (
                <span key={`n${i}`} className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-full bg-orange-100 text-orange-800">
                  {f.emoji} {f.text}
                </span>
              ))}
              {factors.filter((f) => f.type === 'neutral').map((f, i) => (
                <span key={`u${i}`} className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-full bg-blue-100 text-blue-800">
                  {f.emoji} {f.text}
                </span>
              ))}
            </div>
          )}

          {/* Week cards */}
          <div>
            <h2 className="text-lg font-bold text-gray-800 mb-3">🗓️ Your Weeks</h2>
            <div className="space-y-4">
              {myWeeks.map((week) => {
                const weekBreakdowns = weekBreakdown.filter((b) => b.week === week);
                const demand = myWeekDemand.find((d) => d.week === week);
                const count = monteCarlo.assignedWeekCounts[week] || 0;
                const mcPct = Math.round((count / monteCarlo.runs) * 100);
                const indyPct = monteCarlo.weekIndependentProbability[week] ?? 0;
                return demand ? (
                  <WeekCard
                    key={week}
                    week={week}
                    breakdowns={weekBreakdowns}
                    demand={demand}
                    mcWeekPct={mcPct}
                    independentPct={indyPct}
                  />
                ) : null;
              })}
            </div>
          </div>

          {/* Methodology (collapsible) */}
          <MethodologySection
            mc={monteCarlo}
            breakdown={weekBreakdown}
            waitlist={waitlistData as Family[]}
            status={myStatus}
          />
        </div>
      )}

      {/* Overall cabin demand (always visible) */}
      <div className="mt-10">
        <h2 className="text-lg font-bold text-gray-800 mb-3">🏠 Overall Cabin Demand</h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {cabinDemand.map((d) => (
            <div key={d.size} className="bg-white border rounded-xl p-4 shadow-sm">
              <span className="block text-xs text-gray-500 uppercase tracking-wider">{d.size} cabin</span>
              <span className="block text-2xl font-mono font-bold mt-1">{d.totalFamilies}</span>
              <span className="block text-xs text-gray-500">families want this</span>
              <div className="mt-2 pt-2 border-t">
                <span className="block text-xs text-gray-500">{d.totalSlots} total slots</span>
                <div className="mt-1 w-full bg-gray-200 rounded-full h-2">
                  <div
                    className={`h-2 rounded-full ${d.ratio > 1 ? 'bg-red-400' : d.ratio > 0.7 ? 'bg-orange-400' : 'bg-green-400'}`}
                    style={{ width: `${Math.min(100, d.ratio * 100)}%` }}
                  />
                </div>
                <span className="block text-xs mt-1 font-medium">
                  {d.ratio > 1
                    ? <span className="text-red-600">{d.ratio.toFixed(1)}x oversubscribed</span>
                    : <span className="text-green-600">{Math.round((1 - d.ratio) * 100)}% available</span>
                  }
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Bottom photo banner */}
      <div className="mt-10 -mx-6 relative h-48 overflow-hidden">
        <img
          src="/falls.jpg"
          alt="Camp Mather waterfall"
          className="w-full h-full object-cover"
          onError={(e) => { (e.target as HTMLImageElement).parentElement!.style.display = 'none'; }}
        />
        <div className="absolute inset-0 bg-gradient-to-t from-gray-100 to-transparent" />
      </div>

      {/* Footer */}
      <footer className="mt-6 pt-6 border-t border-gray-200 text-center text-sm text-gray-500 space-y-1">
        <p>Like this? Have questions? Drop me a line:</p>
        <button
          type="button"
          className="text-blue-600 hover:text-blue-800 font-medium cursor-pointer"
          onClick={() => { window.location.href = `mailto:${'banane'}@${'gmail.com'}`; }}
        >
          banane [at] gmail.com
        </button>
        <p className="text-xs text-gray-400 pt-2">&copy; 2026 banane.com</p>
      </footer>
    </div>
  );
}
