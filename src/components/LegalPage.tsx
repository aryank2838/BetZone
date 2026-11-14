import PageHeader from '@/components/ui/PageHeader';
import Alert from '@/components/ui/Alert';
import { useT } from '@/i18n/useT';

export type LegalDocument = 'terms' | 'privacy' | 'contact';

interface LegalSection {
  heading?: string;
  text: string;
  bullets?: string[];
  link?: { href: string; label: string };
}

const SUPPORT_EMAIL ='a082169220@gmail.com';

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
      { text: 'Effective Date: 11 November 2026' },
      { text: 'This Privacy Policy describes how your information is collected, used, and protected when you use our platform. We are committed to maintaining the confidentiality and security of your personal data.' },
      {
        heading: '1. Information We Collect',
        text: 'We collect information to provide a secure and customized experience:',
        bullets: [
          'Account Information: Name, email address, age verification data, and profile settings.',
          'Financial Data: Deposit and withdrawal transaction history, payment reference numbers (UTR), the UPI ID you provide for withdrawals, payment screenshots you upload with deposit requests, and ledger entries. (We do not store your banking passwords, PINs, or card details).',
          'Technical Information: Basic session data stored in your browser (such as your sign-in session, language choice, and last-activity time). If error reporting is enabled, technical details of app errors are sent with personal details such as email addresses and UPI IDs removed.',
        ],
      },
      {
        heading: '2. How We Use Your Information',
        text: 'Your data is used strictly for the following operational requirements:',
        bullets: [
          'Account Management: Creating your profile, handling secure log-ins, and maintaining your platform wallet.',
          'Responsible Play Enforcement: Enforcing daily deposit caps, loss limits, or self-exclusion requests that you choose to configure.',
          'Legal and Security Compliance: Preventing fraudulent activities and multi-account abuse, verifying deposits against payment references and screenshots, and paying withdrawals to the UPI ID you provide.',
        ],
      },
      {
        heading: '3. Data Storage and Retention',
        text: 'Our platform utilizes secure cloud database solutions (including Supabase Auth and Postgres) to protect your infrastructure.',
        bullets: [
          'Transaction Records: Financial ledger entries, deposit logs, and selection histories are retained permanently for statutory audit requirements and dispute resolutions.',
          'Account Deletion: Accounts cannot be deleted instantly if a transaction history exists. Instead, accounts are permanently banned or locked to preserve mandatory compliance tracking.',
        ],
      },
      {
        heading: '4. Cookies and Session Data',
        text: 'We use your browser\'s local storage to keep you securely logged in across browser tabs. This data does not track your activity on external websites. In a browser tab you are signed out automatically after 30 minutes of complete inactivity; in the installed app you stay signed in until you sign out. Your stored session is cleared when you sign out.',
      },
      {
        heading: '5. Sharing of Data',
        text: 'We do not sell, rent, or trade your personal information to third parties. Data is shared only under the following limited conditions:',
        bullets: [
          'Service Providers: Infrastructure providers that host and run the platform for us: Supabase (database, sign-in, and file storage), Netlify (website hosting), and, if enabled, Sentry (error reporting). Deposits and withdrawals are made by direct UPI transfer; we do not use a third-party payment gateway.',
          'Legal Obligation: If requested by law enforcement, regulatory bodies, or a court order within a legally binding jurisdiction.',
        ],
      },
    ],
  },
  contact: {
    title: 'Contact',
    sections: [
      {
        heading: 'Support',
        text: 'For help with your account, deposits, withdrawals, or these policies, email us at:',
        link: { href: `mailto:${SUPPORT_EMAIL}`, label: SUPPORT_EMAIL },
      },
    ],
  },
};

// Partial prefix on purpose: the full placeholder string here would itself trip
// the production build guard (vite/legalGuard.ts) after the text is replaced.
const isDraft = (text: string) => text.startsWith('[OWNER/');

export default function LegalPage({ document, onBack }: { document: LegalDocument; onBack: () => void }) {
  const { t, language } = useT();
  const content = CONTENT[document];
  const draft = content.sections.some((section) => isDraft(section.text));
  return (
    <div className="min-h-screen bg-surface-page text-ink">
      <PageHeader title={content.title} onBack={onBack} />
      <main className="mx-auto max-w-2xl space-y-4 px-4 py-6 sm:px-5">
        {language !== 'en' && <Alert tone="info">{t('legal.englishOnly')}</Alert>}
        <div className={`space-y-5 rounded-card border p-5 text-sm leading-6 text-ink-soft ${draft ? 'border-amber-900 bg-amber-950/20' : 'border-surface-border bg-surface/60'}`}>
          {content.sections.map((section) => (
            <section key={section.heading ?? section.text}>
              {section.heading && <h2 className="mb-1 text-base font-semibold text-white">{section.heading}</h2>}
              <p>{section.text}</p>
              {section.bullets && (
                <ul className="mt-2 list-disc space-y-1 pl-5">
                  {section.bullets.map((bullet) => <li key={bullet}>{bullet}</li>)}
                </ul>
              )}
              {section.link && (
                <a href={section.link.href} className="mt-1 inline-block break-all text-cyan-300 underline hover:text-cyan-200">{section.link.label}</a>
              )}
            </section>
          ))}
        </div>
      </main>
    </div>
  );
}
