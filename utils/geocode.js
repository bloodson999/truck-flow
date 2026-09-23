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

function coordinatesFromResult(result) {
  if (!result) return null;

  if (result.lat && result.lon) {
    return { lat: Number(result.lat), lng: Number(result.lon) };
  }

  const coordinates = result.geometry?.coordinates;
  if (Array.isArray(coordinates) && coordinates.length >= 2) {
    return { lat: Number(coordinates[1]), lng: Number(coordinates[0]) };
  }

  return null;
}

async function searchPhoton(query) {
  const res = await axios.get("https://photon.komoot.io/api/", {
    params: { q: query, limit: 1 },
    headers: { "User-Agent": "truckflow-app/1.0" },
    timeout: 10000
  });

  return coordinatesFromResult(res.data?.features?.[0]);
}

async function geocode(place) {
  if (!place || !String(place).trim()) {
    throw new Error("Place is required");
  }

  const queries = [...new Set([...addressQueries(place), ...areaFallback(place)])];

  for (const query of queries) {
    try {
      const res = await axios.get("https://nominatim.openstreetmap.org/search", {
        params: { format: "json", limit: 1, q: query, countrycodes: "us" },
        headers: { "User-Agent": "truckflow-app/1.0" },
        timeout: 10000
      });
      const result = coordinatesFromResult(res.data?.[0]);

      if (result) {
        console.log(`📍 Geocoded "${place}" → ${result.lat}, ${result.lng}`);
        return result;
      }
    } catch (error) {
      if (error.response?.status !== 429) throw error;
      console.log("⚠️ Nominatim rate-limited, trying alternate geocoder");
      break;
    }
  }

  for (const query of queries) {
    try {
      const result = await searchPhoton(query);
      if (result) {
        console.log(`📍 Alternate geocoder resolved "${place}" → ${result.lat}, ${result.lng}`);
        return result;
      }
    } catch (error) {
      if (error.response?.status === 429) continue;
      throw error;
    }
  }

  throw new Error(`Location not found: "${place}"`);
}

module.exports = geocode;