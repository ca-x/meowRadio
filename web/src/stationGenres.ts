import type { Station } from "./api";

export const genreGroups = [
  { name: "爵士", match: /\bjazz\b|爵士/i, color: "#e9b87b" },
  {
    name: "古典",
    match: /\b(classical|opera|symphonic|baroque)\b|古典/i,
    color: "#b5cbb2",
  },
  {
    name: "电子",
    match: /\b(electronic|electro|dance|house|techno|trance|edm)\b|电子|舞曲/i,
    color: "#92c9dc",
  },
  { name: "摇滚", match: /\b(rock|metal|punk)\b|摇滚/i, color: "#e49c91" },
  { name: "流行", match: /\b(pop|hits|top[ -]?40)\b|流行/i, color: "#c4aee5" },
  {
    name: "氛围",
    match: /\b(ambient|chill|chillout|lounge|relax)\b|氛围|轻音乐/i,
    color: "#a0d4ca",
  },
  {
    name: "新闻与谈话",
    match: /\b(news|talk|spoken)\b|新闻|谈话/i,
    color: "#d3c68c",
  },
  { name: "其他", match: /./, color: "#aab4c5" },
];

const classifiedGenres = genreGroups.slice(0, -1);
export function genreIndex(station: Station) {
  for (const tag of station.tags.split(/[,/]/)) {
    const index = classifiedGenres.findIndex(({ match }) => match.test(tag));
    if (index >= 0) return index;
  }
  return genreGroups.length - 1;
}

export function countGenres(stations: Station[]) {
  const counts = genreGroups.map(() => 0);
  for (const station of stations) counts[genreIndex(station)]++;
  return counts;
}
