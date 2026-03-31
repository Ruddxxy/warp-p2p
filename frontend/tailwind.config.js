/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Inter", "system-ui", "-apple-system", "sans-serif"],
        mono: ["Space Grotesk", "JetBrains Mono", "ui-monospace", "monospace"],
      },
      colors: {
        bg: "#0A0A0F",
        surface: "#16161D",
        "surface-raised": "#1E1E28",
        border: "#2A2A35",
        "border-hover": "#3A3A48",
        primary: {
          DEFAULT: "#6366F1",
          hover: "#818CF8",
          muted: "rgba(99, 102, 241, 0.15)",
          glow: "rgba(99, 102, 241, 0.08)",
        },
        success: {
          DEFAULT: "#22C55E",
          muted: "rgba(34, 197, 94, 0.15)",
        },
        error: {
          DEFAULT: "#EF4444",
          muted: "rgba(239, 68, 68, 0.15)",
        },
        warning: {
          DEFAULT: "#EAB308",
          muted: "rgba(234, 179, 8, 0.10)",
        },
        text: {
          DEFAULT: "#F4F4F5",
          muted: "#A1A1AA",
          faint: "#71717A",
        },
      },
      animation: {
        "pulse-slow": "pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite",
      },
    },
  },
  plugins: [],
};
