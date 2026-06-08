import type { BraveWeatherResult } from "../../services/braveSearch";
import { parseTemperatureF } from "./utils";
import type { WeatherPanelData } from "./types";

function deriveCrewImpact(
  tempF: number | null,
  summary: string
): { crew_impact: WeatherPanelData["crew_impact"]; crew_note: string } {
  const q = summary.toLowerCase();
  const hasPrecip = /rain|snow|precip|ice|sleet|storm|freezing|frost/.test(q);

  if (tempF !== null) {
    if (tempF < 20) {
      return {
        crew_impact: "NO-GO",
        crew_note: "Sub-freezing temps - outdoor crew safety risk."
      };
    }
    if (tempF <= 35 || hasPrecip) {
      return {
        crew_impact: "CAUTION",
        crew_note: hasPrecip
          ? "Cold or wet conditions - plan gear and shorter outdoor blocks."
          : "Cool temps - monitor wind chill and crew comfort."
      };
    }
    return {
      crew_impact: "GO",
      crew_note: "Conditions support normal outdoor operations."
    };
  }

  if (hasPrecip) {
    return { crew_impact: "CAUTION", crew_note: "Precipitation in forecast - plan accordingly." };
  }
  return { crew_impact: "CAUTION", crew_note: "Verify conditions on site before dispatch." };
}

export function buildWeatherPanel(weather: BraveWeatherResult, speech: string): WeatherPanelData {
  const summary = weather.summary || speech;
  const tempF = parseTemperatureF(summary);
  const crew = deriveCrewImpact(tempF, summary);

  let wind = "";
  const windMatch = summary.match(/Wind:\s*([^.;]+)/i);
  if (windMatch) wind = windMatch[1].trim();

  let conditions = "";
  const condMatch = summary.match(/Conditions:\s*([^.;]+)/i);
  if (condMatch) conditions = condMatch[1].trim();

  return {
    location: "Holmes County, OH",
    temperature: tempF != null ? `${tempF}°F` : summary.slice(0, 80) || "See briefing",
    conditions: conditions || summary.slice(0, 120) || "-",
    wind: wind || "-",
    crew_impact: crew.crew_impact,
    crew_note: crew.crew_note
  };
}
