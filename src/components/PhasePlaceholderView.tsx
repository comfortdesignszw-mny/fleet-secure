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
    <div className="rounded-2xl border border-blue-200/80 bg-white p-6 sm:p-8 max-w-2xl shadow-xs">
      <div className="text-sm font-medium text-cyan-700">Phase {phaseNumber} Module</div>
      <h1 className="mt-1 font-display text-2xl font-bold text-blue-950">{title}</h1>
      <p className="mt-3 text-base text-slate-600 leading-relaxed">{description}</p>
      <button
        type="button"
        onClick={() => onBackHome('home')}
        className="cyan-glow-btn mt-6 inline-flex min-h-[48px] items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-semibold"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        <span>Back to Home</span>
      </button>
    </div>
  );
};
