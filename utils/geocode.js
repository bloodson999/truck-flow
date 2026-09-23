const axios = require("axios");

function addressQueries(place) {
  const original = String(place).trim().replace(/\s*,\s*/g, ", ");
  const expanded = original.replace(/\bFL\b/gi, "Florida");

  return [...new Set([
    original,
    expanded,
    `${expanded}, USA`
  ])];
}

function areaFallback(place) {
  const value = String(place).trim();
  const match = value.match(/([^,]+),\s*([A-Za-z .]+?)\s+(\d{5}(?:-\d{4})?)$/);
  if (!match) return [];

  const [, city, state, zip] = match;
  return [`${city.trim()}, ${state.trim()} ${zip}`, `${state.trim()} ${zip}`];
}

async function geocode(place) {
  if (!place || !String(place).trim()) {
    throw new Error("Place is required");
  }

  const queries = [...new Set([...addressQueries(place), ...areaFallback(place)])];

  for (const query of queries) {
    const res = await axios.get("https://nominatim.openstreetmap.org/search", {
      params: { format: "json", limit: 1, q: query, countrycodes: "us" },
      headers: { "User-Agent": "truckflow-app/1.0" },
      timeout: 10000
    });

    if (Array.isArray(res.data) && res.data.length > 0) {
      const result = {
        lat: Number(res.data[0].lat),
        lng: Number(res.data[0].lon)
      };

      console.log(`📍 Geocoded "${place}" → ${result.lat}, ${result.lng}`);
      return result;
    }
  }

  throw new Error(`Location not found: "${place}"`);
}

module.exports = geocode;