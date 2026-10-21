/** Color schemes + themes (Settings → Appearance).
 *
 *  Two independent choices, both persisted in localStorage:
 *  - Color scheme: "system" | "light" | "dark" — resolved to light/dark and
 *    applied by toggling the `dark` class on <html> (index.html ships
 *    class="dark" so the first paint matches the default scheme).
 *  - Theme: a pair of override sets (one per scheme) for the custom
 *    properties that index.css declares in `:root` (light) and `.dark`,
 *    applied inline on <html> (inline style beats both selectors). The
 *    default theme owns no overrides: the stylesheet IS its definition, so a
 *    stale localStorage value or a removed theme falls back to exactly what
 *    the CSS ships.
 *
 *  Same module-load-applies pattern as zoom.ts: main.tsx imports this before
 *  first render, so there is no flash of the default palette. */

import { useSyncExternalStore } from "react";

export type ColorScheme = "system" | "light" | "dark";

export const COLOR_SCHEMES: readonly ColorScheme[] = [
  "system",
  "light",
  "dark",
];

/** Mirror of the stylesheet's `:root` / `.dark` token values that in-app
 *  previews need to paint outside the live cascade (the settings scheme
 *  mocks, the sandboxed artifact shell). Carbon owns no overrides — the
 *  stylesheet is its definition — so previews spread a theme's own vars over
 *  these. Keep in sync with index.css. */
export const DEFAULT_TOKENS: Record<
  "light" | "dark",
  Record<string, string>
> = {
  light: {
    "--background": "oklch(1 0 0)",
    "--foreground": "oklch(0.145 0 0)",
    "--card": "oklch(1 0 0)",
    "--secondary": "oklch(0.97 0 0)",
    "--border": "oklch(0.922 0 0)",
    "--sidebar": "oklch(0.985 0 0)",
    "--brand": "oklch(0.585 0.21 277)",
    "--success": "oklch(0.6 0.115 155)",
    "--warning": "oklch(0.66 0.125 76)",
  },
  dark: {
    "--background": "oklch(0.145 0 0)",
    "--foreground": "oklch(0.985 0 0)",
    "--card": "oklch(0.205 0 0)",
    "--secondary": "oklch(0.269 0 0)",
    "--border": "oklch(1 0 0 / 10%)",
    "--sidebar": "oklch(0.205 0 0)",
    "--brand": "oklch(0.68 0.17 277)",
    "--success": "oklch(0.745 0.115 152)",
    "--warning": "oklch(0.8 0.128 80)",
  },
};

export type ThemeDefinition = {
  id: string;
  label: string;
  /** One-line flavor for the settings card. */
  tagline: string;
  /** Colors for the settings card's preview orbs. */
  preview: { accent: string; surface: string };
  /** Custom-property overrides per scheme; both empty for the default (see
   *  module doc). */
  vars: { light: Record<string, string>; dark: Record<string, string> };
};

export const THEMES: readonly ThemeDefinition[] = [
  {
    id: "carbon",
    label: "Carbon",
    tagline: "The original neutral gray, brightened indigo.",
    preview: {
      accent: "oklch(0.68 0.17 277)",
      surface: "oklch(0.245 0 0)",
    },
    vars: { light: {}, dark: {} },
  },
  {
    id: "monad",
    label: "Monad",
    tagline: "Warm graphite with the logo's coral.",
    preview: {
      accent: "oklch(0.705 0.148 33)",
      surface: "oklch(0.243 0.009 47)",
    },
    // Warm graphite: every gray carries a faint warm cast (hue ~50, chroma
    // ≤0.01) so the chrome sits with the logo; the brand is the logo's coral.
    vars: {
      light: {
        "--background": "oklch(0.985 0.005 60)",
        "--foreground": "oklch(0.21 0.012 45)",
        "--card": "oklch(0.997 0.002 60)",
        "--card-foreground": "oklch(0.21 0.012 45)",
        "--popover": "oklch(0.997 0.002 60)",
        "--popover-foreground": "oklch(0.21 0.012 45)",
        "--primary": "oklch(0.25 0.015 45)",
        "--primary-foreground": "oklch(0.985 0.005 60)",
        "--secondary": "oklch(0.945 0.008 55)",
        "--secondary-foreground": "oklch(0.25 0.015 45)",
        "--muted": "oklch(0.945 0.008 55)",
        "--muted-foreground": "oklch(0.52 0.015 50)",
        "--accent": "oklch(0.945 0.008 55)",
        "--accent-foreground": "oklch(0.25 0.015 45)",
        "--brand": "oklch(0.62 0.155 31)",
        "--brand-foreground": "oklch(0.985 0.005 40)",
        "--border": "oklch(0.9 0.01 55)",
        "--input": "oklch(0.9 0.01 55)",
        "--ring": "oklch(0.7 0.08 40)",
        "--sidebar": "oklch(0.975 0.006 58)",
        "--sidebar-foreground": "oklch(0.21 0.012 45)",
        "--sidebar-primary": "oklch(0.62 0.155 31)",
        "--sidebar-primary-foreground": "oklch(0.985 0.005 40)",
        "--sidebar-accent": "oklch(0.945 0.008 55)",
        "--sidebar-accent-foreground": "oklch(0.25 0.015 45)",
        "--sidebar-border": "oklch(0.9 0.01 55)",
        "--sidebar-ring": "oklch(0.7 0.08 40)",
      },
      dark: {
        "--background": "oklch(0.148 0.007 45)",
        "--foreground": "oklch(0.955 0.006 60)",
        "--card": "oklch(0.203 0.008 47)",
        "--card-foreground": "oklch(0.955 0.006 60)",
        "--popover": "oklch(0.203 0.008 47)",
        "--popover-foreground": "oklch(0.955 0.006 60)",
        "--primary": "oklch(0.93 0.012 55)",
        "--primary-foreground": "oklch(0.203 0.008 47)",
        "--secondary": "oklch(0.266 0.01 48)",
        "--secondary-foreground": "oklch(0.955 0.006 60)",
        "--muted": "oklch(0.266 0.01 48)",
        "--muted-foreground": "oklch(0.712 0.018 55)",
        "--accent": "oklch(0.266 0.01 48)",
        "--accent-foreground": "oklch(0.955 0.006 60)",
        "--brand": "oklch(0.705 0.148 33)",
        "--brand-foreground": "oklch(0.175 0.02 35)",
        "--border": "oklch(0.92 0.02 55 / 11%)",
        "--input": "oklch(0.92 0.02 55 / 16%)",
        "--ring": "oklch(0.56 0.06 40)",
        "--sidebar": "oklch(0.203 0.008 47)",
        "--sidebar-foreground": "oklch(0.955 0.006 60)",
        "--sidebar-primary": "oklch(0.705 0.148 33)",
        "--sidebar-primary-foreground": "oklch(0.175 0.02 35)",
        "--sidebar-accent": "oklch(0.266 0.01 48)",
        "--sidebar-accent-foreground": "oklch(0.955 0.006 60)",
        "--sidebar-border": "oklch(0.92 0.02 55 / 11%)",
        "--sidebar-ring": "oklch(0.56 0.06 40)",
      },
    },
  },
  {
    id: "berry",
    label: "Berry",
    tagline: "Deep plum, raspberry accent.",
    preview: {
      accent: "oklch(0.6 0.21 356)",
      surface: "oklch(0.292 0.025 309)",
    },
    vars: {
      light: {
        "--background": "oklch(0.982 0.008 330)",
        "--foreground": "oklch(0.22 0.02 320)",
        "--card": "oklch(0.996 0.004 330)",
        "--card-foreground": "oklch(0.22 0.02 320)",
        "--popover": "oklch(0.996 0.004 330)",
        "--popover-foreground": "oklch(0.22 0.02 320)",
        "--primary": "oklch(0.26 0.03 320)",
        "--primary-foreground": "oklch(0.98 0.006 330)",
        "--secondary": "oklch(0.94 0.015 330)",
        "--secondary-foreground": "oklch(0.26 0.03 320)",
        "--muted": "oklch(0.94 0.015 330)",
        "--muted-foreground": "oklch(0.52 0.03 330)",
        "--accent": "oklch(0.94 0.015 330)",
        "--accent-foreground": "oklch(0.26 0.03 320)",
        "--brand": "oklch(0.55 0.21 356)",
        "--brand-foreground": "oklch(0.97 0.025 344)",
        "--border": "oklch(0.9 0.02 330)",
        "--input": "oklch(0.9 0.02 330)",
        "--ring": "oklch(0.68 0.1 350)",
        "--sidebar": "oklch(0.972 0.01 330)",
        "--sidebar-foreground": "oklch(0.22 0.02 320)",
        "--sidebar-primary": "oklch(0.55 0.21 356)",
        "--sidebar-primary-foreground": "oklch(0.97 0.025 344)",
        "--sidebar-accent": "oklch(0.94 0.015 330)",
        "--sidebar-accent-foreground": "oklch(0.26 0.03 320)",
        "--sidebar-border": "oklch(0.9 0.02 330)",
        "--sidebar-ring": "oklch(0.68 0.1 350)",
      },
      dark: {
        "--background": "oklch(0.205 0.021 307)",
        "--foreground": "oklch(0.975 0.006 305)",
        "--card": "oklch(0.252 0.022 309)",
        "--card-foreground": "oklch(0.975 0.006 305)",
        "--popover": "oklch(0.252 0.022 309)",
        "--popover-foreground": "oklch(0.975 0.006 305)",
        "--primary": "oklch(0.93 0.02 320)",
        "--primary-foreground": "oklch(0.24 0.022 309)",
        "--secondary": "oklch(0.313 0.031 310)",
        "--secondary-foreground": "oklch(0.975 0.006 305)",
        "--muted": "oklch(0.3 0.028 310)",
        "--muted-foreground": "oklch(0.735 0.035 325)",
        "--accent": "oklch(0.313 0.031 310)",
        "--accent-foreground": "oklch(0.975 0.006 305)",
        "--brand": "oklch(0.6 0.21 356)",
        "--brand-foreground": "oklch(0.97 0.025 344)",
        "--border": "oklch(0.93 0.05 335 / 12%)",
        "--input": "oklch(0.93 0.05 335 / 17%)",
        "--ring": "oklch(0.6 0.15 350)",
        "--sidebar": "oklch(0.252 0.022 309)",
        "--sidebar-foreground": "oklch(0.975 0.006 305)",
        "--sidebar-primary": "oklch(0.6 0.21 356)",
        "--sidebar-primary-foreground": "oklch(0.97 0.025 344)",
        "--sidebar-accent": "oklch(0.313 0.031 310)",
        "--sidebar-accent-foreground": "oklch(0.975 0.006 305)",
        "--sidebar-border": "oklch(0.93 0.05 335 / 12%)",
        "--sidebar-ring": "oklch(0.6 0.15 350)",
      },
    },
  },
  {
    id: "grove",
    label: "Grove",
    tagline: "Deep moss, mint accent.",
    preview: {
      accent: "oklch(0.78 0.128 157)",
      surface: "oklch(0.298 0.022 163)",
    },
    vars: {
      light: {
        "--background": "oklch(0.982 0.006 160)",
        "--foreground": "oklch(0.21 0.015 165)",
        "--card": "oklch(0.996 0.003 160)",
        "--card-foreground": "oklch(0.21 0.015 165)",
        "--popover": "oklch(0.996 0.003 160)",
        "--popover-foreground": "oklch(0.21 0.015 165)",
        "--primary": "oklch(0.26 0.025 163)",
        "--primary-foreground": "oklch(0.98 0.004 160)",
        "--secondary": "oklch(0.94 0.012 160)",
        "--secondary-foreground": "oklch(0.26 0.025 163)",
        "--muted": "oklch(0.94 0.012 160)",
        "--muted-foreground": "oklch(0.5 0.025 165)",
        "--accent": "oklch(0.94 0.012 160)",
        "--accent-foreground": "oklch(0.26 0.025 163)",
        "--brand": "oklch(0.55 0.12 158)",
        "--brand-foreground": "oklch(0.98 0.004 160)",
        "--border": "oklch(0.9 0.015 160)",
        "--input": "oklch(0.9 0.015 160)",
        "--ring": "oklch(0.68 0.08 158)",
        "--sidebar": "oklch(0.972 0.008 160)",
        "--sidebar-foreground": "oklch(0.21 0.015 165)",
        "--sidebar-primary": "oklch(0.55 0.12 158)",
        "--sidebar-primary-foreground": "oklch(0.98 0.004 160)",
        "--sidebar-accent": "oklch(0.94 0.012 160)",
        "--sidebar-accent-foreground": "oklch(0.26 0.025 163)",
        "--sidebar-border": "oklch(0.9 0.015 160)",
        "--sidebar-ring": "oklch(0.68 0.08 158)",
      },
      dark: {
        "--background": "oklch(0.212 0.018 162)",
        "--foreground": "oklch(0.975 0.006 150)",
        "--card": "oklch(0.258 0.02 163)",
        "--card-foreground": "oklch(0.975 0.006 150)",
        "--popover": "oklch(0.258 0.02 163)",
        "--popover-foreground": "oklch(0.975 0.006 150)",
        "--primary": "oklch(0.93 0.015 160)",
        "--primary-foreground": "oklch(0.24 0.02 163)",
        "--secondary": "oklch(0.318 0.03 161)",
        "--secondary-foreground": "oklch(0.975 0.006 150)",
        "--muted": "oklch(0.3 0.027 161)",
        "--muted-foreground": "oklch(0.73 0.03 165)",
        "--accent": "oklch(0.318 0.03 161)",
        "--accent-foreground": "oklch(0.975 0.006 150)",
        "--brand": "oklch(0.78 0.128 157)",
        "--brand-foreground": "oklch(0.205 0.03 162)",
        "--border": "oklch(0.93 0.03 160 / 12%)",
        "--input": "oklch(0.93 0.03 160 / 17%)",
        "--ring": "oklch(0.6 0.09 158)",
        "--sidebar": "oklch(0.258 0.02 163)",
        "--sidebar-foreground": "oklch(0.975 0.006 150)",
        "--sidebar-primary": "oklch(0.78 0.128 157)",
        "--sidebar-primary-foreground": "oklch(0.205 0.03 162)",
        "--sidebar-accent": "oklch(0.318 0.03 161)",
        "--sidebar-accent-foreground": "oklch(0.975 0.006 150)",
        "--sidebar-border": "oklch(0.93 0.03 160 / 12%)",
        "--sidebar-ring": "oklch(0.6 0.09 158)",
      },
    },
  },
  {
    id: "ocean",
    label: "Ocean",
    tagline: "Deep slate blue, glacier accent.",
    preview: {
      accent: "oklch(0.745 0.105 241)",
      surface: "oklch(0.29 0.027 251)",
    },
    vars: {
      light: {
        "--background": "oklch(0.982 0.006 245)",
        "--foreground": "oklch(0.21 0.02 250)",
        "--card": "oklch(0.996 0.003 245)",
        "--card-foreground": "oklch(0.21 0.02 250)",
        "--popover": "oklch(0.996 0.003 245)",
        "--popover-foreground": "oklch(0.21 0.02 250)",
        "--primary": "oklch(0.26 0.03 250)",
        "--primary-foreground": "oklch(0.98 0.003 240)",
        "--secondary": "oklch(0.94 0.012 245)",
        "--secondary-foreground": "oklch(0.26 0.03 250)",
        "--muted": "oklch(0.94 0.012 245)",
        "--muted-foreground": "oklch(0.5 0.025 250)",
        "--accent": "oklch(0.94 0.012 245)",
        "--accent-foreground": "oklch(0.26 0.03 250)",
        "--brand": "oklch(0.55 0.13 245)",
        "--brand-foreground": "oklch(0.98 0.003 240)",
        "--border": "oklch(0.9 0.015 245)",
        "--input": "oklch(0.9 0.015 245)",
        "--ring": "oklch(0.68 0.08 243)",
        "--sidebar": "oklch(0.972 0.008 245)",
        "--sidebar-foreground": "oklch(0.21 0.02 250)",
        "--sidebar-primary": "oklch(0.55 0.13 245)",
        "--sidebar-primary-foreground": "oklch(0.98 0.003 240)",
        "--sidebar-accent": "oklch(0.94 0.012 245)",
        "--sidebar-accent-foreground": "oklch(0.26 0.03 250)",
        "--sidebar-border": "oklch(0.9 0.015 245)",
        "--sidebar-ring": "oklch(0.68 0.08 243)",
      },
      dark: {
        "--background": "oklch(0.205 0.024 250)",
        "--foreground": "oklch(0.975 0.005 240)",
        "--card": "oklch(0.25 0.025 251)",
        "--card-foreground": "oklch(0.975 0.005 240)",
        "--popover": "oklch(0.25 0.025 251)",
        "--popover-foreground": "oklch(0.975 0.005 240)",
        "--primary": "oklch(0.93 0.015 240)",
        "--primary-foreground": "oklch(0.24 0.025 251)",
        "--secondary": "oklch(0.31 0.038 246)",
        "--secondary-foreground": "oklch(0.975 0.005 240)",
        "--muted": "oklch(0.295 0.034 247)",
        "--muted-foreground": "oklch(0.725 0.03 255)",
        "--accent": "oklch(0.31 0.038 246)",
        "--accent-foreground": "oklch(0.975 0.005 240)",
        "--brand": "oklch(0.745 0.105 241)",
        "--brand-foreground": "oklch(0.2 0.035 250)",
        "--border": "oklch(0.93 0.03 245 / 12%)",
        "--input": "oklch(0.93 0.03 245 / 17%)",
        "--ring": "oklch(0.585 0.08 243)",
        "--sidebar": "oklch(0.25 0.025 251)",
        "--sidebar-foreground": "oklch(0.975 0.005 240)",
        "--sidebar-primary": "oklch(0.745 0.105 241)",
        "--sidebar-primary-foreground": "oklch(0.2 0.035 250)",
        "--sidebar-accent": "oklch(0.31 0.038 246)",
        "--sidebar-accent-foreground": "oklch(0.975 0.005 240)",
        "--sidebar-border": "oklch(0.93 0.03 245 / 12%)",
        "--sidebar-ring": "oklch(0.585 0.08 243)",
      },
    },
  },
  {
    id: "ember",
    label: "Ember",
    tagline: "Roasted brown, amber accent.",
    preview: {
      accent: "oklch(0.762 0.124 52)",
      surface: "oklch(0.29 0.02 44)",
    },
    vars: {
      light: {
        "--background": "oklch(0.984 0.007 60)",
        "--foreground": "oklch(0.22 0.015 45)",
        "--card": "oklch(0.997 0.003 55)",
        "--card-foreground": "oklch(0.22 0.015 45)",
        "--popover": "oklch(0.997 0.003 55)",
        "--popover-foreground": "oklch(0.22 0.015 45)",
        "--primary": "oklch(0.27 0.025 45)",
        "--primary-foreground": "oklch(0.985 0.004 55)",
        "--secondary": "oklch(0.945 0.014 55)",
        "--secondary-foreground": "oklch(0.27 0.025 45)",
        "--muted": "oklch(0.945 0.014 55)",
        "--muted-foreground": "oklch(0.52 0.02 45)",
        "--accent": "oklch(0.945 0.014 55)",
        "--accent-foreground": "oklch(0.27 0.025 45)",
        "--brand": "oklch(0.58 0.13 55)",
        "--brand-foreground": "oklch(0.99 0.005 60)",
        "--border": "oklch(0.9 0.018 55)",
        "--input": "oklch(0.9 0.018 55)",
        "--ring": "oklch(0.7 0.08 52)",
        "--sidebar": "oklch(0.974 0.009 55)",
        "--sidebar-foreground": "oklch(0.22 0.015 45)",
        "--sidebar-primary": "oklch(0.58 0.13 55)",
        "--sidebar-primary-foreground": "oklch(0.99 0.005 60)",
        "--sidebar-accent": "oklch(0.945 0.014 55)",
        "--sidebar-accent-foreground": "oklch(0.27 0.025 45)",
        "--sidebar-border": "oklch(0.9 0.018 55)",
        "--sidebar-ring": "oklch(0.7 0.08 52)",
      },
      dark: {
        "--background": "oklch(0.205 0.017 42)",
        "--foreground": "oklch(0.975 0.005 55)",
        "--card": "oklch(0.25 0.018 44)",
        "--card-foreground": "oklch(0.975 0.005 55)",
        "--popover": "oklch(0.25 0.018 44)",
        "--popover-foreground": "oklch(0.975 0.005 55)",
        "--primary": "oklch(0.93 0.012 55)",
        "--primary-foreground": "oklch(0.24 0.018 44)",
        "--secondary": "oklch(0.31 0.037 49)",
        "--secondary-foreground": "oklch(0.975 0.005 55)",
        "--muted": "oklch(0.295 0.032 48)",
        "--muted-foreground": "oklch(0.725 0.025 40)",
        "--accent": "oklch(0.31 0.037 49)",
        "--accent-foreground": "oklch(0.975 0.005 55)",
        "--brand": "oklch(0.762 0.124 52)",
        "--brand-foreground": "oklch(0.205 0.03 45)",
        "--border": "oklch(0.93 0.03 50 / 12%)",
        "--input": "oklch(0.93 0.03 50 / 17%)",
        "--ring": "oklch(0.59 0.085 51)",
        "--sidebar": "oklch(0.25 0.018 44)",
        "--sidebar-foreground": "oklch(0.975 0.005 55)",
        "--sidebar-primary": "oklch(0.762 0.124 52)",
        "--sidebar-primary-foreground": "oklch(0.205 0.03 45)",
        "--sidebar-accent": "oklch(0.31 0.037 49)",
        "--sidebar-accent-foreground": "oklch(0.975 0.005 55)",
        "--sidebar-border": "oklch(0.93 0.03 50 / 12%)",
        "--sidebar-ring": "oklch(0.59 0.085 51)",
      },
    },
  },
  {
    id: "iris",
    label: "Iris",
    tagline: "Dark violet, lavender accent.",
    preview: {
      accent: "oklch(0.672 0.168 294)",
      surface: "oklch(0.283 0.035 295)",
    },
    vars: {
      light: {
        "--background": "oklch(0.982 0.008 295)",
        "--foreground": "oklch(0.22 0.025 295)",
        "--card": "oklch(0.996 0.004 295)",
        "--card-foreground": "oklch(0.22 0.025 295)",
        "--popover": "oklch(0.996 0.004 295)",
        "--popover-foreground": "oklch(0.22 0.025 295)",
        "--primary": "oklch(0.26 0.04 295)",
        "--primary-foreground": "oklch(0.98 0.005 300)",
        "--secondary": "oklch(0.94 0.018 295)",
        "--secondary-foreground": "oklch(0.26 0.04 295)",
        "--muted": "oklch(0.94 0.018 295)",
        "--muted-foreground": "oklch(0.51 0.035 295)",
        "--accent": "oklch(0.94 0.018 295)",
        "--accent-foreground": "oklch(0.26 0.04 295)",
        "--brand": "oklch(0.56 0.19 294)",
        "--brand-foreground": "oklch(0.98 0.005 300)",
        "--border": "oklch(0.9 0.02 295)",
        "--input": "oklch(0.9 0.02 295)",
        "--ring": "oklch(0.68 0.11 294)",
        "--sidebar": "oklch(0.972 0.01 295)",
        "--sidebar-foreground": "oklch(0.22 0.025 295)",
        "--sidebar-primary": "oklch(0.56 0.19 294)",
        "--sidebar-primary-foreground": "oklch(0.98 0.005 300)",
        "--sidebar-accent": "oklch(0.94 0.018 295)",
        "--sidebar-accent-foreground": "oklch(0.26 0.04 295)",
        "--sidebar-border": "oklch(0.9 0.02 295)",
        "--sidebar-ring": "oklch(0.68 0.11 294)",
      },
      dark: {
        "--background": "oklch(0.2 0.03 294)",
        "--foreground": "oklch(0.975 0.006 300)",
        "--card": "oklch(0.243 0.032 295)",
        "--card-foreground": "oklch(0.975 0.006 300)",
        "--popover": "oklch(0.243 0.032 295)",
        "--popover-foreground": "oklch(0.975 0.006 300)",
        "--primary": "oklch(0.93 0.018 300)",
        "--primary-foreground": "oklch(0.235 0.032 295)",
        "--secondary": "oklch(0.305 0.055 294)",
        "--secondary-foreground": "oklch(0.975 0.006 300)",
        "--muted": "oklch(0.29 0.048 294)",
        "--muted-foreground": "oklch(0.72 0.03 300)",
        "--accent": "oklch(0.305 0.055 294)",
        "--accent-foreground": "oklch(0.975 0.006 300)",
        "--brand": "oklch(0.672 0.168 294)",
        "--brand-foreground": "oklch(0.185 0.04 294)",
        "--border": "oklch(0.93 0.04 300 / 13%)",
        "--input": "oklch(0.93 0.04 300 / 18%)",
        "--ring": "oklch(0.6 0.11 294)",
        "--sidebar": "oklch(0.243 0.032 295)",
        "--sidebar-foreground": "oklch(0.975 0.006 300)",
        "--sidebar-primary": "oklch(0.672 0.168 294)",
        "--sidebar-primary-foreground": "oklch(0.185 0.04 294)",
        "--sidebar-accent": "oklch(0.305 0.055 294)",
        "--sidebar-accent-foreground": "oklch(0.975 0.006 300)",
        "--sidebar-border": "oklch(0.93 0.04 300 / 13%)",
        "--sidebar-ring": "oklch(0.6 0.11 294)",
      },
    },
  },
];

const THEME_KEY = "monad-theme";
const SCHEME_KEY = "monad-scheme";
const DEFAULT_ID = THEMES[0].id;
/** "dark" (not "system"): the app shipped dark-only, so existing installs
 *  keep looking exactly the same until the user opts into Light or System. */
const DEFAULT_SCHEME: ColorScheme = "dark";

/** Every property any theme touches in either scheme — switching must clear
 *  the ones the new theme/scheme doesn't set, or the default theme would
 *  inherit stale overrides. */
const ALL_VARS = [
  ...new Set(
    THEMES.flatMap((t) => [
      ...Object.keys(t.vars.light),
      ...Object.keys(t.vars.dark),
    ]),
  ),
];

let currentTheme = ((): string => {
  const id = localStorage.getItem(THEME_KEY);
  return THEMES.some((t) => t.id === id) ? id! : DEFAULT_ID;
})();

let currentScheme = ((): ColorScheme => {
  const s = localStorage.getItem(SCHEME_KEY);
  return COLOR_SCHEMES.includes(s as ColorScheme)
    ? (s as ColorScheme)
    : DEFAULT_SCHEME;
})();

const systemDark = window.matchMedia("(prefers-color-scheme: dark)");

function resolvedDark(): boolean {
  return (
    currentScheme === "dark" ||
    (currentScheme === "system" && systemDark.matches)
  );
}

function apply() {
  const dark = resolvedDark();
  const root = document.documentElement;
  // A theme flip repaints color/background/border on nearly every element at
  // once; left alone each one's own transition fires and the switch smears.
  // Kill transitions for the swap, force a reflow so the new values land
  // un-animated, then restore on the next frame.
  const freeze = document.createElement("style");
  freeze.textContent = "*,*::before,*::after{transition:none !important}";
  document.head.appendChild(freeze);
  root.classList.toggle("dark", dark);
  const theme = THEMES.find((t) => t.id === currentTheme) ?? THEMES[0];
  const vars = dark ? theme.vars.dark : theme.vars.light;
  for (const v of ALL_VARS) {
    if (v in vars) root.style.setProperty(v, vars[v]);
    else root.style.removeProperty(v);
  }
  void window.getComputedStyle(root).opacity;
  requestAnimationFrame(() => freeze.remove());
}
apply(); // module load runs before first render — no flash of the default

const listeners = new Set<() => void>();
const notify = () => {
  for (const l of listeners) l();
};

systemDark.addEventListener("change", () => {
  // Only observable under "system"; apply() is cheap enough to just re-run.
  if (currentScheme === "system") {
    apply();
    notify();
  }
});

export function setTheme(id: string) {
  if (!THEMES.some((t) => t.id === id) || id === currentTheme) return;
  currentTheme = id;
  if (id === DEFAULT_ID) localStorage.removeItem(THEME_KEY);
  else localStorage.setItem(THEME_KEY, id);
  apply();
  notify();
}

export function setScheme(scheme: ColorScheme) {
  if (!COLOR_SCHEMES.includes(scheme) || scheme === currentScheme) return;
  currentScheme = scheme;
  if (scheme === DEFAULT_SCHEME) localStorage.removeItem(SCHEME_KEY);
  else localStorage.setItem(SCHEME_KEY, scheme);
  apply();
  notify();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useThemeId(): string {
  return useSyncExternalStore(subscribe, () => currentTheme);
}

export function useScheme(): ColorScheme {
  return useSyncExternalStore(subscribe, () => currentScheme);
}

/** The scheme actually painting right now — "system" resolved to the OS
 *  preference; subscribers re-render when that flips live. */
export function useResolvedScheme(): "light" | "dark" {
  return useSyncExternalStore(subscribe, () =>
    resolvedDark() ? "dark" : "light",
  );
}
