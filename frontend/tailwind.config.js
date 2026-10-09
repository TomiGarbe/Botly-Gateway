/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  // Clases de componentes armadas dinámicamente (`status-badge-${tone}`, etc.): sin esto Tailwind las purga.
  safelist: [
    { pattern: /^(status-badge|toast|confirm-dialog-icon|connection-card|connection-setup-state|diagnostic-check-status|diagnostics-overall|empty-state|operation-status-summary|operation-button|ui-button|workspace-message-direction|loading-state-line|dashboard-overall)-/ },
    { pattern: /^is-/ },
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
      animation: {
        'pulse-slow': 'pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'fade-in': 'fadeIn .15s ease-out',
        'slide-up': 'slideUp .2s ease-out',
      },
      keyframes: {
        fadeIn: { from: { opacity: '0' }, to: { opacity: '1' } },
        slideUp: { from: { opacity: '0', transform: 'translateY(8px)' }, to: { opacity: '1', transform: 'translateY(0)' } },
      },
    },
  },
  plugins: [],
}
