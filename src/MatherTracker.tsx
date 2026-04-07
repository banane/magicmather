import { useState, useMemo } from 'react';
import {
  simulate,
  computeWeekBreakdown,
  computeCabinDemand,
  computeWeekDemand,
  monteCarloForFamily,
  RESERVATION_CANCEL_EARLY,
  RESERVATION_CANCEL_LATE,
  WAITLIST_LAPSE_RATE,
  WAITLIST_FLAKE_BASE,
  WAITLIST_FLAKE_LATE,
  type SimulationResult,
  type WeekBreakdown,
  type MonteCarloSummary,
  type WeekDemand,
} from '../mather-engine';
import { type CabinSize, type Family, INVENTORY_PER_WEEK } from '../constants';
import rawData from '../public/data.json';

// Support both old format (array) and new format ({ scrapedAt, families })
const waitlistData: Family[] = Array.isArray(rawData) ? rawData : (rawData as { families: Family[] }).families;
const scrapedAt: string | null = Array.isArray(rawData) ? null : (rawData as { scrapedAt: string }).scrapedAt;

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
const CABIN_NAMES: Record<string, string> = {
  '2c': '2-person', '3c': '3-person', '4c': '4-person', '6c': '6-person',
};

function weekLabel(w: number) { return WEEK_LABELS[w] ?? `Week ${w}`; }

function seasonBadge(week: number) {
  if (EARLY_WEEKS.has(week)) return { text: '🌲 Early Summer', cls: 'bg-emerald-100 text-emerald-800' };
  if (PEAK_WEEKS.has(week)) return { text: '☀️ Peak Summer', cls: 'bg-amber-100 text-amber-800' };
  return { text: '🌅 Late Summer', cls: 'bg-orange-100 text-orange-800' };
}

function seasonTip(week: number) {
  if (EARLY_WEEKS.has(week)) return "🌲 Before SFUSD lets out 6/10 — low competition 🦌";
  if (LATE_WEEKS.has(week)) return "🌅 End of summer — families ahead often absorbed by earlier weeks 🪵";
  return "☀️ Peak demand across all cabin types 🏊 🦟";
}

// Unified color scale for probabilities
function pctStyle(p: number) {
  if (p >= 75) return { text: 'text-emerald-700', bg: 'bg-emerald-50', border: 'border-emerald-200' };
  if (p >= 40) return { text: 'text-amber-600', bg: 'bg-amber-50', border: 'border-amber-200' };
  return { text: 'text-red-600', bg: 'bg-red-50', border: 'border-red-200' };
}

// Waitlist position status: how does your rank compare to expected cancellations?
function waitlistStatus(familiesAhead: number, expectedCancellations: number) {
  if (familiesAhead === 0) return { label: '🟢 First in line', cls: 'border-emerald-200 bg-emerald-50', bar: 'bg-emerald-500' };
  if (familiesAhead < expectedCancellations) return { label: '🟢 Good odds', cls: 'border-emerald-200 bg-emerald-50', bar: 'bg-emerald-500' };
  if (familiesAhead < expectedCancellations * 2) return { label: '🟡 Possible', cls: 'border-amber-200 bg-amber-50', bar: 'bg-amber-500' };
  return { label: '🔴 Long shot', cls: 'border-red-200 bg-red-50', bar: 'bg-red-400' };
}

// Shared card wrapper
function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div className={`bg-white border border-stone-200 rounded-xl shadow-sm ${className}`}>{children}</div>;
}

// --- Week Card ---

function WeekCard({ week, breakdowns, demand, mcWeekPct, independentPct }: {
  week: number; breakdowns: WeekBreakdown[]; demand: WeekDemand; mcWeekPct: number; independentPct: number;
}) {
  const season = seasonBadge(week);
  const style = pctStyle(independentPct);

  return (
    <Card>
      {/* Header */}
      <div className="px-4 py-3 border-b border-stone-100 flex items-center justify-between">
        <div>
          <h3 className="font-bold text-lg text-stone-800">📆 {weekLabel(week)}</h3>
          <span className={`inline-flex text-[11px] font-medium px-2 py-0.5 rounded-full mt-1 ${season.cls}`}>{season.text}</span>
        </div>
        <div className="text-right">
          <span className={`text-2xl font-bold font-mono ${style.text}`}>{independentPct}%</span>
          <span className="block text-[10px] text-stone-400">if only this week</span>
          {mcWeekPct > 0 && <span className="block text-[10px] text-stone-400">🎯 {mcWeekPct}% assigned here</span>}
        </div>
      </div>

      {/* Cabin choices */}
      <div className="px-4 py-3 border-b border-stone-50">
        <span className="text-xs font-semibold text-stone-500 uppercase tracking-wider">🏕️ Your choices</span>
        <div className="mt-2 grid gap-2" style={{ gridTemplateColumns: `repeat(${breakdowns.length}, 1fr)` }}>
          {breakdowns.map((b) => {
            const s = waitlistStatus(b.familiesAhead, b.expectedCancellations);
            return (
              <div key={b.size} className={`rounded-lg p-3 border ${s.cls}`}>
                <div className="flex items-baseline justify-between">
                  <span className="font-bold text-stone-800 uppercase text-sm">{b.size}</span>
                  <span className="text-[11px] font-semibold">{s.label}</span>
                </div>
                <div className="mt-2 space-y-0.5 text-xs">
                  <div className="flex justify-between"><span className="text-stone-500">🏅 Your position</span><span className="font-mono font-semibold text-blue-700">#{b.effectiveRank}</span></div>
                  <div className="flex justify-between"><span className="text-stone-500">👥 Ahead of you</span><span className="font-semibold">{b.familiesAhead}</span></div>
                  <div className="flex justify-between"><span className="text-stone-500">🛖 Cabins occupied</span><span className="font-semibold">{b.totalCabins}</span></div>
                  <div className="flex justify-between"><span className="text-stone-500">🔄 Est. cancellations</span><span className="font-semibold">{b.expectedCancellations}</span></div>
                </div>
                <div className="mt-2 w-full bg-stone-200 rounded-full h-1.5">
                  <div className={`h-1.5 rounded-full ${s.bar}`} style={{ width: `${Math.min(100, b.expectedCancellations > 0 ? (b.familiesAhead / (b.expectedCancellations * 2)) * 100 : 100)}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Competitor spread */}
      {breakdowns.some((b) => b.spread.total > 0) && (
        <div className="px-4 py-3 border-b border-stone-50">
          <span className="text-xs font-semibold text-stone-500 uppercase tracking-wider">🔍 Competitor spread</span>
          <div className="mt-2 space-y-2">
            {breakdowns.filter((b) => b.spread.total > 0).map((b) => {
              const sp = b.spread;
              const spreadOut = sp.total - sp.onlyThisWeek;
              const spreadPct = Math.round((spreadOut / sp.total) * 100);
              return (
                <div key={b.size} className="text-xs text-stone-600">
                  <div className="flex items-baseline gap-1.5 mb-1">
                    <span className="font-semibold text-stone-800 uppercase">{b.size}</span>
                    <span>— {sp.total} families ahead</span>
                  </div>
                  <div className="grid grid-cols-3 gap-1">
                    <div className="bg-red-50 rounded-md p-1.5 text-center">
                      <span className="block font-mono font-bold text-red-700">{sp.onlyThisWeek}</span>
                      <span className="block text-[10px] text-red-600">only want this week 😬</span>
                    </div>
                    <div className="bg-amber-50 rounded-md p-1.5 text-center">
                      <span className="block font-mono font-bold text-amber-700">{sp.haveEarlierWeeks}</span>
                      <span className="block text-[10px] text-amber-600">also want earlier weeks 🏃</span>
                    </div>
                    <div className="bg-emerald-50 rounded-md p-1.5 text-center">
                      <span className="block font-mono font-bold text-emerald-700">{spreadOut}</span>
                      <span className="block text-[10px] text-emerald-600">spread to other weeks ✨</span>
                    </div>
                  </div>
                  <p className="mt-1 text-[11px] text-stone-400">
                    {spreadPct}% of competitors have other options (avg {sp.avgOptions} each) — likely to get absorbed before your week
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* All cabin demand */}
      <div className="px-4 py-3">
        <div className="flex items-baseline justify-between">
          <span className="text-xs font-semibold text-stone-500 uppercase tracking-wider">📊 Week demand</span>
          <span className="text-[11px] text-stone-400">🛖 {demand.cabinDemand.reduce((s, c) => s + c.cabins, 0)} cabins (all occupied)</span>
        </div>
        <div className="mt-1.5 grid grid-cols-4 gap-1">
          {demand.cabinDemand.map((c) => {
            const isMine = breakdowns.some((b) => b.size === c.size);
            return (
              <div key={c.size} className={`rounded-md p-1.5 text-center ${isMine ? 'ring-2 ring-blue-400 bg-blue-50' : 'bg-stone-50'}`}>
                <span className="block text-[10px] text-stone-400 uppercase">{c.size}</span>
                <span className="block text-sm font-mono font-bold">{c.families}</span>
                <div className="mt-0.5 w-full bg-stone-200 rounded-full h-1">
                  <div className={`h-1 rounded-full ${c.ratio > 1 ? 'bg-red-400' : c.ratio > 0.7 ? 'bg-amber-400' : 'bg-emerald-400'}`} style={{ width: `${Math.min(100, (c.ratio / 10) * 100)}%` }} />
                </div>
                <span className="block text-[9px] text-stone-400">~{c.expectedCancellations} may cancel</span>
              </div>
            );
          })}
        </div>
        <p className="mt-1.5 text-[11px] text-stone-400 italic">{seasonTip(week)}</p>
      </div>
    </Card>
  );
}

// --- Factors ---

interface Factor { emoji: string; text: string; type: 'positive' | 'negative' | 'neutral' }

function buildFactors(breakdown: WeekBreakdown[]): Factor[] {
  const factors: Factor[] = [];
  const weeks = [...new Set(breakdown.map((b) => b.week))];
  const sizes = [...new Set(breakdown.map((b) => b.size))];
  const earlyWeeks = weeks.filter((w) => EARLY_WEEKS.has(w));
  const peakWeeks = weeks.filter((w) => PEAK_WEEKS.has(w));
  const lateWeeks = weeks.filter((w) => LATE_WEEKS.has(w));

  if (earlyWeeks.length > 0)
    factors.push({ emoji: '🌲', type: 'positive', text: 'Early-summer weeks — undersubscribed before SFUSD lets out 6/10' });
  if (peakWeeks.length > 0 && peakWeeks.length === weeks.length)
    factors.push({ emoji: '☀️', type: 'negative', text: 'All peak summer — highest competition' });
  if (lateWeeks.length > 0 && lateWeeks.length === weeks.length)
    factors.push({ emoji: '🌅', type: 'negative', text: 'Late summer only — fewer slots remain' });
  else if (lateWeeks.length > 0 && (earlyWeeks.length > 0 || peakWeeks.length > 0))
    factors.push({ emoji: '🏕️', type: 'positive', text: 'Weeks span different parts of summer' });

  if (sizes.length >= 2)
    factors.push({ emoji: '🛖', type: 'positive', text: `Flexible: ${sizes.map((s) => CABIN_NAMES[s] || s).join(' + ')}` });
  else if (sizes.length === 1 && !LESS_POPULAR_SIZES.has(sizes[0]))
    factors.push({ emoji: '🛖', type: 'negative', text: `Only ${CABIN_NAMES[sizes[0]]} — most in-demand` });

  if (sizes.some((s) => LESS_POPULAR_SIZES.has(s)))
    factors.push({ emoji: '💎', type: 'positive', text: `${sizes.filter((s) => LESS_POPULAR_SIZES.has(s)).map((s) => CABIN_NAMES[s]).join(', ')} — less competitive` });

  const n = breakdown.length;
  if (n >= 6) factors.push({ emoji: '🎣', type: 'positive', text: `${n} total options — lots of chances` });
  else if (n <= 2) factors.push({ emoji: '🪵', type: 'negative', text: `Only ${n} option${n > 1 ? 's' : ''} — consider adding more` });

  return factors;
}

// --- Methodology ---

function MethodologySection({ mc, breakdown, waitlist, status, forceOpen }: {
  mc: MonteCarloSummary; breakdown: WeekBreakdown[]; waitlist: Family[]; status: SimulationResult; forceOpen?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const isOpen = open || !!forceOpen;
  const familiesAhead = waitlist.filter((f) => f.rank < status.rank);
  const avgOptions = familiesAhead.length > 0
    ? familiesAhead.reduce((sum, f) => sum + f.preferences.length, 0) / familiesAhead.length : 0;

  const competingFamilies = new Set<number>();
  for (const b of breakdown) {
    for (const f of waitlist) {
      if (f.rank < status.rank && f.preferences.some((p) => p.week === b.week && p.size === b.size))
        competingFamilies.add(f.rank);
    }
  }

  return (
    <Card>
      <button type="button" className="w-full px-4 py-3 flex items-center justify-between text-sm font-semibold text-stone-700 hover:bg-stone-50" onClick={() => setOpen((v) => !v)}>
        <span>🔬 How we calculated this</span>
        <span className="text-stone-400 text-xs">{isOpen ? '▲' : '▼'}</span>
      </button>
      {isOpen && (
        <div className="px-4 pb-4 text-xs text-stone-600 leading-relaxed space-y-2 border-t border-stone-100 pt-3">
          <p>🎰 <strong>What's a Monte Carlo simulation?</strong> We run the waitlist process {mc.runs.toLocaleString()} times with random variation. Your probability = the % of runs where you got a cabin.</p>
          <p>📅 <strong>Temporal model:</strong> We process weeks in chronological order (week 1 first, then 2, etc.). As each week resolves, families who got offered a cabin — whether they accepted or declined — are removed from the waitlist entirely. By the time your weeks come up, the competitive pool has already shrunk.</p>
          <p>🏕️ <strong>All cabins are full.</strong> Reservation holders paid $200. Cancel rates vary by timing: <strong>{Math.round(RESERVATION_CANCEL_EARLY * 100)}%</strong> for weeks far out (plans haven't changed yet) up to <strong>{Math.round(RESERVATION_CANCEL_LATE * 100)}%</strong> for imminent weeks (life happened) 🏔️ That creates <strong>~{mc.avgCancellations} openings</strong> per run across all weeks.</p>
          <p>📧 <strong>Waitlist offers:</strong> When an opening comes up, the next family in line gets a 24h email. <strong>{Math.round(WAITLIST_LAPSE_RATE * 100)}%</strong> miss the email + <strong>{Math.round(WAITLIST_FLAKE_BASE * 100)}–{Math.round(WAITLIST_FLAKE_LATE * 100)}%</strong> made other plans (more for later weeks — they've been waiting longer). Accept or decline, they're off the list. The offer cascades to the next person. You always accept 🤞</p>
          <p>👨‍👩‍👧‍👦 <strong>{competingFamilies.size} families</strong> ahead overlap your weeks/cabins. But <strong>~{mc.avgRemovedBeforeYourWeeks}</strong> get resolved in earlier weeks before yours even come up — accepted other weeks, declined offers, or let the window lapse.</p>
          <p>🔄 Of remaining competitors, <strong className="text-blue-700">{mc.avgAbsorbedElsewhere}</strong> get absorbed by other weeks they also wanted 🌊 — each one who takes a different week frees up yours.</p>
          <p className="pt-1 border-t border-stone-100">📄 <a href="https://sfrecpark.org/DocumentCenter/View/28472/Camp-Mather-WaitListCrosstab2026" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:text-blue-800 underline">Official SF Rec & Park Waitlist PDF</a></p>
        </div>
      )}
    </Card>
  );
}

// --- Feedback ---

const FORM_BASE = 'https://docs.google.com/forms/d/e/1FAIpQLSe752OjhbdSypi-pZYkvdGDkLjL7816Bb457sZ9Hmk63DbkVQ/viewform';
const FORM_ENTRY_RANK = 'entry.1018896596';
const FORM_ENTRY_PROBABILITY = 'entry.906568157';

function feedbackUrl(rank: number, probability: number): string {
  const params = new URLSearchParams({
    [FORM_ENTRY_RANK]: String(rank),
    [FORM_ENTRY_PROBABILITY]: String(probability),
  });
  return `${FORM_BASE}?${params.toString()}`;
}

function FeedbackPanel({ rank, probability }: { rank: number; probability: number }) {
  return (
    <Card className="p-4 text-center">
      <h3 className="font-semibold text-sm text-stone-800 mb-2">💬 Was this helpful?</h3>
      <p className="text-xs text-stone-500 mb-3">Your rank and probability will be pre-filled</p>
      <a
        href={feedbackUrl(rank, probability)}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-stone-800 text-white text-sm font-medium hover:bg-stone-900"
      >
        📮 Share feedback
      </a>
    </Card>
  );
}

// --- Main ---

function getRankFromUrl(): number | '' {
  const params = new URLSearchParams(window.location.search);
  const val = params.get('rank') || params.get('r');
  if (val) { const n = parseInt(val, 10); if (!isNaN(n) && n > 0) return n; }
  return '';
}

function updateUrl(rank: number | '') {
  const url = new URL(window.location.href);
  if (rank === '') url.searchParams.delete('rank'); else url.searchParams.set('rank', String(rank));
  window.history.replaceState({}, '', url.toString());
}

export default function MatherTracker() {
  const [userRank, setUserRank] = useState<number | ''>(getRankFromUrl);
  const [methodologyOpen, setMethodologyOpen] = useState(false);
  const results = useMemo(() => simulate(waitlistData as Family[]), []);
  const myStatus = results.find((f) => f.rank === userRank);
  const weekBreakdown = useMemo(() => userRank ? computeWeekBreakdown(userRank, waitlistData as Family[]) : [], [userRank]);
  const monteCarlo = useMemo(() => userRank ? monteCarloForFamily(userRank, waitlistData as Family[]) : null, [userRank]);
  const myWeeks = useMemo(() => weekBreakdown.length ? [...new Set(weekBreakdown.map((b) => b.week))].sort((a, b) => a - b) : [], [weekBreakdown]);
  const myWeekDemand = useMemo(() => computeWeekDemand(myWeeks, waitlistData as Family[]), [myWeeks]);
  const cabinDemand = useMemo(() => computeCabinDemand(waitlistData as Family[]), []);
  const factors = useMemo(() => buildFactors(weekBreakdown), [weekBreakdown]);
  const mySizes = [...new Set(weekBreakdown.map((b) => b.size))];

  return (
    <div className="min-h-screen bg-stone-50">
      <div className="p-5 max-w-2xl mx-auto font-sans space-y-4">

        {/* Hero */}
        <div className="text-center pt-2">
          <p className="text-3xl">🌲🏕️🌲</p>
          <h1 className="font-chalk text-3xl text-stone-800 mt-1">Magic Mather 2026</h1>
          <p className="text-stone-500 text-sm font-sans">🎯 Waitlist Probability Engine</p>
        </div>

        {/* About with flanking photos */}
        <div className="grid grid-cols-[80px_1fr_80px] sm:grid-cols-[100px_1fr_100px] gap-2 items-center">
          <div className="rounded-xl overflow-hidden bg-stone-200 h-full">
            <img src="/kevin-cabin.png" alt="Cabin at Camp Mather" className="w-full h-full object-cover" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
          </div>
          <div className="px-4 py-4 bg-amber-50/80 border border-amber-200/60 rounded-xl text-center">
          <p className="font-chalk text-xl text-amber-900">🏊🏽‍♂️ Camp Mather 🌊</p>
          <p className="text-sm text-amber-800 mt-1 leading-relaxed">
            San Francisco's Family Camp since 1924 🌲 Swimming, hiking, campfires, stargazing, ice cream, and zero cell service 📵
            From a 6 year returning mom who spaced this year 🤦‍♀️
          </p>
          <p className="text-sm text-amber-700 mt-2">🦌 Punch in your waitlist number to see your odds ✨</p>
          <p className="text-sm text-stone-600 mt-2">
            😊 Unofficial fan project — not affiliated with SF Rec & Park.
            Estimates based on <a href="https://sfrecpark.org/DocumentCenter/View/28472/Camp-Mather-WaitListCrosstab2026" target="_blank" rel="noopener noreferrer" className="underline">public waitlist data</a> and{' '}
            <button type="button" className="underline hover:text-stone-800" onClick={() => { setMethodologyOpen(true); document.getElementById('methodology')?.scrollIntoView({ behavior: 'smooth' }); }}>statistical modeling</button>.
          </p>
          </div>
          <div className="rounded-xl overflow-hidden bg-stone-200 h-full">
            <img src="/falls.jpg" alt="Waterfall near Camp Mather" className="w-full h-full object-cover" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
          </div>
        </div>

        {/* Input */}
        <Card className="p-4">
          <label className="block font-semibold text-sm text-stone-700 mb-2">🔍 Enter your Waitlist Number</label>
          <input type="number" className="w-full p-3 border border-stone-300 rounded-lg focus:ring-2 focus:ring-emerald-500 outline-none text-lg font-mono"
            placeholder="e.g. 832" value={userRank}
            onChange={(e) => { const rank = e.target.value === '' ? '' : parseInt(e.target.value, 10); setUserRank(rank); updateUrl(rank); }} />
        </Card>

        {myStatus && monteCarlo && (
          <>
            {/* Probability */}
            {(() => { const s = pctStyle(monteCarlo.probability); return (
              <Card className={`p-5 border-2 ${s.border} ${s.bg}`}>
                <div className="flex items-baseline gap-3 mb-1">
                  <span className={`text-4xl font-bold font-mono ${s.text}`}>{monteCarlo.probability}%</span>
                  <h2 className="font-bold text-lg text-stone-800">chance of getting a cabin 🤞</h2>
                </div>
                <p className="text-xs text-stone-500">
                  🏕️ #{myStatus.rank} · 🗓️ {myWeeks.length} week{myWeeks.length !== 1 ? 's' : ''} · 🛖 {mySizes.join(', ')} · 🎣 {weekBreakdown.length} options
                </p>
              </Card>
            ); })()}

            {/* Methodology */}
            <div id="methodology"><MethodologySection mc={monteCarlo} breakdown={weekBreakdown} waitlist={waitlistData as Family[]} status={myStatus} forceOpen={methodologyOpen} /></div>

            {/* Factors */}
            {factors.length > 0 && (
              <Card className="p-4">
                <h3 className="font-semibold text-xs text-stone-500 uppercase tracking-wider mb-2">💡 Factors</h3>
                <div className="space-y-1.5">
                  {factors.map((f, i) => (
                    <div key={i} className={`flex gap-2 text-xs py-1.5 px-2.5 rounded-lg ${f.type === 'positive' ? 'bg-emerald-50 text-emerald-800' : f.type === 'negative' ? 'bg-red-50 text-red-800' : 'bg-blue-50 text-blue-800'}`}>
                      <span className="shrink-0">{f.emoji}</span><span>{f.text}</span>
                    </div>
                  ))}
                </div>
              </Card>
            )}

            {/* Week cards */}
            <h2 className="font-bold text-base text-stone-800 pt-1">🗓️ Your Weeks</h2>
            {myWeeks.map((week) => {
              const wbd = weekBreakdown.filter((b) => b.week === week);
              const dem = myWeekDemand.find((d) => d.week === week);
              const ct = monteCarlo.assignedWeekCounts[week] || 0;
              return dem ? <WeekCard key={week} week={week} breakdowns={wbd} demand={dem}
                mcWeekPct={Math.round((ct / monteCarlo.runs) * 100)}
                independentPct={monteCarlo.weekIndependentProbability[week] ?? 0} /> : null;
            })}

            {/* Share */}
            <button type="button"
              className="w-full py-2.5 rounded-xl border border-stone-200 bg-white text-xs font-medium text-stone-600 hover:bg-stone-50"
              onClick={() => {
                const weekLines = myWeeks.map((w) => {
                  const bds = weekBreakdown.filter((b) => b.week === w);
                  const indyPct = monteCarlo.weekIndependentProbability[w] ?? 0;
                  return `  ${weekLabel(w)}: ${indyPct}% — ${bds.map((b) => `${b.size} (#${b.effectiveRank}, ${b.familiesAhead} ahead, ~${b.expectedCancellations} may cancel)`).join(', ')}`;
                }).join('\n');
                const text = [`🏕️ Camp Mather 2026 — Waitlist #${myStatus.rank}`, `🤞 ${monteCarlo.probability}% chance`, `🛖 ${mySizes.join(', ')} · ${myWeeks.length} weeks · ${weekBreakdown.length} options`, '', '🗓️ Per-week:', weekLines, '', `🎯 ${window.location.origin}${window.location.pathname}?rank=${myStatus.rank}`].join('\n');
                if (navigator.share) navigator.share({ text }).catch(() => {}); else { navigator.clipboard.writeText(text); alert('📋 Copied!'); }
              }}>📤 Share results</button>

            {/* Feedback */}
            <FeedbackPanel rank={myStatus.rank} probability={monteCarlo.probability} />
          </>
        )}

        {/* Overall demand */}
        <div>
          <h2 className="font-bold text-base text-stone-800 mb-3">🏠 Overall Cabin Demand</h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {cabinDemand.map((d) => (
              <Card key={d.size} className="p-3">
                <span className="block text-[11px] text-stone-400 uppercase tracking-wider">{d.size}</span>
                <span className="block text-xl font-mono font-bold mt-0.5">{d.totalFamilies}</span>
                <span className="block text-[11px] text-stone-400">families waitlisted</span>
                <div className="mt-1.5 pt-1.5 border-t border-stone-100">
                  <span className="block text-[11px] text-stone-400">{d.totalCabins} cabins (all full)</span>
                  <span className="block text-[11px] text-stone-400">~{d.expectedCancellations} expected cancellations</span>
                  <span className="block text-[11px] mt-0.5 font-medium">
                    {d.totalFamilies > d.expectedCancellations
                      ? <span className="text-red-600">{Math.round(d.totalFamilies / d.expectedCancellations)}x more waitlisted than expected openings</span>
                      : <span className="text-emerald-600">More expected openings than waitlisted families</span>}
                  </span>
                </div>
              </Card>
            ))}
          </div>
        </div>

        {/* Bottom photos */}
        <div className="-mx-5 overflow-hidden"><img src="/meadow.jpg" alt="Meadow" className="w-full h-44 object-cover" onError={(e) => { (e.target as HTMLImageElement).parentElement!.style.display = 'none'; }} /></div>

        {/* Footer */}
        <footer className="text-center text-xs text-stone-400 pb-2 space-y-1">
          <p>Like this? Drop me a line:</p>
          <button type="button" className="text-blue-600 hover:text-blue-800 font-medium" onClick={() => { window.location.href = `mailto:${'banane'}@${'gmail.com'}`; }}>banane [at] gmail.com</button>
          <p>🔄 Waitlist data scraped {new Date(scrapedAt ?? __BUILD_TIME__).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} at {new Date(scrapedAt ?? __BUILD_TIME__).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} · Checked daily at 8 AM PT</p>
          <p>&copy; 2026 banane.com</p>
        </footer>

        {/* Meadow */}
        <div className="-mx-5 -mb-5 overflow-hidden"><img src="/birch-lake.jpg" alt="Birch Lake" className="w-full object-cover" onError={(e) => { (e.target as HTMLImageElement).parentElement!.style.display = 'none'; }} /></div>
      </div>
    </div>
  );
}
