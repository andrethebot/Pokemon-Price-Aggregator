import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { parsePrice, toIsoDate, matchesGrade, buildQuery } from '../src/util.js';
import { parseEbaySold, toEbayListing } from '../src/sources/ebay.js';
import { searchSnkrdunk } from '../src/sources/snkrdunk.js';
import { searchFanatics } from '../src/sources/fanatics.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

test('util helpers', () => {
  assert.equal(parsePrice('US $1,234.56'), 1234.56);
  assert.equal(parsePrice('¥12,000'), 12000);
  assert.equal(parsePrice('n/a'), null);
  assert.equal(toIsoDate('Sold  Oct 3, 2026').slice(0, 10), '2026-10-03');
  assert.equal(buildQuery({ name: 'Charizard', set: 'Base Set', number: '4/102' }), 'Charizard 4/102 Base Set');
  assert.ok(matchesGrade('Charizard PSA 10 Gem Mint', 'PSA 10'));
  assert.ok(!matchesGrade('Charizard PSA 9', 'PSA 10'));
  assert.ok(!matchesGrade('Charizard PSA 10', 'PSA 1'));
  assert.ok(matchesGrade('Charizard holo near mint', 'raw'));
  assert.ok(!matchesGrade('Charizard CGC 9.5', 'raw'));
  assert.ok(matchesGrade('BGS 9.5 Charizard', 'BGS 9.5'));
});

test('eBay parser handles old s-item and new s-card layouts', () => {
  const html = `
    <ul>
      <li class="s-item"><div class="s-item__title">Shop on eBay</div><span class="s-item__price">$20.00</span></li>
      <li class="s-item">
        <a class="s-item__link" href="https://www.ebay.com/itm/111?hash=x"><div class="s-item__title"><span>New Listing</span>Charizard 4/102 Base Set PSA 9</div></a>
        <div class="s-item__caption--signal">Sold  Oct 2, 2026</div>
        <span class="s-item__price">$1,250.00</span>
      </li>
      <li class="s-card">
        <a class="su-link" href="https://www.ebay.com/itm/222"><div class="s-card__title"><span>Charizard Base Set Holo 4/102</span></div></a>
        <div class="s-card__caption">Sold  Oct 5, 2026</div>
        <div class="s-card__price">$410.50</div>
      </li>
    </ul>`;
  const rows = parseEbaySold(html);
  assert.equal(rows.length, 2);
  assert.deepEqual([rows[0].price, rows[0].url, rows[0].soldAt.slice(0, 10)], [1250, 'https://www.ebay.com/itm/111', '2026-10-02']);
  assert.equal(rows[0].title, 'Charizard 4/102 Base Set PSA 9');
  assert.deepEqual([rows[1].price, rows[1].soldAt.slice(0, 10)], [410.5, '2026-10-05']);
});

test('SNKRDUNK keeps sold listings of the best-matching product', async () => {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes('/search?')) {
      return json({ search: { products: [
        { productCode: 'SW---1', productTypeGB: 'tradingCardSingle', name: 'Charizard ex [SV3 125/197]' },
        { productCode: 'SW---2', productTypeGB: 'tradingCardSingle', name: 'Charizard [Base 004/102]' },
      ] } });
    }
    if (String(url).includes('page=1&')) {
      return json({ usedListings: [
        { uid: '01M4DSFENR0000000000000000', price: { currencyCode: 'USD', currencySymbol: 'US $', value: 900 }, condition: 'PSA 10', isSold: true },
        { uid: '01M4FTBV0G0000000000000000', price: { currencyCode: 'USD', currencySymbol: 'US $', value: 950 }, condition: 'PSA 10', isSold: false },
        { uid: '01M4FABFG80000000000000000', price: { currencyCode: 'USD', currencySymbol: 'US $', value: 300 }, condition: 'A', isSold: true },
      ] });
    }
    return json({ usedListings: [] });
  };
  const out = await searchSnkrdunk({ name: 'Charizard', set: '', number: '4/102' }, { query: 'Charizard 4/102' });
  assert.equal(out.status, 'ok');
  assert.ok(calls.some((u) => u.includes('/products/SW---2/used-listings')));
  assert.deepEqual(out.results.map((r) => r.price), [300, 900]);
  assert.match(out.results[0].soldAt, /^20\d\d-/);
  assert.deepEqual(out.listings.map((r) => [r.type, r.price]), [['buy_now', 950]]);
});

test('SNKRDUNK reports blocked on 403', async () => {
  globalThis.fetch = async () => json({}, 403);
  const out = await searchSnkrdunk({ name: 'Pikachu' }, { query: 'Pikachu' });
  assert.equal(out.status, 'blocked');
});

test('Fanatics Collect reads sold lots and live auction / Buy Now listings', async () => {
  const bodies = [];
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('graphql')) return json({ data: { collectSearchKeyV2: { key: 'k', validUntil: new Date(Date.now() + 600000).toISOString() } } });
    assert.equal(opts.headers['X-Algolia-API-Key'], 'k');
    const req = JSON.parse(opts.body).requests[0];
    bodies.push(req);
    if (req.filters.includes('Sold')) {
      return json({ results: [{ hits: [
        { listingUuid: 'u1', title: '1999 Pokemon Base #4 Charizard PSA 9', purchasePrice: 1100, soldDate: 1791000000, marketplace: 'WEEKLY' },
        { listingUuid: 'u2', title: '1999 Pokemon Base #4 Charizard', purchasePrice: 500, soldDate: 1791500000, marketplace: 'FIXED' },
        { listingUuid: 'u9', title: '2023 Topps Basketball #4', purchasePrice: 5, soldDate: 1791600000, marketplace: 'FIXED' },
      ] }] });
    }
    return json({ results: [{ hits: [
      { listingUuid: 'a1', title: '1999 Pokemon Base #4 Charizard PSA 9', currentBid: 440, bidCount: 11, auctionEndDatetime: 1791770400, marketplace: 'WEEKLY' },
      { listingUuid: 'b1', title: '1999 Pokemon Base #4 Charizard PSA 9', askingPrice: 950, allowOffers: true, marketplace: 'FIXED' },
    ] }] });
  };
  const out = await searchFanatics({ name: 'Charizard', set: 'Base Set', number: '4/102' }, {});
  assert.equal(bodies[0].query, 'Charizard 4 Base Set');
  assert.equal(out.status, 'ok');
  assert.deepEqual(out.results.map((r) => [r.url, r.type]), [
    ['https://www.fanaticscollect.com/buy-now/u2', 'buy_now'],
    ['https://www.fanaticscollect.com/weekly/u1', 'auction'],
  ]);
  assert.deepEqual(out.listings.map((r) => [r.type, r.price, r.bids, r.acceptsOffers]), [
    ['auction', 440, 11, false],
    ['buy_now', 950, null, true],
  ]);
  assert.equal(out.listings[0].endsAt.slice(0, 10), new Date(1791770400 * 1000).toISOString().slice(0, 10));
});

test('eBay Browse API items map to auction or Buy Now', () => {
  const auction = toEbayListing({ title: 'Pikachu PSA 9', buyingOptions: ['AUCTION'], currentBidPrice: { value: '120.00', currency: 'USD' }, price: { value: '99.00', currency: 'USD' }, bidCount: 4, itemEndDate: '2026-10-12T18:00:00.000Z', itemWebUrl: 'https://www.ebay.com/itm/1' });
  assert.deepEqual([auction.type, auction.price, auction.bids, auction.endsAt], ['auction', 120, 4, '2026-10-12T18:00:00.000Z']);
  const bin = toEbayListing({ title: 'Pikachu PSA 10', buyingOptions: ['FIXED_PRICE', 'BEST_OFFER'], price: { value: '2500.00', currency: 'USD' } });
  assert.deepEqual([bin.type, bin.price, bin.bids, bin.acceptsOffers], ['buy_now', 2500, null, true]);
});
