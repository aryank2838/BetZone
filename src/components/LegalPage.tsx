import { ArrowLeft } from 'lucide-react';

export type LegalDocument = 'terms' | 'privacy' | 'contact';

const CONTENT: Record<LegalDocument, { title: string; paragraphs: string[] }> = {
  terms: {
    title: 'Terms of Service',
    paragraphs: [
      '[OWNER/LAWYER TO REPLACE] These Terms of Service must be reviewed and completed by the service owner and qualified legal counsel before launch.',
      '[OWNER/LAWYER TO REPLACE] Add eligibility, service availability, payments, dispute handling, and all applicable jurisdiction-specific terms.',
    ],
  },
  privacy: {
    title: 'Privacy Policy',
    paragraphs: [
      '[OWNER/LAWYER TO REPLACE] This Privacy Policy must be reviewed and completed by the service owner and qualified legal counsel before launch.',
      '[OWNER/LAWYER TO REPLACE] Describe data collected, purposes, retention, user rights, processors, and contact details accurately.',
    ],
  },
  contact: {
    title: 'Contact',
    paragraphs: [
      "[OWNER/LAWYER TO REPLACE] Add the service owner's verified support email, mailing address, and other required contact information.",
    ],
  },
};

export default function LegalPage({ document, onBack }: { document: LegalDocument; onBack: () => void }) {
  const content = CONTENT[document];
  return (
    <main className="min-h-screen bg-slate-950 px-5 py-8 text-slate-100">
      <div className="mx-auto max-w-2xl">
        <button type="button" onClick={onBack} className="tap-target mb-6 flex items-center gap-2 text-sm text-slate-400 hover:text-white"><ArrowLeft className="h-4 w-4" /> Back</button>
        <h1 className="mb-5 text-2xl font-bold">{content.title}</h1>
        <div className="space-y-4 rounded-2xl border border-amber-900 bg-amber-950/20 p-5 text-sm leading-6 text-slate-300">
          {content.paragraphs.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
        </div>
      </div>
    </main>
  );
}
