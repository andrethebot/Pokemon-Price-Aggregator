# Card Price Check (stage 1)

Type a Pokemon card's name, set and number to see recent sold prices from SNKRDUNK, eBay and
Fanatics Collect side by side. Each site gets a median price and a list of its latest sales.

## Run it

You need Node.js 18 or newer.

```
cd pokemon-price-app
npm install
npm start
```

Then open http://localhost:3000. To use a different port, set `PORT=4000`. `npm test` runs the parser tests.

## How each source gets its data

| Source | How | Needs an account? |
| --- | --- | --- |
| SNKRDUNK | Calls the same JSON endpoints that snkrdunk.com/en uses (`/en/v1/search`, `/en/v1/trading-cards/{id}/used-listings`) and keeps only the listings marked sold. | No |
| Fanatics Collect | Gets the site's anonymous Algolia search key from its GraphQL API, then searches for lots with status "Sold". Auction prices are hammer prices before buyer's premium. | No |
| eBay | Reads the public "Sold items" search page. eBay has no open API for sold prices: the Finding API is retired and Marketplace Insights is for approved partners only. eBay reportedly now asks signed-out visitors to sign in before showing sold searches. If that happens, the eBay box says so and links to the sold search so you can open it in your own browser. | Possibly |

None of these are official, supported APIs, so any of them can change without notice. If a box
says "refused" or "failed", the site changed or blocked the request.

Run `DEBUG_SOURCES=1 npm start` to print one raw Fanatics Collect result to the terminal. Use this
if the price or date column comes back empty. Those field names are guesses, taken from a list in
`src/sources/fanatics.js`.

## Layout

- `public/index.html`: the whole page, with no build step
- `src/server.js`: the localhost server, `GET /api/prices?name=&set=&number=&grade=`
- `src/prices.js`: runs the three sources in parallel and applies the grade filter
- `src/sources/*.js`: one file per site
- `src/identify.js`: the stage 2 hook. `identifyCard(image)` should return `{ name, set, number }`.
  `POST /api/identify` already calls it and returns 501 until it's built.
