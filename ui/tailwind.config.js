/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ["class"],
  // The bundle's CSS is injected into LuCI's <head>, so Tailwind's global
  // preflight would restyle the whole host UI (body/headings/buttons/tables).
  // Disable it and re-apply the resets scoped to #splify-root in index.css.
  corePlugins: { preflight: false },
  content: [
    './pages/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './app/**/*.{ts,tsx}',
    './src/**/*.{ts,tsx}',
  ],
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: {
        "2xl": "1400px",
      },
    },
    extend: {
      // Tokens are full colours inherited from the Argon theme's own CSS
      // variables (see index.css), NOT HSL triplets — color-mix() re-enables
      // Tailwind's `/NN` opacity modifiers on top of them.
      colors: (() => {
        const mix = (v) =>
          `color-mix(in srgb, var(${v}) calc(<alpha-value> * 100%), transparent)`
        return {
          border: mix("--sp-border"),
          // Рельс разделов и второй уровень текста — свои токены Andromeda: `bg-rail`,
          // `text-subtle`. Не варианты muted: рельс светлее карточки, а второй текст
          // ТЕМНЕЕ тусклого, и выразить их через существующие два нечем.
          rail: mix("--sp-rail"),
          subtle: mix("--sp-fg2"),
          input: mix("--sp-input"),
          ring: mix("--sp-ring"),
          background: "var(--sp-background)",
          foreground: mix("--sp-foreground"),
          success: mix("--sp-success"),
          // Янтарный для рамки и подложки блока (`border-warning/40 bg-warning/10`) и
          // ОТДЕЛЬНЫЙ токен для текста: сам янтарный буквами на белой карточке нечитаем.
          // Два значения — из дизайн-пака 26.9, у него на каждую яркость свой текст.
          warning: mix("--sp-warning"),
          "warning-fg": mix("--sp-warning-fg"),
          info: mix("--sp-info"),
          primary: {
            DEFAULT: mix("--sp-primary"),
            foreground: mix("--sp-primary-foreground"),
          },
          secondary: {
            DEFAULT: mix("--sp-secondary"),
            foreground: mix("--sp-secondary-foreground"),
          },
          destructive: {
            DEFAULT: mix("--sp-destructive"),
            foreground: mix("--sp-destructive-foreground"),
          },
          muted: {
            DEFAULT: mix("--sp-muted"),
            foreground: mix("--sp-muted-foreground"),
          },
          accent: {
            DEFAULT: mix("--sp-accent"),
            foreground: mix("--sp-accent-foreground"),
          },
          popover: {
            DEFAULT: mix("--sp-popover"),
            foreground: mix("--sp-popover-foreground"),
          },
          card: {
            DEFAULT: mix("--sp-card"),
            foreground: mix("--sp-card-foreground"),
          },
        }
      })(),
      boxShadow: {
        // Argon's card shadow (light and dark values live in the CSS vars)
        card: "var(--sp-card-shadow)",
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      keyframes: {
        "accordion-down": {
          from: { height: 0 },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: 0 },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
}
