// ═══════════════════════════════════════════
// core/weather.js
// ═══════════════════════════════════════════
import { CONFIG } from "./config.js";

let cache = null, fetchedAt = 0;

export const Weather = {
  async get() {
    if (cache && Date.now() - fetchedAt < CONFIG.WEATHER_TTL) return cache;
    try {
      const city = CONFIG.USER.city;
      const res  = await fetch(`https://wttr.in/${encodeURIComponent(city)}?format=j1`);
      const data = await res.json();
      const cur  = data.current_condition[0];
      const days = data.weather.slice(0,3).map(d => {
        const desc = d.hourly[4]?.weatherDesc[0]?.value || "";
        return `${d.date}: ${desc}, ${d.mintempC}–${d.maxtempC}°C`;
      });
      cache = `${cur.weatherDesc[0].value}, ${cur.temp_C}°C (feels ${cur.FeelsLikeC}°C), `
            + `humidity ${cur.humidity}% in ${city}. Forecast: ${days.join(" | ")}`;
      fetchedAt = Date.now();
      return cache;
    } catch(_) { return "Weather unavailable."; }
  },
};