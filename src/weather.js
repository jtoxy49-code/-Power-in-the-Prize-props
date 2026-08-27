const OPEN_METEO_BASE = "https://api.open-meteo.com/v1/forecast";

/**
 * Fetches an hourly forecast for a location and returns the hour
 * closest to the given game time. Open-Meteo is free, keyless, and
 * has a stable, documented API (unlike the Savant leaderboards).
 */
export async function fetchWeatherForGame(lat, lon, gameTimeIso) {
  const url = new URL(OPEN_METEO_BASE);
  url.searchParams.set("latitude", lat);
  url.searchParams.set("longitude", lon);
  url.searchParams.set(
    "hourly",
    "temperature_2m,precipitation_probability,windspeed_10m,winddirection_10m,relativehumidity_2m,weathercode"
  );
  url.searchParams.set("temperature_unit", "fahrenheit");
  url.searchParams.set("windspeed_unit", "mph");
  url.searchParams.set("timezone", "auto");
  url.searchParams.set("forecast_days", "10");

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Open-Meteo fetch failed: ${res.status}`);
  }

  const data = await res.json();
  const times = data?.hourly?.time || [];
  if (times.length === 0) return null;

  // find the forecast hour closest to game time
  const gameMs = new Date(gameTimeIso).getTime();
  let closestIdx = 0;
  let closestDiff = Infinity;
  times.forEach((t, i) => {
    const diff = Math.abs(new Date(t).getTime() - gameMs);
    if (diff < closestDiff) {
      closestDiff = diff;
      closestIdx = i;
    }
  });

  return {
    forecast_time: times[closestIdx],
    temperature_f: data.hourly.temperature_2m?.[closestIdx] ?? null,
    precipitation_probability: data.hourly.precipitation_probability?.[closestIdx] ?? null,
    wind_mph: data.hourly.windspeed_10m?.[closestIdx] ?? null,
    wind_direction_deg: data.hourly.winddirection_10m?.[closestIdx] ?? null,
    humidity_pct: data.hourly.relativehumidity_2m?.[closestIdx] ?? null,
    weather_code: data.hourly.weathercode?.[closestIdx] ?? null,
  };
}
