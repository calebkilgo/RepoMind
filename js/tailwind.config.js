/* Must load after the Tailwind CDN script (which defines window.tailwind) and synchronously
   in <head> before any Tailwind classes are used, so the JIT compiler picks up the theme. */
tailwind.config = {
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        "outline": "#8d919b",
        "outline-variant": "#424750",
        "primary": "#b5cfff",
        "primary-container": "#89b4fa",
        "on-primary-fixed": "#001b3c",
        "secondary": "#b7c7e6",
        "tertiary": "#fbc65b",
        "background": "#111317",
        "surface": "#111317",
        "surface-dim": "#111317",
        "surface-container-lowest": "#0c0e12",
        "surface-container-low": "#1a1c20",
        "surface-container": "#1e2024",
        "surface-container-high": "#282a2e",
        "surface-container-highest": "#333539",
        "on-surface": "#e2e2e8",
        "on-surface-variant": "#c3c6d2",
        "on-background": "#e2e2e8",
        "error": "#ffb4ab",
        "error-container": "#93000a"
      },
      borderRadius: {
        "DEFAULT": "0.125rem",
        "lg": "0.25rem",
        "xl": "0.5rem",
        "full": "0.75rem"
      },
      fontFamily: {
        "headline": ["Inter"],
        "body": ["Inter"],
        "mono": ["JetBrains Mono"]
      }
    }
  }
};