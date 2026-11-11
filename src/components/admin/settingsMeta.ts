import { formatDate } from '@/i18n/format';

/** One row of admin_get_settings(). */
export interface AdminSettingRow {
  key: string;
  value: string | null;
  updated_at: string | null;
  updated_by: string | null;
  updated_by_display_name: string | null;
}

/** "Last changed {time} by {name}" for a setting (C2). */
export function lastChangedText(row: AdminSettingRow | undefined): string {
  if (!row?.updated_at) return 'Never changed (using the default)';
  const when = formatDate(row.updated_at, { dateStyle: 'medium', timeStyle: 'short' });
  return `Last changed ${when} IST by ${row.updated_by_display_name || (row.updated_by ? 'an unknown admin' : 'system')}`;
}

