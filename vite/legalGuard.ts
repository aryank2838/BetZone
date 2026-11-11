import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';

export const LEGAL_PLACEHOLDER = '[OWNER/LAWYER TO REPLACE]';
/** Files whose text is shown to users as Terms, Privacy Policy and Contact. */
export const LEGAL_SOURCE_FILES = ['src/components/LegalPage.tsx'];

type BuildEnvironment = Record<string, string | undefined>;

/** Returns the files that still contain the placeholder, with occurrence counts. */
export function findLegalPlaceholders(root: string, files = LEGAL_SOURCE_FILES): Array<{ file: string; count: number }> {
  return files
    .map((file) => {
      const text = readFileSync(resolve(root, file), 'utf8');
      return { file, count: text.split(LEGAL_PLACEHOLDER).length - 1 };
    })
    .filter((entry) => entry.count > 0);
}

export function legalPlaceholderError(mode: string, env: BuildEnvironment, root: string, files = LEGAL_SOURCE_FILES): string | null {
  if (mode !== 'production') return null;
  if (env.ALLOW_PLACEHOLDER_LEGAL === '1') return null;
  const found = findLegalPlaceholders(root, files);
  if (found.length === 0) return null;
  const list = found.map(({ file, count }) => `${file} (${count})`).join(', ');
  return `Legal pages still contain "${LEGAL_PLACEHOLDER}": ${list}. Replace the placeholder text before a production build, or set ALLOW_PLACEHOLDER_LEGAL=1 for a staging build.`;
}

/** Fails production builds while legal pages contain placeholder text. */
export function legalGuardPlugin(mode: string, env: BuildEnvironment, root = process.cwd()): Plugin {
  return {
    name: 'betzone-legal-placeholder-guard',
    apply: 'build',
    buildStart() {
      const error = legalPlaceholderError(mode, env, root);
      if (error) this.error(error);
      if (mode === 'production' && env.ALLOW_PLACEHOLDER_LEGAL === '1' && findLegalPlaceholders(root).length > 0) {
        this.warn('ALLOW_PLACEHOLDER_LEGAL=1: building with placeholder legal text. Do not deploy this build to production.');
      }
    },
  };
}
