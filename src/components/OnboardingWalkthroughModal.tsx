import React, { useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ClipboardList,
  Lock,
  ShieldCheck,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import { ROLE_LABELS, type Role } from '../shared/types';

interface OnboardingWalkthroughModalProps {
  role: Role;
  fullName: string;
  onClose: () => void;
}

interface SlideItem {
  title: string;
  body: string;
  tip: string;
  icon: React.ComponentType<{ className?: string }>;
}

const SLIDES_BY_ROLE: Record<Role, SlideItem[]> = {
  DRIVER: [
    {
      title: 'Your 4 Yard Buttons',
      body: 'From the Home screen, tap "Hire Out a Vehicle" when a customer takes a car, "Return a Hired Vehicle" when they bring it back, or "Send on Errand" and "Errand Returned" for staff runs.',
      tip: 'You never need to type today’s date or time — the server records it automatically.',
      icon: ClipboardList,
    },
    {
      title: 'Check Odometer & Fuel Gauge',
      body: 'Always read the exact whole number on the dashboard odometer and tap the picture on the fuel bar that matches the vehicle’s needle.',
      tip: 'If the car moved since its last recorded trip, tell your Supervisor before driving off.',
      icon: AlertTriangle,
    },
    {
      title: 'Saved Trips Are Permanent',
      body: 'Once you press Confirm & Save, the trip cannot be edited or deleted. Review the summary screen carefully before saving.',
      tip: 'Made a mistake after saving? Never try to hide it — ask your Supervisor to add a Correction Note.',
      icon: Lock,
    },
    {
      title: 'Works Even Without Internet',
      body: 'If the yard Wi-Fi or data drops, saving a trip puts it in "Waiting to send" on your screen and uploads it automatically as soon as connection returns.',
      tip: 'Tap Help anytime in the menu to review these steps.',
      icon: CheckCircle2,
    },
  ],
  SUPERVISOR: [
    {
      title: 'Yard Oversight & Drivers Directory',
      body: 'You can record trips like a Driver, add or update Drivers, and log routine vehicle condition notes. Grounding a vehicle or returning a Grounded vehicle requires Fleet Manager or Admin authorization.',
      tip: 'Vehicles marked "Grounded" or "Accident" cannot be booked out on trips.',
      icon: ClipboardList,
    },
    {
      title: 'Automatic Loss-Control Flags',
      body: 'Fleet Secure automatically flags Unrecorded Mileage Gaps, Fuel Mismatches (estimated litres vs gauge change), Overdue Hires, Offline Delays, and Expiring Licences.',
      tip: 'Check the Alerts inbox in the top bar for high-priority red alerts.',
      icon: AlertTriangle,
    },
    {
      title: 'Corrections & Audit Verification',
      body: 'Open any trip to add a Correction Entry with a required reason while keeping the original numbers visible. Use Audit Log -> Verify Audit Trail to prove no rows were altered.',
      tip: 'Every action across the whole yard is locked into a SHA-256 hash chain.',
      icon: ShieldCheck,
    },
    {
      title: 'PDF & Excel Reports',
      body: 'Open Reports to download CSV files for Excel or printable PDF reports stamped with your company name, phone numbers, and address.',
      tip: 'You can replay this guide anytime from Help.',
      icon: CheckCircle2,
    },
  ],
  FLEET_MANAGER: [
    {
      title: 'Vehicle Directory & Condition Control',
      body: 'You have full control over the Vehicles Directory. Only Fleet Managers and Admins can mark a vehicle Grounded, restore a Grounded vehicle to active service, or clear vehicles back to Good / Very Good condition.',
      tip: 'Drivers, Staff Accounts, and Settings remain read-only or Admin-managed.',
      icon: ClipboardList,
    },
    {
      title: 'Mechanical & Service History + Next Service km',
      body: 'Open Fleet Maintenance to log mechanical repairs and full services, and track Next Service Due odometer readings across every vehicle.',
      tip: 'Vehicles within 1,000 km of service automatically highlight as Due Soon.',
      icon: AlertTriangle,
    },
    {
      title: 'Garage Visits & Parts Purchases',
      body: 'Schedule Garage Visits and submit Parts & Service Kits purchase requests (selecting from the Fleet Database or adding a new vehicle with quotation attachment) for Admin authorization.',
      tip: 'Admins receive an alert right away and approve or authorize from Fleet Maintenance.',
      icon: ShieldCheck,
    },
    {
      title: 'Live Fleet Alerts',
      body: 'Receive vehicle status, maintenance, and Admin authorization updates in your Alerts inbox and device notifications.',
      tip: 'Open Help anytime to replay this guide.',
      icon: CheckCircle2,
    },
  ],
  ADMIN: [
    {
      title: 'Staff Accounts & Roles',
      body: 'Use Settings -> Staff Accounts & Roles to create Driver, Supervisor, Fleet Manager / Supervisor, or Admin logins, disable accounts, or reset forgotten PINs.',
      tip: 'New or reset accounts are forced to choose their own private PIN on first sign-in.',
      icon: SlidersHorizontal,
    },
    {
      title: 'Company Profile & Fuel Rules',
      body: 'Set your company name, address, Economy/Heavy tank sizes, km/litre rates, fuel mismatch threshold %, and overdue hire hour limit in Settings.',
      tip: 'All PDF reports and fuel calculations immediately use the values saved in Settings.',
      icon: ClipboardList,
    },
    {
      title: 'Alert Recipients',
      body: 'Configure Supervisor and Admin Email addresses or WhatsApp numbers under Settings -> Notification Recipients so alerts reach managers right away.',
      tip: 'Every change to users, settings, or recipients is permanently logged.',
      icon: AlertTriangle,
    },
    {
      title: 'Tamper-Evident Audit Trail',
      body: 'No one — including Admins — can edit or delete saved trips or audit log rows. Use Verify Audit Trail in Audit Log anytime for compliance checks.',
      tip: 'Open Help & Staff Guide anytime to review workflows or share guidance with staff.',
      icon: ShieldCheck,
    },
  ],
};

export const OnboardingWalkthroughModal: React.FC<OnboardingWalkthroughModalProps> = ({
  role,
  fullName,
  onClose,
}) => {
  const slides = SLIDES_BY_ROLE[role];
  const [step, setStep] = useState(0);
  const current = slides[step];
  const Icon = current.icon;
  const isLast = step === slides.length - 1;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="walkthrough-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-blue-950/60 backdrop-blur-[1px] p-4"
    >
      <div className="w-full max-w-lg rounded-2xl border border-blue-200 bg-white p-6 shadow-xl space-y-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-xs font-bold uppercase tracking-wider text-cyan-700">
              Quick Start Guide · {ROLE_LABELS[role]}
            </div>
            <h2 id="walkthrough-title" className="mt-1 font-display text-xl font-bold text-blue-950">
              Welcome, {fullName}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Skip guide"
            className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-blue-600 hover:bg-cyan-50"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="rounded-2xl border border-blue-200 bg-blue-50/50 p-5 space-y-3">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-blue-700 to-cyan-500 text-white shadow-sm">
              <Icon className="h-5 w-5" aria-hidden="true" />
            </div>
            <div>
              <div className="text-xs font-mono text-cyan-700 font-semibold">
                Step {step + 1} of {slides.length}
              </div>
              <h3 className="text-lg font-bold text-blue-950">{current.title}</h3>
            </div>
          </div>

          <p className="text-base text-slate-700 leading-relaxed">{current.body}</p>

          <div className="rounded-xl border border-cyan-200 bg-white p-3 text-sm text-slate-700">
            <strong className="text-blue-950">Tip:</strong> {current.tip}
          </div>
        </div>

        {/* Step dots */}
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            {slides.map((_, idx) => (
              <button
                key={idx}
                type="button"
                onClick={() => setStep(idx)}
                aria-label={`Go to step ${idx + 1}`}
                className={`h-2.5 rounded-full transition-all ${
                  idx === step ? 'w-7 bg-gradient-to-r from-blue-700 to-cyan-500' : 'w-2.5 bg-blue-200'
                }`}
              />
            ))}
          </div>

          <div className="flex items-center gap-2">
            {step > 0 && (
              <button
                type="button"
                onClick={() => setStep((s) => s - 1)}
                className="cyan-glow-outline min-h-[44px] rounded-xl border border-blue-200 bg-white px-4 text-sm font-semibold text-blue-900"
              >
                Back
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                if (isLast) {
                  onClose();
                } else {
                  setStep((s) => s + 1);
                }
              }}
              className="cyan-glow-btn inline-flex min-h-[44px] items-center gap-1.5 rounded-xl px-5 text-sm font-semibold"
            >
              <span>{isLast ? 'Finish & Start' : 'Next Step'}</span>
              {!isLast && <ArrowRight className="h-4 w-4" aria-hidden="true" />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
