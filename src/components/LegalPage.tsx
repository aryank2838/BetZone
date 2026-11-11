import { ArrowLeft } from 'lucide-react';

export type LegalDocument = 'terms' | 'privacy' | 'contact';

interface LegalSection {
  heading?: string;
  text: string;
}

const CONTENT: Record<LegalDocument, { title: string; sections: LegalSection[] }> = {
  terms: {
    title: 'Legal Disclaimer & Terms Summary',
    sections: [
      {
        heading: '1. Eligibility & Age Restriction',
        text: 'You must be at least 18 years of age (or the legal age of majority in your jurisdiction) to access this platform. By registering an account, you affirm that you meet this age requirement. The platform reserves the right to request proof of age and suspend any account until such verification is provided.',
      },
      {
        heading: '2. Jurisdictional Compliance & Legality',
        text: 'Online wagering may be restricted or prohibited in certain countries or states. It is your sole responsibility to ensure that accessing this website is legal in your location. The platform is not intended for use by residents of jurisdictions where online betting is prohibited by law.',
      },
      {
        heading: '3. Financial Responsibility & Responsible Gaming',
        text: 'All participation on this website is entirely at your own risk. Wagering involves financial risk and the potential loss of money. You acknowledge that you may lose funds deposited into your account. The platform provides tools for self-exclusion and responsible gaming limits, which we strongly encourage users to utilize.',
      },
      {
        heading: '4. No Warranties & Limitation of Liability',
        text: 'The services, game data, and odds provided on this platform are provided on an "as-is" and "as-available" basis without warranties of any kind. The platform shall not be held liable for any direct, indirect, or consequential losses, including financial losses or damages resulting from software errors, system latency, or internet connectivity issues.',
      },
      {
        heading: '5. Account Security',
        text: 'You are entirely responsible for maintaining the confidentiality of your account credentials (username and password). Any activity or wagers placed through your account will be deemed authorized by you.',
      },
    ],
  },
  privacy: {
    title: 'Privacy Policy',
    sections: [
      { text: '[OWNER/LAWYER TO REPLACE] This Privacy Policy must be reviewed and completed by the service owner and qualified legal counsel before launch.' },
      { text: '[OWNER/LAWYER TO REPLACE] Describe data collected, purposes, retention, user rights, processors, and contact details accurately.' },
    ],
  },
  contact: {
    title: 'Contact',
    sections: [
      { text: "[OWNER/LAWYER TO REPLACE] Add the service owner's verified support email, mailing address, and other required contact information." },
    ],
  },
};

// Partial prefix on purpose: the full placeholder string here would itself trip
// the production build guard (vite/legalGuard.ts) after the text is replaced.
const isDraft = (text: string) => text.startsWith('[OWNER/');

export default function LegalPage({ document, onBack }: { document: LegalDocument; onBack: () => void }) {
  const content = CONTENT[document];
  const draft = content.sections.some((section) => isDraft(section.text));
  return (
    <main className="min-h-screen bg-slate-950 px-5 py-8 text-slate-100">
      <div className="mx-auto max-w-2xl">
        <button type="button" onClick={onBack} className="tap-target mb-6 flex items-center gap-2 text-sm text-slate-400 hover:text-white"><ArrowLeft className="h-4 w-4" /> Back</button>
        <h1 className="mb-5 text-2xl font-bold">{content.title}</h1>
        <div className={`space-y-5 rounded-2xl border p-5 text-sm leading-6 text-slate-300 ${draft ? 'border-amber-900 bg-amber-950/20' : 'border-slate-800 bg-slate-900/60'}`}>
          {content.sections.map((section) => (
            <section key={section.heading ?? section.text}>
              {section.heading && <h2 className="mb-1 text-base font-semibold text-white">{section.heading}</h2>}
              <p>{section.text}</p>
            </section>
          ))}
        </div>
      </div>
    </main>
  );
}
