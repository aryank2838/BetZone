/** Short team badge text: "Man City" → "MC", "India" → "IND", "Sydney Sixers Women" → "SS". */
export function teamInitials(name: string): string {
  const words = name
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((word) => word && !/^(women|men|fc|cf|afc|sc|the)$/i.test(word));
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 3).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

const TEAM_COLORS = ['#38bdf8', '#f472b6', '#a78bfa', '#34d399', '#fb923c', '#facc15', '#f87171', '#2dd4bf', '#818cf8', '#c084fc'];

/** The same colour for a team every time, so players recognise it. */
export function teamColor(name: string): string {
  let hash = 0;
  for (const char of name.toLowerCase()) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return TEAM_COLORS[hash % TEAM_COLORS.length];
}
