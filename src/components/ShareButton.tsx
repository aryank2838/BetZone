import { Share2 } from 'lucide-react';
import { whatsappShareUrl } from '@/lib/referral';

/**
 * Opens the phone's share sheet so the player picks the app (WhatsApp,
 * Instagram, Telegram, SMS…). Where the browser has no share sheet, such as
 * most desktop browsers, it opens WhatsApp instead.
 */
export default function ShareButton({ text, label, className }: { text: string; label: string; className: string }) {
  const share = async () => {
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ text });
        return;
      } catch (error) {
        // The player closed the sheet: do nothing.
        if (error instanceof DOMException && error.name === 'AbortError') return;
        // Any other failure falls through to WhatsApp.
      }
    }
    window.open(whatsappShareUrl(text), '_blank', 'noopener,noreferrer');
  };

  return (
    <button type="button" onClick={() => void share()} className={className}>
      <Share2 className="h-4 w-4" aria-hidden="true" /> {label}
    </button>
  );
}
