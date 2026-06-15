/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        sky: {
          bg: '#d6ecf7',
          soft: '#e8f4fb'
        },
        mint: {
          card: '#dff3e6',
          ink: '#2f7a4d'
        },
        rose: {
          card: '#f7e3e3',
          ink: '#9c4a4a'
        },
        ink: '#1f2933',
        muted: '#9aa5b1'
      },
      fontFamily: {
        sans: ['Nunito', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        brand: ['"Pacifico"', 'cursive']
      },
      borderRadius: {
        xl2: '1.75rem',
        xl3: '2.25rem'
      },
      boxShadow: {
        clay: '0 18px 40px -16px rgba(64, 110, 140, 0.35)',
        'clay-sm': '0 8px 20px -10px rgba(64, 110, 140, 0.30)',
        inset: 'inset 0 2px 6px rgba(255,255,255,0.6)'
      }
    }
  },
  plugins: []
}
