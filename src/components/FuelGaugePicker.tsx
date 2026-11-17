import React from 'react';
import { FUEL_FRACTIONS, FUEL_LEVELS, type FuelLevel } from '../shared/types';

interface FuelGaugePickerProps {
  label: string;
  value: FuelLevel | '';
  onChange: (val: FuelLevel) => void;
}

// Display from Empty (left/bottom) to Full (right/top) for intuitive reading
const ORDERED_LEVELS: FuelLevel[] = [...FUEL_LEVELS].reverse();

export const FuelGaugePicker: React.FC<FuelGaugePickerProps> = ({
  label,
  value,
  onChange,
}) => {
  const pct = value ? Math.round(FUEL_FRACTIONS[value] * 100) : null;

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="block text-sm font-semibold text-slate-800">{label}</span>
        <span className="text-sm font-mono tabular-nums font-semibold text-slate-900">
          {value ? `${value} (${pct}%)` : 'Tap a level below'}
        </span>
      </div>

      {/* Visual gauge bar */}
      <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
        <div className="flex items-center justify-between text-xs font-semibold text-slate-500 mb-1.5">
          <span>E (Empty)</span>
          <span>1/2</span>
          <span>F (Full)</span>
        </div>
        <div className="h-3 w-full overflow-hidden rounded-full bg-slate-200">
          <div
            className={`h-full transition-all duration-150 ${
              pct === null
                ? 'w-0 bg-slate-400'
                : pct <= 20
                ? 'bg-red-600'
                : pct <= 45
                ? 'bg-amber-500'
                : 'bg-emerald-600'
            }`}
            style={{ width: `${pct ?? 0}%` }}
          />
        </div>
      </div>

      {/* 13 large tappable buttons */}
      <div className="grid grid-cols-4 sm:grid-cols-7 gap-2">
        {ORDERED_LEVELS.map((lvl) => {
          const selected = value === lvl;
          const levelPct = Math.round(FUEL_FRACTIONS[lvl] * 100);
          return (
            <button
              key={lvl}
              type="button"
              onClick={() => onChange(lvl)}
              aria-pressed={selected}
              className={`min-h-[52px] rounded-xl border px-2 py-2 flex flex-col items-center justify-center transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900 ${
                selected
                  ? 'border-slate-900 bg-slate-900 text-white'
                  : 'border-slate-300 bg-white text-slate-900 hover:bg-slate-50'
              }`}
            >
              <span className="text-sm font-bold leading-tight">{lvl}</span>
              <span
                className={`text-[11px] font-mono tabular-nums ${
                  selected ? 'text-slate-300' : 'text-slate-500'
                }`}
              >
                {levelPct}%
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
};
