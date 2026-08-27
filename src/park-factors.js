const SAVANT_PARK_BASE = "https://baseballsavant.mlb.com/leaderboard/statcast-park-factors";

function parseCSVLine(line) {
  const values = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      values.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  values.push(current);
  return values.map((v) => v.trim());
}

function parseCSV(text) {
  const lines = text.trim().split("\n");
  const headers = parseCSVLine(lines[0]);

  return lines.slice(1).map((line) => {
    const values = parseCSVLine(line);
    const row = {};
    headers.forEach((h, i) => {
      row[h] = values[i] !== undefined ? values[i] : "";
    });
    return row;
  });
}

/**
 * Fetches park factors — genuinely uncertain about several of these
 * params (this leaderboard is the least documented one we've hit).
 * type=year + rolling=1 is a guess at "single current season,
 * non-distance-comparison mode."
 */
export async function fetchParkFactors(year) {
  const url = `${SAVANT_PARK_BASE}?type=year&year=${year}&batSide=&stat=index_wOBA&condition=All&rolling=1&parks=mlb&csv=true`;

  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; PWRPropsBot/1.0)",
    },
  });

  if (!res.ok) {
    throw new Error(`Baseball Savant park-factors fetch failed: ${res.status}`);
  }

  const text = await res.text();
  return { text, parsed: parseCSV(text) };
}

export async function refreshParkFactors(env) {
  const year = new Date().getUTCFullYear();
  const { text, parsed } = await fetchParkFactors(year);

  await env.PROPS_DATA.put(
    "stats:parks_raw",
    JSON.stringify({
      row_count: parsed.length,
      sample_columns: parsed.length > 0 ? Object.keys(parsed[0]) : [],
      sample_rows: parsed.slice(0, 3),
      raw_text_first_500_chars: text.slice(0, 500), // in case it's not actually CSV
      updated_at: new Date().toISOString(),
    })
  );

  console.log(`Park factors refresh complete: ${parsed.length} rows stored`);
}
