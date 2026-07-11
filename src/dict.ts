// A small bundled dictionary of common English + French words used to filter out
// obvious false positives in the capitalized-word name/org heuristic
// (see anonymize.ts). Everything is lowercased. This is intentionally offline and
// static — no network, no locale APIs — so detection stays deterministic.

/** Lowercased common words: EN + FR stopwords, sentence starters, days/months,
 *  and frequent capitalized non-PII words (Internet, OK, AI, GPT…). */
export const COMMON_WORDS: Set<string> = new Set<string>([
  // --- English stopwords / very common words ---
  "the", "a", "an", "and", "or", "but", "if", "then", "else", "when", "while",
  "of", "to", "in", "on", "at", "by", "for", "with", "about", "against", "between",
  "into", "through", "during", "before", "after", "above", "below", "from", "up",
  "down", "out", "off", "over", "under", "again", "further", "here", "there",
  "all", "any", "both", "each", "few", "more", "most", "other", "some", "such",
  "no", "nor", "not", "only", "own", "same", "so", "than", "too", "very", "can",
  "will", "just", "should", "now", "is", "am", "are", "was", "were", "be", "been",
  "being", "have", "has", "had", "having", "do", "does", "did", "doing", "would",
  "could", "shall", "may", "might", "must", "this", "that", "these", "those",
  "i", "you", "he", "she", "it", "we", "they", "me", "him", "her", "us", "them",
  "my", "your", "his", "its", "our", "their", "mine", "yours", "ours", "theirs",
  "who", "whom", "whose", "which", "what", "where", "why", "how", "as", "because",
  "until", "yet", "also", "however", "therefore", "thus", "hence", "meanwhile",
  "please", "thanks", "thank", "hello", "hi", "hey", "yes", "ok", "okay", "sure",
  "let", "lets", "get", "got", "make", "made", "see", "saw", "seen", "use", "used",
  "using", "need", "needs", "want", "wants", "like", "likes", "know", "knew",
  "think", "thought", "say", "said", "tell", "told", "ask", "asked", "give",
  "given", "take", "took", "taken", "find", "found", "look", "looks", "come",
  "came", "go", "goes", "went", "gone", "good", "great", "bad", "new", "old",
  "first", "last", "next", "one", "two", "three", "many", "much", "little", "big",
  "small", "high", "low", "right", "wrong", "true", "false", "sorry", "welcome",
  "well", "back", "still", "even", "ever", "never", "always", "often", "sometimes",
  "today", "tomorrow", "yesterday", "tonight", "morning", "afternoon", "evening",
  "night", "week", "month", "year", "time", "day", "days", "hour", "minute",
  "second", "please", "help", "user", "assistant", "system", "message", "error",
  "output", "input", "result", "results", "value", "data", "code", "test", "file",
  "name", "email", "phone", "number", "address", "company", "team", "project",
  "task", "step", "steps", "question", "answer", "example", "note", "notes",
  // --- Days / months (English) ---
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "january", "february", "march", "april", "may", "june", "july", "august",
  "september", "october", "november", "december",
  // --- Frequent capitalized non-PII words ---
  "internet", "web", "online", "email", "api", "url", "http", "https", "ai",
  "gpt", "llm", "chatgpt", "claude", "google", "openai", "anthropic", "python",
  "javascript", "typescript", "json", "html", "css", "sql", "pdf", "csv",
  "english", "french", "spanish", "german", "italian", "european", "american",
  // --- French stopwords / very common words ---
  "le", "la", "les", "un", "une", "des", "du", "de", "et", "ou", "mais", "donc",
  "car", "ni", "or", "que", "qui", "quoi", "dont", "ou", "quand", "comme",
  "si", "ne", "pas", "plus", "moins", "tres", "trop", "peu", "beaucoup", "bien",
  "mal", "aussi", "encore", "deja", "toujours", "jamais", "souvent", "parfois",
  "ici", "la", "ceci", "cela", "ca", "celui", "celle", "ceux", "celles",
  "ce", "cet", "cette", "ces", "mon", "ton", "son", "notre", "votre", "leur",
  "mes", "tes", "ses", "nos", "vos", "leurs", "je", "tu", "il", "elle", "nous",
  "vous", "ils", "elles", "on", "moi", "toi", "lui", "eux", "me", "te", "se",
  "au", "aux", "avec", "sans", "sous", "sur", "dans", "chez", "vers", "entre",
  "pour", "par", "pendant", "avant", "apres", "depuis", "jusque", "contre",
  "etre", "avoir", "faire", "aller", "venir", "voir", "savoir", "pouvoir",
  "vouloir", "devoir", "dire", "prendre", "donner", "mettre", "est", "sont",
  "etait", "etaient", "sera", "seront", "suis", "es", "sommes", "etes", "ete",
  "ai", "as", "avons", "avez", "ont", "avait", "avaient", "aura", "auront",
  "fait", "faits", "bonjour", "bonsoir", "salut", "merci", "oui", "non",
  "peut", "etre", "voici", "voila", "alors", "ensuite", "puis", "enfin",
  "aujourd", "hui", "demain", "hier", "matin", "soir", "nuit", "jour", "jours",
  "semaine", "mois", "annee", "an", "temps", "heure", "minute", "seconde",
  "utilisateur", "reponse", "question", "exemple", "erreur", "resultat",
  "entreprise", "equipe", "projet", "tache", "fichier", "numero", "adresse",
  // --- Days / months (French) ---
  "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche",
  "janvier", "fevrier", "mars", "avril", "mai", "juin", "juillet", "aout",
  "septembre", "octobre", "novembre", "decembre",
]);

/** Return the default bundled dictionary (lowercased common words). */
export function defaultDict(): Set<string> {
  return COMMON_WORDS;
}
