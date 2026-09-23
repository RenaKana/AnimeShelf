// CommonJS keeps palette edits reloadable in long-running Node 22+ dev servers.
const colors = require('tailwindcss/colors')
const rgbToken = name => `rgb(var(--ui-${name}) / <alpha-value>)`
// Legacy utility names follow the theme; media and filled actions opt into inverse text.
const tone = name => Object.fromEntries([50, 100, 200, 300, 400].map(shade => {
  const rgb = colors[name][shade].slice(1).match(/../g).map(part => parseInt(part, 16)).join(' ')
  return [shade, `rgb(var(--ui-tone-${name}, ${rgb}) / <alpha-value>)`]
}))
/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/**/*.{ts,tsx}', './modules/**/client/**/*.{ts,tsx}', './modules/*/client.tsx'],
  theme: {
    extend: {
      colors: {
        bg: rgbToken('bg'), surface: rgbToken('surface'), 'surface-hover': rgbToken('surface-hover'),
        'surface-modal': rgbToken('surface-modal'), border: rgbToken('border'), accent: rgbToken('accent'),
        'accent-fill': rgbToken('accent-fill'), 'accent-hover': rgbToken('accent-hover'),
        success: rgbToken('success'), warning: rgbToken('warning'), error: rgbToken('error'),
        'text-primary': 'rgb(var(--ui-text-primary) / <alpha-value>)',
        'text-secondary': 'rgb(var(--ui-text-secondary) / max(<alpha-value>, var(--ui-secondary-min-alpha)))',
      },
      textColor: {
        white: rgbToken('text-white'),
        'on-accent': '#ffffff',
        gray: { 100: rgbToken('text-primary'), 300: rgbToken('text-secondary'), 500: rgbToken('text-secondary') },
        slate: { 300: rgbToken('text-secondary') },
        ...Object.fromEntries(['amber', 'emerald', 'red', 'yellow'].map(name => [name, tone(name)])),
      },
      backgroundColor: {
        accent: rgbToken('accent-fill'),
        white: rgbToken('ink'),
        black: ({ opacityValue }) => {
          const channels = Number(opacityValue) < 0.5 ? 'var(--ui-wash)' : '0 0 0'
          return `rgb(${channels} / ${opacityValue ?? 1})`
        },
      },
      borderColor: { white: rgbToken('ink') },
      ringColor: { white: rgbToken('ink') },
    },
  },
  plugins: [],
}
