import React from 'react';
import { ArrowLeft } from 'lucide-react';
import type { NavSection } from './HomeView';

interface PhasePlaceholderViewProps {
  title: string;
  phaseNumber: number;
  description: string;
  onBackHome: (section: NavSection) => void;
}

export const PhasePlaceholderView: React.FC<PhasePlaceholderViewProps> = ({
  title,
  phaseNumber,
  description,
  onBackHome,
}) => {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-6 sm:p-8 max-w-2xl">
      <div className="text-sm font-medium text-slate-500">Phase {phaseNumber} Module</div>
      <h1 className="mt-1 font-display text-2xl font-bold text-slate-900">{title}</h1>
      <p className="mt-3 text-base text-slate-600 leading-relaxed">{description}</p>
      <button
        type="button"
        onClick={() => onBackHome('home')}
        className="mt-6 inline-flex min-h-[48px] items-center gap-2 rounded-xl bg-slate-900 px-5 py-2.5 text-sm font-semibold text-white hover:bg-slate-800"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        <span>Back to Home</span>
      </button>
    </div>
  );
};
