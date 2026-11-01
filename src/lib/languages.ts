export interface LanguageInfo {
  /** Short code such as "hi". */
  code: string;
  /** Human readable name such as "Hindi". */
  name: string;
  /** Native label shown as a hint in the UI. */
  native?: string;
}

const LANGUAGES: Record<string, LanguageInfo> = {
  hi: { code: "hi", name: "Hindi", native: "हिन्दी" },
  en: { code: "en", name: "English", native: "English" },
  gu: { code: "gu", name: "Gujarati", native: "ગુજરાતી" },
  ta: { code: "ta", name: "Tamil", native: "தமிழ்" },
  te: { code: "te", name: "Telugu", native: "తెలుగు" },
  kn: { code: "kn", name: "Kannada", native: "ಕನ್ನಡ" },
  ml: { code: "ml", name: "Malayalam", native: "മലയാളം" },
  mr: { code: "mr", name: "Marathi", native: "मराठी" },
  bn: { code: "bn", name: "Bengali", native: "বাংলা" },
  pa: { code: "pa", name: "Punjabi", native: "ਪੰਜਾਬੀ" },
  ur: { code: "ur", name: "Urdu", native: "اردو" },
};

/** Gnani returns values such as "hi", "hi-IN" or "indic-auto". */
export function describeLanguage(raw?: string | null): LanguageInfo | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const short = trimmed.split(/[-_]/)[0].toLowerCase();
  const known = LANGUAGES[short];
  if (known) return known;

  if (short === "auto" || short === "indic") {
    return { code: "auto", name: "Auto-detect" };
  }

  return { code: short, name: trimmed.toUpperCase() };
}
