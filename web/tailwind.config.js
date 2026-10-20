/** @type {import('tailwindcss').Config} */
function themeColor(name) {
  return ({ opacityValue }) => `rgb(var(--${name}) / ${opacityValue})`;
}

function themeScale(prefix, steps) {
  return Object.fromEntries(steps.map((step) => [step, themeColor(`${prefix}-${step}`)]));
}

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        // Themes swap the font through --font-sans (see index.css).
        sans: ['var(--font-sans)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      colors: {
        // All colors resolve through the MD3 tokens defined in index.css.
        surface: themeScale('surface', [1000, 950, 900, 850, 800, 700, 600, 500]),
        ink: themeScale('ink', [50, 100, 200, 300, 400, 500, 600]),
        accent: {
          ...themeScale('accent', [400, 500, 600]),
          on: themeColor('accent-on'),
          container: themeColor('accent-container'),
          'on-container': themeColor('accent-on-container'),
        },
        secondary: { container: themeColor('secondary-container'), 'on-container': themeColor('secondary-on-container') },
        tertiary: {
          400: themeColor('tertiary-400'),
          container: themeColor('tertiary-container'),
          'on-container': themeColor('tertiary-on-container'),
        },
        error: {
          400: themeColor('error-400'),
          container: themeColor('error-container'),
          'on-container': themeColor('error-on-container'),
        },
        success: themeScale('success', [400, 500]),
        // Status hues are tokens too, so light themes can darken them for contrast.
        red: themeScale('red', [300, 400, 500]),
        yellow: themeScale('yellow', [400, 500]),
        sky: themeScale('sky', [400, 500]),
        // Inverse surface: toasts and chart tooltips.
        inverse: { DEFAULT: themeColor('inverse'), on: themeColor('inverse-on'), muted: themeColor('inverse-muted') },
      },
      borderRadius: {
        // Tailwind's scale, overridable per theme (the retro themes square things off).
        sm: 'var(--radius-sm, 0.125rem)',
        DEFAULT: 'var(--radius, 0.25rem)',
        md: 'var(--radius-md, 0.375rem)',
        lg: 'var(--radius-lg, 0.5rem)',
        xl: 'var(--radius-xl, 0.75rem)',
        '2xl': 'var(--radius-2xl, 1rem)',
        '3xl': 'var(--radius-3xl, 1.5rem)',
        // MD3 shape scale: extra-large containers (dialogs) are 28dp.
        '4xl': 'var(--radius-4xl, 28px)',
        full: 'var(--radius-full, 9999px)',
      },
      boxShadow: {
        // Flat, neutral elevation — no colored glow. Depth comes from blur + a hairline
        // border, not drop shadows, to keep surfaces reading flat rather than skeuomorphic.
        flat: '0 1px 2px rgba(0,0,0,0.2)',
        card: '0 4px 20px -6px rgba(0,0,0,0.35)',
        glow: '0 4px 24px -4px rgb(var(--accent-500) / 0.35)',
      },
      keyframes: {
        'fade-in': { from: { opacity: 0 }, to: { opacity: 1 } },
        'fade-in-up': { from: { opacity: 0, transform: 'translateY(8px)' }, to: { opacity: 1, transform: 'translateY(0)' } },
        'scale-in': { from: { opacity: 0, transform: 'scale(0.96)' }, to: { opacity: 1, transform: 'scale(1)' } },
        shimmer: { from: { backgroundPosition: '-400px 0' }, to: { backgroundPosition: '400px 0' } },
        'pulse-soft': { '0%, 100%': { opacity: 1 }, '50%': { opacity: 0.45 } },
        float: { '0%, 100%': { transform: 'translateY(0)' }, '50%': { transform: 'translateY(-6px)' } },
        'ping-slow': { '0%': { transform: 'scale(1)', opacity: 0.6 }, '100%': { transform: 'scale(2.4)', opacity: 0 } },
      },
      animation: {
        'fade-in': 'fade-in 0.4s ease-out both',
        'fade-in-up': 'fade-in-up 0.5s cubic-bezier(0.16,1,0.3,1) both',
        'scale-in': 'scale-in 0.25s cubic-bezier(0.16,1,0.3,1) both',
        shimmer: 'shimmer 1.6s ease-in-out infinite',
        'pulse-soft': 'pulse-soft 2s ease-in-out infinite',
        float: 'float 5s ease-in-out infinite',
        // Three pulses when a status appears, then still — an endless ping keeps the GPU busy for nothing.
        'ping-slow': 'ping-slow 1.8s cubic-bezier(0,0,0.2,1) 3 both',
      },
    },
  },
  plugins: [],
};
