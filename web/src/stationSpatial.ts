import { geoCentroid } from "d3-geo";
import { feature } from "topojson-client";
import { getNumericCodes } from "i18n-iso-countries";
import atlas from "world-atlas/countries-110m.json";
import type { Station } from "./api";

export const countries = feature(atlas, atlas.objects.countries);
const codes = getNumericCodes();
const centers = new Map<string, [number, number]>();
for (const country of countries.features) {
  const code = codes[String(country.id).padStart(3, "0")];
  if (code) centers.set(code, geoCentroid(country));
}
// Small territories omitted from Natural Earth's 110m map.
centers.set("SG", [103.82, 1.35]);
centers.set("HK", [114.17, 22.32]);
centers.set("MO", [113.54, 22.2]);
centers.set("MT", [14.38, 35.94]);

export function stationLocation(station: Station) {
  const { geo_lat: lat, geo_long: lon } = station;
  if (
    typeof lat === "number" &&
    Number.isFinite(lat) &&
    Math.abs(lat) <= 90 &&
    typeof lon === "number" &&
    Number.isFinite(lon) &&
    Math.abs(lon) <= 180
  ) {
    return { coordinates: [lon, lat] as [number, number], approximate: false };
  }
  const center = centers.get(station.countrycode.trim().toUpperCase());
  return center ? { coordinates: center, approximate: true } : null;
}

export function hash(value: string) {
  let result = 2166136261;
  for (const char of value)
    result = Math.imul(result ^ char.charCodeAt(0), 16777619);
  return result >>> 0;
}

export function stationGenre(station: Station) {
  return (
    station.tags
      .split(",")
      .map((tag) => tag.trim())
      .find(Boolean) || "Radio"
  );
}

const genres = [
  { name: "爵士", match: /jazz|爵士|blues|蓝调/i, color: "#e9b87b" },
  {
    name: "古典",
    match: /classical|classic music|古典|opera|symphon/i,
    color: "#b5cbb2",
  },
  {
    name: "电子",
    match: /electro|dance|house|techno|trance|edm|电子|舞曲/i,
    color: "#92c9dc",
  },
  { name: "摇滚", match: /rock|metal|punk|摇滚/i, color: "#e49c91" },
  { name: "流行", match: /pop|hits|流行|top.?40/i, color: "#c4aee5" },
  {
    name: "氛围",
    match: /ambient|chill|lounge|relax|氛围|轻音乐/i,
    color: "#a0d4ca",
  },
  {
    name: "新闻与谈话",
    match: /news|talk|新闻|谈话|spoken/i,
    color: "#d3c68c",
  },
  { name: "其他", match: /./, color: "#aab4c5" },
];
export const genreGroups = genres.map(({ name, color }) => ({ name, color }));
export function genreIndex(station: Station) {
  const index = genres.findIndex(({ match }) => match.test(station.tags));
  return index < 0 ? genres.length - 1 : index;
}

export function nebulaPosition(
  station: Station,
  siblings: Station[],
): [number, number, number] {
  const group = genreIndex(station);
  const angle = (group * Math.PI * 2) / genres.length;
  const peers = siblings.filter((item) => genreIndex(item) === group);
  const index = peers.findIndex((item) => item.id === station.id);
  const spiral = index * 2.399963 + (hash(station.id) % 100) / 100;
  const radius = 0.12 + Math.sqrt(Math.max(0, index)) * 0.13;
  return [
    Math.cos(angle) * 1.7 + Math.cos(spiral) * radius,
    Math.sin(angle) * 1.1 + Math.sin(spiral) * radius,
    ((hash(station.id) % 100) / 100 - 0.5) * 0.5,
  ];
}
