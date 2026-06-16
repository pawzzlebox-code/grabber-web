/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./app/**/*.{ts,tsx}'],
  theme: {
    extend: {
      // Semantic colors mapped to the CSS tokens in globals.css. Use these
      // (bg-surface, text-secondary, accent…) instead of raw hex anywhere.
      colors: {
        base: 'var(--bg-base)',
        surface: 'var(--bg-surface)',
        'surface-2': 'var(--bg-surface-2)',
        'border-subtle': 'var(--border-subtle)',
        'text-primary': 'var(--text-primary)',
        'text-secondary': 'var(--text-secondary)',
        'text-muted': 'var(--text-muted)',
        accent: 'var(--accent)',
        'accent-hover': 'var(--accent-hover)',
        'accent-muted': 'var(--accent-muted)',
        success: 'var(--success)',
        danger: 'var(--danger)',
      },
      borderColor: {
        subtle: 'var(--border-subtle)',
      },
      borderRadius: {
        // Commit to this radius scale — no other values in the UI.
        sm: '4px',  // inputs, text fields
        md: '6px',  // pills, buttons
        lg: '8px',  // cards, containers
      },
    },
  },
  plugins: [],
}
