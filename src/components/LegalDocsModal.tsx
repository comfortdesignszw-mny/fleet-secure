import React, { useEffect } from 'react';
import { FileText, Shield, X } from 'lucide-react';

export type LegalDocType = 'terms' | 'privacy';

interface LegalDocsModalProps {
  openDoc: LegalDocType | null;
  onClose: () => void;
  onSwitchDoc: (doc: LegalDocType) => void;
}

export const LegalDocsModal: React.FC<LegalDocsModalProps> = ({
  openDoc,
  onClose,
  onSwitchDoc,
}) => {
  useEffect(() => {
    if (!openDoc) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [openDoc, onClose]);

  if (!openDoc) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="legal-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-blue-950/60 backdrop-blur-xs p-3 sm:p-5 overflow-y-auto"
    >
      <div className="my-auto flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-blue-200 bg-white shadow-2xl">
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-blue-100 bg-gradient-to-r from-blue-50 via-white to-cyan-50 px-5 py-4">
          <div className="flex items-center gap-2.5">
            <span className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-blue-700 to-cyan-500 text-white shadow-sm">
              {openDoc === 'terms' ? (
                <FileText className="h-4.5 w-4.5" aria-hidden="true" />
              ) : (
                <Shield className="h-4.5 w-4.5" aria-hidden="true" />
              )}
            </span>
            <div>
              <h2 id="legal-modal-title" className="font-display text-lg font-bold text-blue-950">
                {openDoc === 'terms' ? 'Terms of Use' : 'Privacy Policy'}
              </h2>
              <p className="text-xs text-slate-600">
                Fleet Secure Application Software · Effective November 2026
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Close legal document"
            className="flex h-10 w-10 items-center justify-center rounded-xl border border-blue-200 bg-white text-slate-600 hover:bg-blue-50 hover:text-blue-950"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Document Switcher */}
        <div className="flex gap-2 border-b border-blue-100 bg-slate-50/70 px-5 py-2.5">
          <button
            type="button"
            onClick={() => onSwitchDoc('terms')}
            className={`inline-flex min-h-[38px] items-center gap-1.5 rounded-xl px-3.5 text-xs sm:text-sm font-semibold transition-all ${
              openDoc === 'terms'
                ? 'cyan-glow-active'
                : 'border border-blue-200 bg-white text-blue-900 hover:bg-blue-50'
            }`}
          >
            <FileText className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Terms of Use</span>
          </button>
          <button
            type="button"
            onClick={() => onSwitchDoc('privacy')}
            className={`inline-flex min-h-[38px] items-center gap-1.5 rounded-xl px-3.5 text-xs sm:text-sm font-semibold transition-all ${
              openDoc === 'privacy'
                ? 'cyan-glow-active'
                : 'border border-blue-200 bg-white text-blue-900 hover:bg-blue-50'
            }`}
          >
            <Shield className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Privacy Policy</span>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-5 text-sm leading-relaxed text-slate-700 space-y-5">
          {openDoc === 'terms' ? (
            <>
              <p className="rounded-xl border border-blue-100 bg-blue-50/50 p-3.5 text-xs sm:text-sm text-blue-950">
                Please read these Terms of Use carefully before signing in to <strong>Fleet Secure</strong>{' '}
                (&ldquo;the Application Software&rdquo;). By entering your credentials and logging in, you
                acknowledge and agree to be bound by these Terms on behalf of yourself and your
                organization.
              </p>

              <section className="space-y-1.5">
                <h3 className="font-display text-base font-bold text-blue-950">
                  1. Authorized Access &amp; Account Credentials
                </h3>
                <p>
                  Access to Fleet Secure is strictly restricted to authorized personnel (Drivers,
                  Supervisors, Fleet Managers, and Administrators) provisioned by an organization
                  Administrator. You are solely responsible for safeguarding your username, PIN, or
                  password.
                </p>
                <ul className="list-disc pl-5 space-y-1 text-slate-600">
                  <li>
                    Users issued with temporary login credentials must sign in promptly and replace
                    their temporary PIN/password with a private secret known only to them.
                  </li>
                  <li>
                    Sharing accounts, signing in under another employee&apos;s identity, or attempting to
                    bypass role-based access controls (RBAC) or row-level security (RLS) is strictly
                    prohibited.
                  </li>
                  <li>
                    Repeated failed login attempts automatically trigger temporary account lockouts to
                    protect fleet records.
                  </li>
                </ul>
              </section>

              <section className="space-y-1.5">
                <h3 className="font-display text-base font-bold text-blue-950">
                  2. Accurate Fleet, Trip &amp; Checklist Records
                </h3>
                <p>
                  All Trip Out/In entries, odometer readings, fuel/battery gauge selections, driver KYC
                  records, and Digital Vehicle Checklists must reflect true and verified vehicle states
                  at the time of dispatch, check-in, or return.
                </p>
                <ul className="list-disc pl-5 space-y-1 text-slate-600">
                  <li>
                    For <strong>Renter</strong> checklists, initial sign-off records check-out by the
                    Renter/Client and Company Representative, and closing sign-off records check-in on
                    return.
                  </li>
                  <li>
                    For <strong>Owner</strong> checklists, initial sign-off records check-in by the
                    Owner and Company Representative, and closing sign-off records check-out upon
                    release.
                  </li>
                  <li>
                    Digital signatures captured in Section G confirm mutual verification by the named
                    signatories and carry operational accountability within your organization.
                  </li>
                </ul>
              </section>

              <section className="space-y-1.5">
                <h3 className="font-display text-base font-bold text-blue-950">
                  3. Vehicle Maintenance, Grounding &amp; Approval Workflows
                </h3>
                <p>
                  Only authorized Fleet Managers/Supervisors and Administrators may ground vehicles,
                  restore grounded vehicles to active service, or set service-due mileage thresholds.
                  Garage visit schedules and parts/service kit purchase requests remain subject to
                  Administrator review and authorization prior to execution.
                </p>
              </section>

              <section className="space-y-1.5">
                <h3 className="font-display text-base font-bold text-blue-950">
                  4. Tamper-Evident Audit Logging &amp; Amendments
                </h3>
                <p>
                  Fleet Secure maintains an append-only, cryptographically hash-chained audit trail.
                  Trip submissions, checklist completions, administrative amendments, and soft-deletions
                  are permanently logged with user identity, timestamp, and reason codes. Users must
                  not attempt to falsify, backdate, or alter historical records outside authorized
                  administrative correction workflows.
                </p>
              </section>

              <section className="space-y-1.5">
                <h3 className="font-display text-base font-bold text-blue-950">
                  5. Offline Usage &amp; Synchronization Responsibility
                </h3>
                <p>
                  When used in areas with intermittent connectivity, queued trips and checklists are
                  stored locally on your device until connection resumes. Users are responsible for
                  allowing pending offline items to sync cleanly and verifying completion notices.
                </p>
              </section>

              <section className="space-y-1.5">
                <h3 className="font-display text-base font-bold text-blue-950">
                  6. Acceptable Use &amp; Intellectual Property
                </h3>
                <p>
                  Fleet Secure and all associated user interfaces, vehicle inspection diagrams, PDF
                  generators, and software modules are proprietary to <strong>Comfort Designs</strong>.
                  You may not copy, reverse engineer, scrape, redistribute, or introduce malicious
                  payloads into the Application Software.
                </p>
              </section>

              <section className="space-y-1.5">
                <h3 className="font-display text-base font-bold text-blue-950">
                  7. Availability, Liability &amp; Support
                </h3>
                <p>
                  The Application Software is provided for internal fleet operations and record-keeping.
                  While reasonable technical safeguards are maintained, operational decisions—including
                  vehicle roadworthiness, driver licensing compliance, and physical security—remain the
                  responsibility of your organization. For support, contact your Fleet Administrator or
                  Comfort Designs at <span className="font-mono font-semibold">+263772824132</span>.
                </p>
              </section>
            </>
          ) : (
            <>
              <p className="rounded-xl border border-cyan-200 bg-cyan-50/60 p-3.5 text-xs sm:text-sm text-blue-950">
                This Privacy Policy explains how <strong>Fleet Secure</strong> collects, processes,
                stores, and protects personal and operational information when you use the Application
                Software.
              </p>

              <section className="space-y-1.5">
                <h3 className="font-display text-base font-bold text-blue-950">
                  1. Information We Collect
                </h3>
                <ul className="list-disc pl-5 space-y-1.5 text-slate-600">
                  <li>
                    <strong>Staff &amp; Account Information:</strong> Full name, username, assigned role
                    (Driver, Supervisor, Fleet Manager, or Administrator), account status, and securely
                    hashed authentication PIN/password.
                  </li>
                  <li>
                    <strong>Driver Compliance &amp; KYC Records:</strong> Full name, contact phone
                    number, residential address, driver&apos;s licence number/class/expiry date, uploaded
                    licence file, and optional Defensive Driving (DDC), Retest, and Medical Certificate
                    numbers or attachments.
                  </li>
                  <li>
                    <strong>Trips &amp; Hirer/Owner Records:</strong> Client/renter/owner names,
                    representative names, contact cell numbers, destinations, trip reasons, hire dates,
                    mileage readings, and fuel/battery gauge levels.
                  </li>
                  <li>
                    <strong>Digital Checklist Evidence:</strong> 25-point (and custom) vehicle
                    inspection responses, inspector notes, uploaded condition photos, 3-view body
                    condition damage markings, and captured digital signatures with signer names and
                    ID/licence numbers.
                  </li>
                  <li>
                    <strong>Security &amp; Session Metadata:</strong> Signed session tokens, failed
                    login rate-limit records, IP addresses, browser user-agent strings, and push
                    notification subscription preferences.
                  </li>
                </ul>
              </section>

              <section className="space-y-1.5">
                <h3 className="font-display text-base font-bold text-blue-950">
                  2. How Information Is Used
                </h3>
                <p>Collected data is processed strictly for legitimate fleet management purposes:</p>
                <ul className="list-disc pl-5 space-y-1 text-slate-600">
                  <li>Authenticating users and enforcing role-based and row-level access controls.</li>
                  <li>Managing vehicle dispatch, return verification, fuel variance checks, and damage accountability.</li>
                  <li>Monitoring licence expiries, overdue hires, vehicle service-due mileage alerts, and maintenance/parts approvals.</li>
                  <li>Generating printable A4 slips, PDF inspection sheets, and tamper-evident compliance audit logs.</li>
                </ul>
              </section>

              <section className="space-y-1.5">
                <h3 className="font-display text-base font-bold text-blue-950">
                  3. Security Safeguards &amp; Access Control
                </h3>
                <ul className="list-disc pl-5 space-y-1 text-slate-600">
                  <li>
                    <strong>Credential Protection:</strong> User PINs/passwords are cryptographically
                    hashed and salted; temporary driver onboarding credentials are encrypted only until
                    the user signs in and sets a private PIN, at which point temporary credential storage
                    is permanently erased.
                  </li>
                  <li>
                    <strong>Strict RBAC &amp; Row-Level Security (RLS):</strong> Drivers may only access
                    their own scoped checklists and trips, while Supervisors, Fleet Managers, and
                    Administrators receive only the permissions assigned to their operational role.
                  </li>
                  <li>
                    <strong>Transport &amp; Session Security:</strong> Sessions use HMAC-signed{' '}
                    <code className="font-mono text-xs">httpOnly</code> cookies with CSRF origin checks
                    and tamper-evident SHA-256 audit logging.
                  </li>
                </ul>
              </section>

              <section className="space-y-1.5">
                <h3 className="font-display text-base font-bold text-blue-950">
                  4. Offline Local Storage &amp; Push Notifications
                </h3>
                <p>
                  To support field inspections in low-connectivity environments, Fleet Secure caches
                  essential directories, checklist templates, vehicle sketch diagrams, and pending offline
                  submissions in your browser&apos;s local storage and Service Worker cache. Enabling
                  device alerts uses browser notification permissions solely to alert authorized users of
                  service dues, overdue trips, approvals, and discrepancies.
                </p>
              </section>

              <section className="space-y-1.5">
                <h3 className="font-display text-base font-bold text-blue-950">
                  5. Data Sharing, Retention &amp; User Rights
                </h3>
                <p>
                  Fleet Secure does <strong>not</strong> sell personal data or share records with
                  third-party advertisers. Operational data is accessible only to authorized personnel
                  within your organization and exported solely through administrator-approved reports or
                  PDF slips. Audit trails, trip histories, and completed checklists are retained for
                  operational accountability and statutory record-keeping.
                </p>
                <p>
                  To request corrections to your driver profile, update contact records, or deactivate an
                  account, please contact your organization&apos;s System Administrator or reach Comfort
                  Designs support at <span className="font-mono font-semibold">+263772824132</span>.
                </p>
              </section>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-blue-100 bg-slate-50 px-5 py-3.5">
          <span className="text-xs text-slate-500">
            © 2026 Fleet Secure · Comfort Designs
          </span>
          <button
            type="button"
            onClick={onClose}
            className="cyan-glow-btn min-h-[40px] rounded-xl px-5 text-sm font-semibold"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
