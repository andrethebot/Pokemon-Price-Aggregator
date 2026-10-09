// SNKRDUNK: uses the public JSON endpoints the snkrdunk.com/en site itself calls.
//   search:   /en/v2/search?keyword=...            (products carry a productCode like "SW---146897")
//   listings: /en/v2/products/{code}/used-listings?sortType=latest  (items carry isSold, no dates)
// No account or key needed. The site's own "recent sales" panel needs a sign-up, so this reads the
// listings feed instead and keeps the sold ones. Listings have no sold date; the date shown is when
// the listing was created, decoded from its ULID uid.
// Unsold listings in the same feed are the current listings. SNKRDUNK is fixed-price only, so all are Buy Now.

import { BROWSER_UA, fetchWithTimeout, sourceResult } from '../util.js';

const BASE = 'https://snkrdunk.com/en/v2';
const HEADERS = { 'User-Agent': BROWSER_UA, Accept: 'application/json', 'Accept-Language': 'en-US,en;q=0.9' };

async function getJson(url) {
  const res = await fetchWithTimeout(url, { headers: HEADERS });
  if (!res.ok) {
    const err = new Error(`SNKRDUNK returned HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// A ULID's first 10 characters are its creation time in ms, in Crockford base32.
export function ulidDate(uid) {
  const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const head = String(uid ?? '').toUpperCase().slice(0, 10);
  if (head.length < 10) return null;
  let ms = 0;
  for (const ch of head) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) return null;
    ms = ms * 32 + v;
  }
  return new Date(ms).toISOString();
}

// Score a product name against the user's fields so "Charizard 4/102" prefers the right print.
function scoreProduct(product, { name, set, number }) {
  const hay = String(product.name ?? '').toLowerCase();
  let score = 0;
  for (const token of `${name} ${set}`.toLowerCase().split(/\s+/).filter(Boolean)) {
    if (hay.includes(token)) score += 1;
  }
  if (number) {
    const num = String(number).toLowerCase().split('/')[0].replace(/^0+/, '');
    if (num && new RegExp(`(^|[^\\d])0*${num}([^\\d]|$)`).test(hay)) score += 3;
  }
  return score;
}

export async function searchSnkrdunk(fields, { query, limit = 20 }) {
  const searchUrl = `https://snkrdunk.com/en/search/result?keyword=${encodeURIComponent(query)}`;
  try {
    const search = await getJson(`${BASE}/search?keyword=${encodeURIComponent(query)}&page=1&perPage=24&stock=any&sortKey=default`);
    // Search mixes catalog products and single listings; one entry per product code is enough.
    const byCode = new Map();
    for (const p of [...(search.search?.rankingProducts ?? []), ...(search.search?.products ?? [])]) {
      if (p.productCode && /^tradingCard/.test(p.productTypeGB ?? '') && !byCode.has(p.productCode)) byCode.set(p.productCode, p);
    }
    const products = [...byCode.values()];
    if (!products.length) {
      return sourceResult('SNKRDUNK', { status: 'empty', message: 'No matching card on SNKRDUNK.', searchUrl });
    }
    const best = [...products].sort((a, b) => scoreProduct(b, fields) - scoreProduct(a, fields))[0];
    const productUrl = `https://snkrdunk.com/en/trading-cards/${best.productCode.replace(/^SW---/, '')}`;

    const pages = await Promise.allSettled(
      [1, 2, 3].map((page) =>
        getJson(`${BASE}/products/${best.productCode}/used-listings?page=${page}&perPage=50&sortType=latest`),
      ),
    );
    if (pages[0].status === 'rejected') throw pages[0].reason;
    const items = pages.flatMap((p) => (p.status === 'fulfilled' ? p.value.usedListings ?? [] : []));

    const toRow = (item) => ({
      title: best.name,
      condition: item.condition ?? null,
      type: 'buy_now',
      price: item.price?.value ?? null,
      priceText: `${item.price?.currencySymbol ?? ''}${item.price?.value ?? ''}`,
      currency: item.price?.currencyCode ?? 'USD',
      url: item.url ?? productUrl,
      image: item.thumbnailUrl ?? best.thumbnailUrl ?? null,
    });

    const listings = items
      .filter((item) => !item.isSold)
      .map((item) => ({ ...toRow(item), bids: null, endsAt: null, listedAt: ulidDate(item.uid) }))
      .filter((r) => r.price != null)
      .slice(0, limit);

    const results = items
      .filter((item) => item.isSold)
      .map((item) => ({ ...toRow(item), soldAt: ulidDate(item.uid) }))
      .filter((r) => r.price != null)
      .sort((a, b) => String(b.soldAt).localeCompare(String(a.soldAt)))
      .slice(0, limit);

    return sourceResult('SNKRDUNK', {
      status: results.length ? 'ok' : 'empty',
      message:
        `Matched "${best.name}".` +
        (results.length ? ' Dates are when each sold listing was posted.' : ' No recent sales found.'),
      searchUrl: productUrl,
      results,
      listings,
    });
  } catch (err) {
    const blocked = err.status === 403 || err.status === 429;
    return sourceResult('SNKRDUNK', {
      status: blocked ? 'blocked' : 'error',
      message: blocked ? `SNKRDUNK refused the request (HTTP ${err.status}).` : `SNKRDUNK lookup failed: ${err.message}`,
      searchUrl,
    });
  }
}
