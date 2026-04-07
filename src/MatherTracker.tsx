import { useState, useMemo } from 'react';
import { simulate, type SimulationResult } from '../mather-engine';
import { type Family } from '../constants';
import waitlistData from '../public/data.json';

export default function MatherTracker() {
  const [userRank, setUserRank] = useState<number | ''>('');

  const results = useMemo(() => simulate(waitlistData as Family[]), []);

  const myStatus: SimulationResult | undefined = results.find(
    (f) => f.rank === userRank,
  );

  const familiesAheadWhoNeedMyCabin = useMemo(() => {
    if (!myStatus || !userRank) return 0;
    return results.filter(
      (f) =>
        f.rank < userRank &&
        !f.isSuccessful &&
        f.preferences.some((p) => p.size === myStatus.preferences[0]?.size),
    ).length;
  }, [userRank, results, myStatus]);

  return (
    <div className="p-6 max-w-2xl mx-auto font-sans">
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

      {myStatus && (
        <div className="mt-8 space-y-4">
          <div
            className={`p-6 rounded-xl border-2 ${myStatus.isSuccessful ? 'bg-green-50 border-green-200' : 'bg-orange-50 border-orange-200'}`}
          >
            <h2 className="text-xl font-bold mb-2">
              {myStatus.isSuccessful
                ? 'Likely Success!'
                : 'High Competition'}
            </h2>
            <p className="text-gray-700">
              {myStatus.isSuccessful
                ? `The simulation predicts you will get a ${myStatus.assignedSize} cabin in Week ${myStatus.assignedWeek}.`
                : 'Based on current inventory, families above you will likely fill the cabins you requested.'}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="bg-white p-4 border rounded-lg shadow-sm">
              <span className="block text-gray-500 text-xs uppercase tracking-wider">
                Official Rank
              </span>
              <span className="text-2xl font-mono">#{myStatus.rank}</span>
            </div>
            <div className="bg-white p-4 border rounded-lg shadow-sm">
              <span className="block text-gray-500 text-xs uppercase tracking-wider">
                Effective Rank
              </span>
              <span className="text-2xl font-mono text-blue-600">
                #{familiesAheadWhoNeedMyCabin + 1}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
