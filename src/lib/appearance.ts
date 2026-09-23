export function colorTheme(settings: Readonly<Record<string, string | undefined>>): 'dark' | 'light' {
  return settings.color_theme === 'light' ? 'light' : 'dark'
}

/** Preserve the old collection preference until a global choice is explicitly saved. */
export function textContrastMode(settings: Readonly<Record<string, string | undefined>>): 'high' | 'normal' {
  return (settings.high_contrast_text ?? settings.collection_high_contrast_text) === '1' ? 'high' : 'normal'
}
