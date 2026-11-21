/** Which half of My Bets is showing: the number games or sports. */
export type MyBetsTab = 'games' | 'sports';

const KEY = 'betzone_mybets_tab';

export function readMyBetsTab(): MyBetsTab | null {
  try {
    const value = sessionStorage.getItem(KEY);
    return value === 'games' || value === 'sports' ? value : null;
  } catch {
    return null;
  }
}

export function rememberMyBetsTab(tab: MyBetsTab) {
  try { sessionStorage.setItem(KEY, tab); } catch { /* storage blocked */ }
}
