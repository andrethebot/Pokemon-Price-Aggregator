// eBay: reads the public "Sold items" search page (LH_Sold=1&LH_Complete=1) and parses the results.
//
// eBay has no open API for sold prices: the old Finding API (findCompletedItems) is retired and the
// Marketplace Insights API is limited to approved partners. Reports from mid-2026 say eBay now sends
// signed-out visitors on sold searches to a sign-in page; when that happens this source reports
// "blocked" and the page still links to the sold search so it can be opened in a signed-in browser.
//
// Current listings come from eBay's official Browse API (item_summary/search), which an app can call
// with its own developer keys and no user sign-in. Set EBAY_CLIENT_ID and EBAY_CLIENT_SECRET (a free
// eBay Developer Program keyset, Production) to turn it on. buyingOptions says AUCTION or FIXED_PRICE.

import * as cheerio from 'cheerio';
import { BROWSER_UA, fetchWithTimeout, parsePrice, guessCurrency, toIsoDate, sourceResult } from '../util.js';

const POKEMON_SINGLES_CATEGORY = '183454'; // CCG Individual Cards

export function ebaySoldUrl(query) {
  const params = new URLSearchParams({
    _nkw: query,
    _sacat: POKEMON_SINGLES_CATEGORY,
    LH_Sold: '1',
    LH_Complete: '1',
    _sop: '13', // most recently ended first
    _ipg: '60',
  });
  return `https://www.ebay.com/sch/i.html?${params}`;
}

// eBay serves two layouts: the older "s-item" list and the newer "s-card" one. Handle both.
export function parseEbaySold(html) {
  const $ = cheerio.load(html);
  const results = [];
  $('li.s-item, li.s-card').each((_, el) => {
    const $el = $(el);
    const title = $el
      .find('.s-item__title, .s-card__title')
      .first()
      .text()
      .replace(/^New Listing/i, '')
      .replace(/Opens in a new window or tab$/i, '')
      .trim();
    if (!title || /^shop on ebay$/i.test(title)) return; // placeholder card eBay inserts at the top

    const priceText = $el.find('.s-item__price, .s-card__price').first().text().trim();
    const soldText =
      $el
        .find('.s-item__caption--signal, .s-item__title--tagblock .POSITIVE, .s-card__caption, .s-item__caption')
        .filter((_, c) => /sold/i.test($(c).text()))
        .first()
        .text()
        .trim() || null;
    const href = $el.find('a.s-item__link, a.su-link, a[href*="/itm/"]').first().attr('href') ?? null;
    const image = $el.find('img').first().attr('src') ?? $el.find('img').first().attr('data-src') ?? null;

    results.push({
      title,
      condition: null,
      price: parsePrice(priceText),
      priceText,
      currency: guessCurrency(priceText, 'USD'),
      soldAt: soldText ? toIsoDate(soldText.replace(/^Sold\s*/i, '')) : null,
      url: href ? href.split('?')[0] : null,
      image,
    });
  });
  return results.filter((r) => r.price != null);
}

const API = 'https://api.ebay.com';
let cachedToken = null; // { token, expiresAt }

async function getAppToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.token;
  const basic = Buffer.from(`${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`).toString('base64');
  const res = await fetchWithTimeout(`${API}/identity/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope',
  });
  if (!res.ok) throw new Error(`eBay token request returned HTTP ${res.status}`);
  const data = await res.json();
  cachedToken = { token: data.access_token, expiresAt: Date.now() + ((data.expires_in ?? 7200) - 120) * 1000 };
  return cachedToken.token;
}

export function toEbayListing(item) {
  const auction = (item.buyingOptions ?? []).includes('AUCTION');
  const money = auction ? item.currentBidPrice ?? item.price : item.price ?? item.currentBidPrice;
  const price = parsePrice(money?.value);
  return {
    title: item.title ?? '',
    condition: item.condition ?? null,
    type: auction ? 'auction' : 'buy_now',
    price,
    priceText: price != null ? `${money.currency ?? ''} ${money.value}`.trim() : '',
    currency: money?.currency ?? 'USD',
    bids: auction ? item.bidCount ?? 0 : null,
    endsAt: auction ? toIsoDate(item.itemEndDate) : null,
    acceptsOffers: (item.buyingOptions ?? []).includes('BEST_OFFER'),
    url: item.itemWebUrl ?? null,
    image: item.image?.imageUrl ?? item.thumbnailImages?.[0]?.imageUrl ?? null,
  };
}

async function ebayListings(query, limit) {
  if (!process.env.EBAY_CLIENT_ID || !process.env.EBAY_CLIENT_SECRET) {
    return { listings: [], listingsMessage: 'Add EBAY_CLIENT_ID and EBAY_CLIENT_SECRET to show eBay listings.' };
  }
  try {
    const token = await getAppToken();
    const params = new URLSearchParams({ q: query, category_ids: POKEMON_SINGLES_CATEGORY, limit: '50' });
    const res = await fetchWithTimeout(`${API}/buy/browse/v1/item_summary/search?${params}`, {
      headers: { Authorization: `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US' },
    });
    if (res.status === 401) cachedToken = null;
    if (!res.ok) throw new Error(`eBay Browse API returned HTTP ${res.status}`);
    const listings = ((await res.json()).itemSummaries ?? [])
      .map(toEbayListing)
      .filter((r) => r.price != null)
      .slice(0, limit);
    return { listings, listingsMessage: '' };
  } catch (err) {
    return { listings: [], listingsMessage: `eBay listings failed: ${err.message}` };
  }
}

function looksLikeSignInOrChallenge(res, html) {
  return (
    /signin\.ebay\.|\/signin\/|splashui\/challenge/i.test(res.url) ||
    /<title>[^<]*(Sign in|Security Measure|Pardon Our Interruption)/i.test(html)
  );
}

export async function searchEbay(fields, { query, limit = 20 }) {
  const [sold, live] = await Promise.all([ebaySold(query, limit), ebayListings(query, limit)]);
  return { ...sold, ...live };
}

async function ebaySold(query, limit) {
  const searchUrl = ebaySoldUrl(query);
  try {
    const res = await fetchWithTimeout(searchUrl, {
      headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html', 'Accept-Language': 'en-US,en;q=0.9' },
      redirect: 'follow',
    });
    const html = await res.text();
    if (looksLikeSignInOrChallenge(res, html) || res.status === 403) {
      return sourceResult('eBay', {
        status: 'blocked',
        message: 'eBay asked for a sign-in or a bot check before showing sold items. Use the link to see them in your browser.',
        searchUrl,
      });
    }
    if (!res.ok) throw new Error(`eBay returned HTTP ${res.status}`);

    const results = parseEbaySold(html).slice(0, limit);
    return sourceResult('eBay', {
      status: results.length ? 'ok' : 'empty',
      message: results.length ? '' : 'No sold listings found.',
      searchUrl,
      results,
    });
  } catch (err) {
    return sourceResult('eBay', { status: 'error', message: `eBay lookup failed: ${err.message}`, searchUrl });
  }
}
