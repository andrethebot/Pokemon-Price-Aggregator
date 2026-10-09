// Shared helpers for the price sources.

export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';

// fetch with a timeout so one slow site never holds up the whole search.
export async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// "US $1,234.56" -> 1234.56, "¥12,000" -> 12000. Returns null when no number is found.
export function parsePrice(text) {
  if (text == null) return null;
  if (typeof text === 'number') return Number.isFinite(text) ? text : null;
  const match = String(text).replace(/,/g, '').match(/\d+(\.\d+)?/);
  return match ? Number(match[0]) : null;
}

export function guessCurrency(text, fallback = 'USD') {
  const s = String(text ?? '');
  if (/¥|JPY|円/.test(s)) return 'JPY';
  if (/£|GBP/.test(s)) return 'GBP';
  if (/€|EUR/.test(s)) return 'EUR';
  if (/C\s?\$|CAD/.test(s)) return 'CAD';
  if (/AU\s?\$|AUD/.test(s)) return 'AUD';
  if (/HK\s?\$|HKD/.test(s)) return 'HKD';
  if (/\$|USD/.test(s)) return 'USD';
  return fallback;
}

// Accepts ISO strings, epoch seconds/ms, or human dates like "Oct 3, 2026".
export function toIsoDate(value) {
  if (value == null || value === '') return null;
  let d;
  if (typeof value === 'number') d = new Date(value < 1e12 ? value * 1000 : value);
  else {
    const s = String(value).replace(/^Sold\s+/i, '').trim();
    d = new Date(s);
    // A bare date like "Oct 3, 2026" parses as local midnight; keep the calendar day in UTC.
    if (!Number.isNaN(d.getTime()) && !/\d:\d|T\d|Z$/i.test(s) && !/^\d{4}-\d\d-\d\d$/.test(s)) {
      d = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    }
  }
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// Build one search string from the form fields: "Charizard 4/102 Base Set".
export function buildQuery({ name = '', set = '', number = '' }) {
  return [name, number, set].map((s) => String(s).trim()).filter(Boolean).join(' ');
}

// Loose grade filter applied to each result's title/condition text.
// grade: '' (any), 'raw', or something like 'PSA 10', 'BGS 9.5', 'CGC 10'.
export function matchesGrade(text, grade) {
  if (!grade) return true;
  const t = String(text ?? '').toUpperCase().replace(/\s+/g, ' ');
  if (grade === 'raw') return !/\b(PSA|BGS|CGC|SGC|ACE|TAG|BECKETT)\b/.test(t);
  const [company, num] = grade.toUpperCase().split(' ');
  const re = new RegExp(`\\b${company}\\s?${num.replace('.', '\\.')}(?![\\d.])`);
  return re.test(t);
}

export function sourceResult(source, fields) {
  // results: recent sales. listings: items for sale now, each with type 'auction' or 'buy_now'.
  return { source, status: 'ok', message: '', searchUrl: null, results: [], listings: [], listingsMessage: '', ...fields };
}
