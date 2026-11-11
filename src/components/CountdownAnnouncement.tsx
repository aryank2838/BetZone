import { useEffect, useRef, useState } from 'react';
import { countdownTone, formatBetWindow, formatClockTime } from '@/lib/countdown';

export default function CountdownAnnouncement({ cutoff, opensAt, isOpen, nowMs, label }: {
  cutoff: string;
  opensAt: string;
  isOpen: boolean;
  nowMs: number;
  label: string;
}) {
  const tone = isOpen ? countdownTone(cutoff, nowMs) : 'closed';
  const lastTone = useRef(tone);
  const [announcement, setAnnouncement] = useState('');
  useEffect(() => {
    if (tone === lastTone.current) return;
    lastTone.current = tone;
    setAnnouncement(!isOpen
      ? `${label} are closed. They open at ${formatClockTime(opensAt)} IST`
      : tone === 'amber'
        ? `${label} closes in under 10 minutes`
      : tone === 'red'
        ? `${label} closes in under 2 minutes`
        : tone === 'closed'
          ? `${label} closes now`
          : formatBetWindow(true, cutoff, opensAt, nowMs));
  }, [cutoff, isOpen, label, nowMs, opensAt, tone]);
  return <span className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</span>;
}
