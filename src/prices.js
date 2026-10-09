// Runs every source in parallel and applies the optional grade filter to sales and current listings.

import { searchSnkrdunk } from './sources/snkrdunk.js';
import { searchEbay } from './sources/ebay.js';
import { searchFanatics } from './sources/fanatics.js';
import { buildQuery, matchesGrade } from './util.js';

const SOURCES = [searchSnkrdunk, searchEbay, searchFanatics];

export async function lookupPrices({ name, set = '', number = '', grade = '' }) {
  const fields = { name, set, number };
  const query = buildQuery(fields);
  const sources = await Promise.all(SOURCES.map((search) => search(fields, { query, limit: 60 })));

  for (const source of sources) {
    const before = source.results.length;
    source.results = source.results
      .filter((r) => matchesGrade(`${r.title} ${r.condition ?? ''}`, grade))
      .slice(0, 20);
    if (before && !source.results.length) {
      source.status = 'empty';
      source.message = `${before} sales found, but none matched the grade filter.`;
    }
    const listed = source.listings.length;
    source.listings = source.listings.filter((r) => matchesGrade(`${r.title} ${r.condition ?? ''}`, grade)).slice(0, 60);
    if (listed && !source.listings.length) {
      source.listingsMessage = `${listed} listings found, but none matched the grade filter.`;
    }
  }
  return { query, grade, sources };
}
