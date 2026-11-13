import colors from 'tailwindcss/colors';

/**
 * Design tokens. Prefer these semantic names in new UI code:
 *   brand   - primary actions, "open", positive money (emerald)
 *   accent  - secondary highlights, close digit (cyan)
 *   surface - page and card backgrounds / borders
 *   ink     - text colours
 *   card / control radii keep corners consistent.
 * @type {import('tailwindcss').Config}
 */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: colors.emerald,
        accent: colors.cyan,
        surface: {
          page: colors.slate[950],
          DEFAULT: colors.slate[900],
          raised: colors.slate[800],
          border: colors.slate[800],
          strong: colors.slate[700],
        },
        ink: {
          DEFAULT: colors.slate[100],
          strong: colors.white,
          muted: colors.slate[400],
          soft: colors.slate[300],
        },
      },
      borderRadius: {
        card: '1rem',
        control: '0.75rem',
      },
      minHeight: {
        tap: '44px',
      },
    },
  },
  plugins: [],
};
