import { useEffect, useRef, useState } from 'react';
import { countdownTone, formatBetWindow, formatClockTime } from '@/lib/countdown';
import { interpolate, useT } from '@/i18n/useT';

export default function CountdownAnnouncement({ cutoff, opensAt, isOpen, nowMs, label }: {
  cutoff: string;
  opensAt: string;
  isOpen: boolean;
  nowMs: number;
  label: string;
}) {
  const { t, language } = useT();
  const tone = isOpen ? countdownTone(cutoff, nowMs) : 'closed';
  const lastTone = useRef(tone);
  const [announcement, setAnnouncement] = useState('');
  useEffect(() => {
    if (tone === lastTone.current) return;
    lastTone.current = tone;
    setAnnouncement(!isOpen
      ? interpolate(t('countdown.srClosed'), { label, time: formatClockTime(opensAt) })
      : tone === 'amber'
        ? interpolate(t('countdown.srAmber'), { label })
      : tone === 'red'
        ? interpolate(t('countdown.srRed'), { label })
        : tone === 'closed'
          ? interpolate(t('countdown.srNow'), { label })
          : formatBetWindow(true, cutoff, opensAt, nowMs, language));
  }, [cutoff, isOpen, label, nowMs, opensAt, tone, t, language]);
  return <span className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</span>;
}
