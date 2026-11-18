import React, { useState } from 'react';
import {
  AlertTriangle,
  BookOpen,
  ChevronDown,
  ChevronUp,
  HelpCircle,
  Lock,
  PlayCircle,
  ShieldCheck,
  WifiOff,
} from 'lucide-react';
import { ROLE_LABELS, type Role } from '../shared/types';

interface HelpViewProps {
  userRole: Role;
  onReplayWalkthrough: () => void;
}

const STEP_BY_STEP_GUIDES = [
  {
    id: 'hire-out',
    title: 'How to Hire Out a Vehicle (Client Rental)',
    steps: [
      'On Home, tap "Hire Out a Vehicle".',
      'Select the Driver taking the car and type the Client Name.',
      'Choose the Vehicle leaving the yard. Grounded or already-out vehicles are hidden automatically.',
      'Read the dashboard odometer and enter the exact Mileage when leaving.',
      'Look at the fuel gauge needle and tap the matching level (Full, 3/4, 1/2, etc.).',
      'Enter who completed the opening checklist, tap "Review & Save", check everything carefully, and confirm.',
    ],
  },
  {
    id: 'return-vehicle',
    title: 'How to Record a Vehicle Return (Hire or Errand)',
    steps: [
      'On Home, tap "Return a Hired Vehicle" (or "Errand Returned"), OR tap "Record Return" next to the vehicle under Ongoing Trips.',
      'Confirm the vehicle and driver shown in "What went out".',
      'Enter the exact Mileage when returning (must be equal to or higher than leaving mileage).',
      'Tap the current Fuel when returning level.',
      'Check the automatic Total Mileage and Estimated Fuel figures.',
      'Enter who did the closing checklist, tap "Review & Save Return", and confirm.',
    ],
  },
  {
    id: 'errand',
    title: 'How to Send a Vehicle on a Staff Errand',
    steps: [
      'On Home, tap "Send on Errand".',
      'Select the Staff Driver, then enter both the Destination (e.g. ZIMRA, Parts Supplier) and the Reason.',
      'Pick the vehicle, enter Mileage when leaving, and tap Fuel when leaving.',
      'Review and save. When the staff member gets back, tap "Errand Returned" to close the trip.',
    ],
  },
  {
    id: 'corrections',
    title: 'How Supervisors Fix Mistakes (Correction Entries)',
    steps: [
      'Saved trips can never be edited or deleted—this prevents tampering.',
      'If a wrong mileage or fuel level was saved, a Supervisor or Admin opens Trips and taps that trip.',
      'Tap "Add Correction Note", pick which part of the trip had the mistake (Trip Info, Leaving, or Returning).',
      'Enter the corrected value and write a clear Reason (at least 5 characters), then save.',
      'The original number stays visible alongside the new Correction Entry so auditors see both.',
    ],
  },
];

const FAQS = [
  {
    q: 'I made a mistake after saving a trip. What should I do now?',
    a: 'Do not panic and do not create a duplicate trip. Saved records are permanently locked so nobody can alter the record book. Tell your Supervisor (Loss Control) right away—they can open the trip and attach an official Correction Entry showing the right number and the reason.',
  },
  {
    q: 'Why can’t I type the date or time myself?',
    a: 'Dates and times are locked and set by the server when you press Save. This prevents back-dating trips. All times are shown in Harare time (CAT).',
  },
  {
    q: 'What happens if the yard has no internet connection?',
    a: 'When you are offline, tapping Confirm & Save places the trip in your "Waiting to send" list on the Home screen. As soon as internet comes back, Fleet Secure uploads it automatically. If the upload happens more than 10 minutes after you recorded it, the system notes "Offline Delay" so your Supervisor knows why.',
  },
  {
    q: 'Why is a vehicle missing from the Hire Out dropdown?',
    a: 'Only active vehicles that are currently parked in the yard AND in roadworthy condition appear. If a vehicle is currently out on another trip, or marked "Accident" or "Grounded" by a Supervisor, it cannot leave until returned or cleared.',
  },
  {
    q: 'What do the red or amber Trip Flags mean?',
    a: 'UNRECORDED_GAP means the odometer changed since the last trip ended. FUEL_MISMATCH means fuel used on the gauge differs sharply from distance driven. OVERDUE means a hire has been out longer than the hours limit in Settings. LICENCE_EXPIRING means the driver’s licence is expired or expiring within 30 days.',
  },
];

export const HelpView: React.FC<HelpViewProps> = ({ userRole, onReplayWalkthrough }) => {
  const [openFaq, setOpenFaq] = useState<number | null>(0);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="font-display text-2xl font-bold text-blue-950">Help &amp; Staff Guide</h1>
          <p className="mt-1 text-base text-slate-600">
            Plain-English instructions for your role ({ROLE_LABELS[userRole]}).
          </p>
        </div>

        <button
          type="button"
          onClick={onReplayWalkthrough}
          className="cyan-glow-btn inline-flex min-h-[48px] items-center gap-2 rounded-xl px-5 text-sm font-semibold whitespace-nowrap shrink-0"
        >
          <PlayCircle className="h-5 w-5" aria-hidden="true" />
          <span>Replay Welcome Guide</span>
        </button>
      </div>

      {/* Golden Rules */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className="cyan-glow-card rounded-2xl border border-blue-200/80 bg-white p-5 space-y-2">
          <div className="flex items-center gap-2 font-semibold text-blue-950">
            <Lock className="h-5 w-5 text-blue-600" aria-hidden="true" />
            <span>Permanent Record Book</span>
          </div>
          <p className="text-sm text-slate-600 leading-relaxed">
            Every OUT and IN entry is locked once saved. Mistakes are fixed only with Supervisor Correction Notes.
          </p>
        </div>

        <div className="cyan-glow-card rounded-2xl border border-blue-200/80 bg-white p-5 space-y-2">
          <div className="flex items-center gap-2 font-semibold text-blue-950">
            <WifiOff className="h-5 w-5 text-cyan-600" aria-hidden="true" />
            <span>Offline Queue Ready</span>
          </div>
          <p className="text-sm text-slate-600 leading-relaxed">
            If connection drops, trips save as &ldquo;Waiting to send&rdquo; and sync automatically when signal returns.
          </p>
        </div>

        <div className="cyan-glow-card rounded-2xl border border-blue-200/80 bg-white p-5 space-y-2">
          <div className="flex items-center gap-2 font-semibold text-blue-950">
            <ShieldCheck className="h-5 w-5 text-blue-700" aria-hidden="true" />
            <span>Automatic Loss Checks</span>
          </div>
          <p className="text-sm text-slate-600 leading-relaxed">
            Mileage gaps, unexpected fuel drops, and overdue hires raise instant flags for Loss Control.
          </p>
        </div>
      </div>

      {/* Step-by-Step Guides */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <BookOpen className="h-5 w-5 text-cyan-600" aria-hidden="true" />
          <h2 className="text-lg font-bold text-blue-950">Step-by-Step Yard Guides</h2>
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {STEP_BY_STEP_GUIDES.map((guide) => (
            <div
              key={guide.id}
              className="cyan-glow-card rounded-2xl border border-blue-200/80 bg-white p-5 space-y-3"
            >
              <h3 className="text-base font-bold text-blue-950">{guide.title}</h3>
              <ol className="list-decimal pl-5 space-y-2 text-sm text-slate-700 leading-relaxed">
                {guide.steps.map((s, idx) => (
                  <li key={idx}>{s}</li>
                ))}
              </ol>
            </div>
          ))}
        </div>
      </section>

      {/* Flag Quick Reference */}
      <section className="rounded-2xl border border-blue-200/80 bg-white p-5 space-y-3">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-5 w-5 text-red-700" aria-hidden="true" />
          <h2 className="text-lg font-bold text-blue-950">Understanding Alert Flags</h2>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="rounded-xl border border-red-200 bg-red-50/70 p-3.5 text-sm">
            <div className="font-mono font-bold text-red-800">UNRECORDED_GAP</div>
            <p className="mt-1 text-slate-700">
              Leaving odometer does not match the vehicle’s last saved mileage. Check if an unlogged trip occurred.
            </p>
          </div>
          <div className="rounded-xl border border-red-200 bg-red-50/70 p-3.5 text-sm">
            <div className="font-mono font-bold text-red-800">FUEL_MISMATCH</div>
            <p className="mt-1 text-slate-700">
              Fuel missing on the gauge does not match expected fuel for the kilometres driven.
            </p>
          </div>
          <div className="rounded-xl border border-red-200 bg-red-50/70 p-3.5 text-sm">
            <div className="font-mono font-bold text-red-800">OVERDUE</div>
            <p className="mt-1 text-slate-700">
              Client hire has stayed out past the allowed hours configured in Settings.
            </p>
          </div>
          <div className="rounded-xl border border-amber-200 bg-amber-50/70 p-3.5 text-sm">
            <div className="font-mono font-bold text-amber-900">OFFLINE_DELAY / LICENCE_EXPIRING</div>
            <p className="mt-1 text-slate-700">
              Recorded offline and synced &gt;10 mins later, or the assigned driver’s licence is expiring/expired.
            </p>
          </div>
        </div>
      </section>

      {/* FAQ Accordion */}
      <section className="rounded-2xl border border-blue-200/80 bg-white overflow-hidden">
        <div className="border-b border-blue-100 bg-blue-50/40 px-5 py-4 flex items-center gap-2">
          <HelpCircle className="h-5 w-5 text-cyan-600" aria-hidden="true" />
          <h2 className="text-lg font-bold text-blue-950">Frequently Asked Questions</h2>
        </div>
        <div className="divide-y divide-blue-100">
          {FAQS.map((faq, idx) => {
            const open = openFaq === idx;
            return (
              <div key={idx}>
                <button
                  type="button"
                  onClick={() => setOpenFaq(open ? null : idx)}
                  className="flex w-full min-h-[56px] items-center justify-between gap-4 px-5 py-3 text-left transition-colors hover:bg-cyan-50/50"
                >
                  <span className="text-base font-semibold text-blue-950">{faq.q}</span>
                  {open ? (
                    <ChevronUp className="h-5 w-5 shrink-0 text-cyan-600" aria-hidden="true" />
                  ) : (
                    <ChevronDown className="h-5 w-5 shrink-0 text-blue-500" aria-hidden="true" />
                  )}
                </button>
                {open && (
                  <div className="px-5 pb-4 text-sm text-slate-700 leading-relaxed">{faq.a}</div>
                )}
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
};
