// Fanatics Collect: the site's own search runs on Algolia. A short-lived, anonymous search key comes
// from its public GraphQL API (collectSearchKeyV2); with it we query the item index for lots with
// status "Sold" (recent sales) and "Live" (current listings). No account needed.
//
// marketplace tells the sale type: WEEKLY and PREMIER are auctions, FIXED is Buy Now.
//
// The exact attribute names for the sold price and sold date in the index are not documented, so we
// read the first one present from a list of likely names. Run with DEBUG_SOURCES=1 to print one raw
// hit and adjust the lists if a field comes back empty.

import { BROWSER_UA, fetchWithTimeout, parsePrice, toIsoDate, sourceResult } from '../util.js';

const GRAPHQL_URL = 'https://app.fanaticscollect.com/graphql';
const ALGOLIA_APP_ID = '3XT9C4X62I';
const ALGOLIA_URL = `https://${ALGOLIA_APP_ID.toLowerCase()}-dsn.algolia.net/1/indexes/*/queries`;
const INDEX = 'prod_item_state_v1';
// Categories are unreliable (Pokemon lots turn up under "Sports Cards > Basketball"), so match the title instead.
const isPokemon = (hit) => /pok[eé]mon/i.test(`${hit.title ?? ''} ${hit.productTitle ?? ''}`);
const SITE_HEADERS = {
  'User-Agent': BROWSER_UA,
  Origin: 'https://www.fanaticscollect.com',
  Referer: 'https://www.fanaticscollect.com/',
};

const PRICE_FIELDS = ['purchasePrice', 'soldPrice', 'realizedPrice', 'finalPrice', 'hammerPrice', 'currentPrice', 'price'];
const DATE_FIELDS = ['soldDate', 'soldAt', 'purchasedAt', 'closedAt', 'endsAt', 'endDate', 'endTime', 'updatedAt'];

let cachedKey = null; // { key, expiresAt }

async function getSearchKey() {
  if (cachedKey && cachedKey.expiresAt > Date.now()) return cachedKey.key;
  const res = await fetchWithTimeout(GRAPHQL_URL, {
    method: 'POST',
    headers: { ...SITE_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: 'query webSearchKeyQuery { collectSearchKeyV2 { key validUntil } }' }),
  });
  if (!res.ok) {
    const err = new Error(`Fanatics Collect key request returned HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const data = (await res.json())?.data?.collectSearchKeyV2;
  if (!data?.key) throw new Error('Fanatics Collect did not return a search key');
  const validUntil = Date.parse(data.validUntil);
  // Refresh a minute early; assume 5 minutes if the expiry is missing.
  cachedKey = { key: data.key, expiresAt: (Number.isNaN(validUntil) ? Date.now() + 300_000 : validUntil) - 60_000 };
  return data.key;
}

async function algoliaSearch(query, filters, hitsPerPage) {
  const key = await getSearchKey();
  const res = await fetchWithTimeout(ALGOLIA_URL, {
    method: 'POST',
    headers: {
      ...SITE_HEADERS,
      'Content-Type': 'application/json',
      'X-Algolia-API-Key': key,
      'X-Algolia-Application-Id': ALGOLIA_APP_ID,
    },
    body: JSON.stringify({ requests: [{ indexName: INDEX, query, filters, hitsPerPage, attributesToHighlight: [] }] }),
  });
  if (res.status === 401 || res.status === 403) cachedKey = null;
  if (!res.ok) {
    const err = new Error(`Fanatics Collect search returned HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return (await res.json())?.results?.[0]?.hits ?? [];
}

const pick = (obj, fields) => fields.map((f) => obj?.[f]).find((v) => v != null && v !== '');

function listingUrl(hit) {
  const uuid = hit.listingUuid ?? hit.objectID;
  if (hit.marketplace === 'FIXED') return `https://www.fanaticscollect.com/buy-now/${uuid}`;
  if (hit.marketplace === 'PREMIER') return `https://www.fanaticscollect.com/premier/${uuid}`;
  return `https://www.fanaticscollect.com/weekly/${uuid}`;
}

const saleType = (hit) => (hit.marketplace === 'FIXED' ? 'buy_now' : 'auction');
const condition = (hit) => [hit.gradingService ?? hit.grader, hit.grade].filter(Boolean).join(' ') || null;
const image = (hit) => hit.images?.primary?.small ?? hit.images?.primary?.medium ?? hit.imageUrl ?? null;
const usd = (n) => (n != null ? `$${n.toLocaleString('en-US')}` : '');

function toListing(hit) {
  const type = saleType(hit);
  const price = parsePrice(type === 'auction' ? hit.currentBid || hit.startingBid : hit.askingPrice ?? hit.currentPrice);
  return {
    title: hit.title ?? hit.productTitle ?? '',
    condition: condition(hit),
    type,
    price,
    priceText: usd(price),
    currency: hit.currency ?? 'USD',
    bids: type === 'auction' ? hit.bidCount ?? 0 : null,
    endsAt: type === 'auction' ? toIsoDate(hit.auctionEndDatetime) : null,
    acceptsOffers: Boolean(hit.allowOffers),
    url: listingUrl(hit),
    image: image(hit),
  };
}

// Algolia needs every word to match, and Fanatics titles write numbers as "#4", so "4/102" -> "4".
function fanaticsQuery({ name, set, number }) {
  const num = String(number ?? '').split('/')[0].replace(/^0+(?=\d)/, '').trim();
  return [name, num, set].map((s) => String(s ?? '').trim()).filter(Boolean).join(' ');
}

export async function searchFanatics(fields, { limit = 20 }) {
  const query = fanaticsQuery(fields);
  const searchUrl = `https://www.fanaticscollect.com/search?q=${encodeURIComponent(query)}`;
  try {
    // Hits come back by relevance, not date, so pull plenty and sort them here.
    const [soldHits, liveHits] = await Promise.all([
      algoliaSearch(query, 'status:"Sold"', 1000),
      algoliaSearch(query, 'status:"Live"', 200),
    ]);
    if (process.env.DEBUG_SOURCES && soldHits[0]) console.log('[fanatics] sample hit:', JSON.stringify(soldHits[0], null, 2));

    const results = soldHits
      .filter(isPokemon)
      .map((hit) => {
        const price = parsePrice(pick(hit, PRICE_FIELDS));
        return {
          title: hit.title ?? '',
          condition: condition(hit),
          type: saleType(hit),
          price,
          priceText: usd(price),
          currency: hit.currency ?? 'USD',
          soldAt: toIsoDate(pick(hit, DATE_FIELDS) || hit.auctionEndDatetime),
          url: listingUrl(hit),
          image: image(hit),
        };
      })
      .filter((r) => r.price != null)
      .sort((a, b) => String(b.soldAt).localeCompare(String(a.soldAt)))
      .slice(0, limit);

    const listings = liveHits
      .filter(isPokemon)
      .map(toListing)
      .filter((r) => r.price != null);

    return sourceResult('Fanatics Collect', {
      status: results.length ? 'ok' : 'empty',
      message: results.length ? 'Auction prices are hammer prices before buyer\'s premium.' : 'No sold lots found.',
      searchUrl,
      results,
      listings,
    });
  } catch (err) {
    const blocked = err.status === 403 || err.status === 429;
    return sourceResult('Fanatics Collect', {
      status: blocked ? 'blocked' : 'error',
      message: blocked
        ? `Fanatics Collect refused the request (HTTP ${err.status}).`
        : `Fanatics Collect lookup failed: ${err.message}`,
      searchUrl,
    });
  }
}
