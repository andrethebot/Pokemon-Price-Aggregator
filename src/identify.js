// Stage 2 seam: card photo identification.
//
// The search page and /api/prices only need { name, set, number }. When photo identification is
// built, implement identifyCard() to turn an uploaded image into those fields, and the
// /api/identify route in server.js will start returning them. Nothing else has to change.

export async function identifyCard(_imageBuffer, _mimeType) {
  const err = new Error('Card photo identification is not built yet.');
  err.status = 501;
  throw err;
}
