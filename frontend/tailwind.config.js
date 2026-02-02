/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}'
  ],
  theme: {
    extend: {
      fontFamily: {
        mono: ['JetBrains Mono', 'monospace']
      },
      colors: {
        'matrix': {
          DEFAULT: '#00ff41',
          50: 'rgba(0, 255, 65, 0.05)',
          100: 'rgba(0, 255, 65, 0.1)',
          200: 'rgba(0, 255, 65, 0.2)',
          300: 'rgba(0, 255, 65, 0.3)',
          400: 'rgba(0, 255, 65, 0.4)',
          500: 'rgba(0, 255, 65, 0.5)',
          600: 'rgba(0, 255, 65, 0.6)',
          700: 'rgba(0, 255, 65, 0.7)',
          800: 'rgba(0, 255, 65, 0.8)',
          900: 'rgba(0, 255, 65, 0.9)',
          glow: 'rgba(0, 255, 65, 0.3)'
        }
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'glow-pulse': 'glow-pulse 2s ease-in-out infinite',
        'float': 'float 3s ease-in-out infinite',
        'shimmer': 'shimmer 2s ease-in-out infinite',
        'gradient-rotate': 'gradient-rotate 4s linear infinite'
      },
      keyframes: {
        'glow-pulse': {
          '0%, 100%': {
            boxShadow: '0 0 20px rgba(0, 255, 65, 0.3)'
          },
          '50%': {
            boxShadow: '0 0 40px rgba(0, 255, 65, 0.5)'
          }
        },
        'float': {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-10px)' }
        },
        'shimmer': {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' }
        }
      },
      backdropBlur: {
        'xs': '2px',
        '3xl': '64px',
        '4xl': '80px'
      },
      boxShadow: {
        'glow': '0 0 20px rgba(0, 255, 65, 0.3)',
        'glow-lg': '0 0 40px rgba(0, 255, 65, 0.4)',
        'glow-xl': '0 0 60px rgba(0, 255, 65, 0.5)',
        'inner-glow': 'inset 0 0 20px rgba(0, 255, 65, 0.1)',
        'glass': '0 8px 32px rgba(0, 0, 0, 0.4), inset 0 1px 0 rgba(0, 255, 65, 0.1)'
      },
      backgroundImage: {
        'glass-gradient': 'linear-gradient(135deg, rgba(0, 255, 65, 0.08) 0%, rgba(0, 0, 0, 0.6) 50%, rgba(0, 255, 65, 0.04) 100%)',
        'glow-radial': 'radial-gradient(circle, rgba(0, 255, 65, 0.15) 0%, transparent 70%)'
      }
    }
  },
  plugins: []
};
