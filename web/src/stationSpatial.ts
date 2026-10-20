import { geoCentroid } from "d3-geo";
import { feature } from "topojson-client";
import { getNumericCodes } from "i18n-iso-countries";
import atlas from "world-atlas/countries-110m.json";
import detailedAtlas from "world-atlas/countries-50m.json";
import type { Station } from "./api";
import { countGenres, genreGroups, genreIndex } from "./stationGenres";

export const countries = feature(atlas, atlas.objects.countries);
const codes = getNumericCodes();
const centers = new Map<string, [number, number]>();
for (const country of feature(detailedAtlas, detailedAtlas.objects.countries)
  .features) {
  const code = codes[String(country.id).padStart(3, "0")];
  if (code) centers.set(code, geoCentroid(country));
}
// Small territories omitted from Natural Earth's 110m map.
centers.set("SG", [103.82, 1.35]);
centers.set("HK", [114.17, 22.32]);
centers.set("MO", [113.54, 22.2]);
centers.set("MT", [14.38, 35.94]);
// Territories grouped into larger polygons by Natural Earth still have separate directory codes.
for (const [code, lon, lat] of [
  ["RE", 55.5, -21.1],
  ["UM", -177.37, 28.2],
  ["XK", 21.17, 42.67],
  ["GP", -61.58, 16.25],
  ["BQ", -68.26, 12.18],
  ["MQ", -61, 14.65],
  ["GI", -5.35, 36.14],
  ["CX", 105.62, -10.45],
  ["GF", -53.13, 3.93],
  ["YT", 45.17, -12.83],
  ["TV", 179.2, -8.52],
  ["SJ", 15.63, 78.2],
  ["CC", 96.87, -12.17],
] as const)
  centers.set(code, [lon, lat]);

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

export { genreGroups, genreIndex } from "./stationGenres";

export function nebulaPositions(
  stations: Station[],
): Map<string, [number, number, number]> {
  const counts = countGenres(stations);
  const seen = counts.map(() => 0);
  const result = new Map<string, [number, number, number]>();
  for (const station of stations) {
    const group = genreIndex(station);
    const angle = (group * Math.PI * 2) / genreGroups.length;
    const index = seen[group]++;
    const spiral = index * 2.399963 + (hash(station.id) % 100) / 100;
    const radius = 0.08 + Math.sqrt(index / Math.max(1, counts[group])) * 0.55;
    result.set(station.id, [
      Math.cos(angle) * 1.7 + Math.cos(spiral) * radius,
      Math.sin(angle) * 1.1 + Math.sin(spiral) * radius,
      ((hash(station.id) % 100) / 100 - 0.5) * 0.5,
    ]);
  }
  return result;
}

// Test the homogeneous clip bounds before submitting a marker index to the GPU.
// Globe points behind the surface horizon are also hidden even inside the frustum.
export function markerInViewport(
  point: { x: number; y: number; z: number },
  camera: { x: number; y: number; z: number },
  matrix: ArrayLike<number>,
  globe: boolean,
) {
  const { x, y, z } = point;
  if (globe && x * camera.x + y * camera.y + z * camera.z <= 1.45 ** 2)
    return false;
  const clipX = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12];
  const clipY = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13];
  const clipZ = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14];
  const w = matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15];
  return (
    w > 0 &&
    Math.abs(clipX) <= w &&
    Math.abs(clipY) <= w &&
    Math.abs(clipZ) <= w
  );
}
