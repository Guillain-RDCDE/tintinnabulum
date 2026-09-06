// Wikimedia: the encyclopedias and their sister projects.

import { sseSource, websocketSource } from './transports.js';

const IP_RE = /^(\d{1,3}\.){3}\d{1,3}$|:/;

/**
 * Wikipedia recent changes.
 *
 * backend 'eventstreams' (default) uses Wikimedia's own public SSE endpoint:
 * HTTPS, no Hatnote infrastructure, every wiki on one connection. That makes
 * the whole thing hostable as static files.
 *
 * backend 'wikimon' keeps the original Hatnote WebSockets, which carry extras
 * EventStreams does not: geo_ip, hashtags, mentions, is_anon.
 */
export function wikipedia({
  langs = ['en'],
  backend = 'eventstreams',
  mainNamespaceOnly = true,
  welcomeNewUsers = true,
  project = 'wikipedia',
  // Explicit wiki names, for the sister projects: commonswiki, wikidatawiki,
  // enwiktionary and so on. Overrides `langs` when given.
  wikis: explicitWikis = null,
  onStatus = null,
} = {}) {
  const wikis = explicitWikis
    ? new Set(explicitWikis)
    : new Set(langs.map((l) => l + (project === 'wikipedia' ? 'wiki' : project)));

  if (backend === 'eventstreams') {
    return sseSource({
      name: 'wikipedia/eventstreams',
      url: 'https://stream.wikimedia.org/v2/stream/recentchange',
      onStatus,
      map(d) {
        if (!d || !wikis.has(d.wiki)) return null;

        if (d.type === 'log') {
          if (!welcomeNewUsers || d.log_type !== 'newusers') return null;
          return {
            magnitude: 1,
            polarity: 0,
            id: 'newuser:' + d.user,
            label: `Welcome, ${d.user} has joined Wikipedia!`,
            url: d.meta && d.meta.uri,
            category: 'alert',
            accent: true,
            source: d.wiki,
            data: d,
          };
        }
        if (d.type !== 'edit' && d.type !== 'new') return null;
        if (mainNamespaceOnly && d.namespace !== 0) return null;

        const len = d.length || {};
        const delta = (len.new || 0) - (len.old || 0);
        // EventStreams has no is_anon flag; an IP-shaped username is the
        // standard proxy for it.
        const anon = IP_RE.test(d.user || '');
        return {
          magnitude: Math.abs(delta),
          polarity: Math.sign(delta),
          id: d.title,
          label: d.title,
          url: (d.meta && d.meta.uri) || d.server_url + '/wiki/' + encodeURIComponent(d.title),
          category: d.bot ? 'bot' : anon ? 'anon' : 'user',
          source: d.wiki,
          data: d,
        };
      },
    });
  }

  if (backend !== 'wikimon') throw new Error('Unknown Wikipedia backend: ' + backend);

  // One socket per language, as the original did.
  const secure = typeof location === 'undefined' || location.protocol === 'https:';
  const children = langs.map((lang) =>
    websocketSource({
      name: 'wikimon/' + lang,
      url: secure
        ? `wss://wikimon.hatnote.com/v2/${lang}/`
        : `ws://wikimon.hatnote.com:${WIKIMON_PORTS[lang] || 9000}`,
      onStatus,
      map(d) {
        if (!d) return null;
        if (d.page_title === 'Special:Log/newusers' && d.url !== 'byemail') {
          if (!welcomeNewUsers) return null;
          return {
            magnitude: 1,
            polarity: 0,
            id: 'newuser:' + d.user,
            label: `Welcome, ${d.user} has joined ${lang} Wikipedia!`,
            url: `https://${lang}.wikipedia.org/wiki/User_talk:${encodeURIComponent(d.user)}`,
            category: 'alert',
            accent: true,
            source: lang,
            data: d,
          };
        }
        if (mainNamespaceOnly && d.ns !== 'Main') return null;
        const size = Number(d.change_size);
        if (!Number.isFinite(size)) return null;
        return {
          magnitude: Math.abs(size),
          polarity: Math.sign(size),
          id: d.page_title,
          label: d.page_title,
          url: d.url,
          category: d.is_bot ? 'bot' : d.is_anon ? 'anon' : 'user',
          source: lang,
          data: d, // keeps geo_ip, hashtags, mentions, rev_id available downstream
        };
      },
    })
  );

  return {
    name: 'wikipedia/wikimon',
    children,
    start(emit) {
      children.forEach((c) => c.start(emit));
    },
    stop() {
      children.forEach((c) => c.stop());
    },
  };
}

/** Legacy per-language ports, only needed for the plain-ws fallback. */
export const WIKIMON_PORTS = {
  en: 9000, de: 9010, ru: 9020, ja: 9030, es: 9040, fr: 9050, nl: 9060,
  it: 9070, sv: 9080, ar: 9090, id: 9100, ta: 9110, pa: 9120, mr: 9130,
  hi: 9140, as: 9150, bn: 9160, te: 9165, kn: 9170, or: 9180, sa: 9190,
  gu: 9200, fa: 9210, wikidata: 9220, he: 9230, zh: 9240, ml: 9250,
  pl: 9260, mk: 9270, be: 9280, sr: 9290, bg: 9300, uk: 9310, hu: 9320,
  fi: 9330, no: 9340, el: 9350, eo: 9360, pt: 9370, et: 9380, ur: 9390,
  ro: 9400, hy: 9410,
};

/**
 * Wikipedia languages for a picker: code, English name, endonym, and a flag.
 *
 * Flags are countries and languages are not, so these are a visual cue and
 * nothing more -- the endonym is the identifier. Ten of the Indic editions
 * necessarily share one flag, which is why every entry also carries its name
 * in its own script: Tamil, Kannada and Gujarati are told apart at a glance by
 * their writing, never by the flag above it. Esperanto belongs to no country
 * at all and takes a globe.
 */
/**
 * Which flag image stands for each edition.
 *
 * Kept separate from the emoji above because emoji flags are unusable in
 * practice: Windows ships no country-flag glyphs at all, so every browser on
 * it draws the two letters instead -- "GB", "FR". An interface built on them
 * is broken for a large share of visitors, which is why the picker uses SVG
 * images and these codes rather than the emoji.
 */
export const WIKIPEDIA_FLAG_CC = {
  en: 'gb', fr: 'fr', de: 'de', es: 'es', it: 'it', pt: 'pt', nl: 'nl',
  sv: 'se', no: 'no', fi: 'fi', et: 'ee', pl: 'pl', ru: 'ru', uk: 'ua',
  be: 'by', bg: 'bg', sr: 'rs', mk: 'mk', ro: 'ro', hu: 'hu', el: 'gr',
  he: 'il', hy: 'am', fa: 'ir', ur: 'pk', ar: 'sa', ja: 'jp', zh: 'cn',
  id: 'id', bn: 'bd', eo: 'eo',
  // Ten editions of Indic languages share one flag, which is why every entry
  // also carries its own script underneath: those are what tell them apart.
  hi: 'in', ta: 'in', te: 'in', ml: 'in', kn: 'in', mr: 'in',
  gu: 'in', pa: 'in', or: 'in', as: 'in', sa: 'in',
};

export const WIKIPEDIA_LANGUAGES = [
  { code: 'en', name: 'English', native: 'English', flag: '🇬🇧' },
  { code: 'fr', name: 'French', native: 'Français', flag: '🇫🇷' },
  { code: 'de', name: 'German', native: 'Deutsch', flag: '🇩🇪' },
  { code: 'es', name: 'Spanish', native: 'Español', flag: '🇪🇸' },
  { code: 'it', name: 'Italian', native: 'Italiano', flag: '🇮🇹' },
  { code: 'pt', name: 'Portuguese', native: 'Português', flag: '🇵🇹' },
  { code: 'nl', name: 'Dutch', native: 'Nederlands', flag: '🇳🇱' },
  { code: 'sv', name: 'Swedish', native: 'Svenska', flag: '🇸🇪' },
  { code: 'no', name: 'Norwegian', native: 'Norsk', flag: '🇳🇴' },
  { code: 'fi', name: 'Finnish', native: 'Suomi', flag: '🇫🇮' },
  { code: 'et', name: 'Estonian', native: 'Eesti', flag: '🇪🇪' },
  { code: 'pl', name: 'Polish', native: 'Polski', flag: '🇵🇱' },
  { code: 'ru', name: 'Russian', native: 'Русский', flag: '🇷🇺' },
  { code: 'uk', name: 'Ukrainian', native: 'Українська', flag: '🇺🇦' },
  { code: 'be', name: 'Belarusian', native: 'Беларуская', flag: '🇧🇾' },
  { code: 'bg', name: 'Bulgarian', native: 'Български', flag: '🇧🇬' },
  { code: 'sr', name: 'Serbian', native: 'Српски', flag: '🇷🇸' },
  { code: 'mk', name: 'Macedonian', native: 'Македонски', flag: '🇲🇰' },
  { code: 'ro', name: 'Romanian', native: 'Română', flag: '🇷🇴' },
  { code: 'hu', name: 'Hungarian', native: 'Magyar', flag: '🇭🇺' },
  { code: 'el', name: 'Greek', native: 'Ελληνικά', flag: '🇬🇷' },
  { code: 'he', name: 'Hebrew', native: 'עברית', flag: '🇮🇱' },
  { code: 'hy', name: 'Armenian', native: 'Հայերեն', flag: '🇦🇲' },
  { code: 'fa', name: 'Persian', native: 'فارسی', flag: '🇮🇷' },
  { code: 'ur', name: 'Urdu', native: 'اردو', flag: '🇵🇰' },
  { code: 'ar', name: 'Arabic', native: 'العربية', flag: '🇸🇦' },
  { code: 'ja', name: 'Japanese', native: '日本語', flag: '🇯🇵' },
  { code: 'zh', name: 'Chinese', native: '中文', flag: '🇨🇳' },
  { code: 'id', name: 'Indonesian', native: 'Bahasa Indonesia', flag: '🇮🇩' },
  { code: 'hi', name: 'Hindi', native: 'हिन्दी', flag: '🇮🇳' },
  { code: 'bn', name: 'Bengali', native: 'বাংলা', flag: '🇧🇩' },
  { code: 'ta', name: 'Tamil', native: 'தமிழ்', flag: '🇮🇳' },
  { code: 'te', name: 'Telugu', native: 'తెలుగు', flag: '🇮🇳' },
  { code: 'ml', name: 'Malayalam', native: 'മലയാളം', flag: '🇮🇳' },
  { code: 'kn', name: 'Kannada', native: 'ಕನ್ನಡ', flag: '🇮🇳' },
  { code: 'mr', name: 'Marathi', native: 'मराठी', flag: '🇮🇳' },
  { code: 'gu', name: 'Gujarati', native: 'ગુજરાતી', flag: '🇮🇳' },
  { code: 'pa', name: 'Punjabi', native: 'ਪੰਜਾਬੀ', flag: '🇮🇳' },
  { code: 'or', name: 'Odia', native: 'ଓଡ଼ିଆ', flag: '🇮🇳' },
  { code: 'as', name: 'Assamese', native: 'অসমীয়া', flag: '🇮🇳' },
  { code: 'sa', name: 'Sanskrit', native: 'संस्कृतम्', flag: '🇮🇳' },
  { code: 'eo', name: 'Esperanto', native: 'Esperanto', flag: '🌍' },
];
