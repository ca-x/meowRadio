import { describe, expect, it } from "vitest";
import type { Station } from "./api";
import { PerspectiveCamera, Matrix4 } from "three";
import {
  markerInViewport,
  genreIndex,
  nebulaPositions,
  stationLocation,
} from "./stationSpatial";

const station: Station = {
  id: "radio-a",
  name: "Radio A",
  url: "https://radio.example/live",
  country: "France",
  countrycode: "FR",
  tags: "jazz",
  codec: "MP3",
  bitrate: 128,
  hls: false,
};

describe("station locations and genre clouds", () => {
  it("locates separately listed territories without inventing unknown country locations", () => {
    for (const code of [
      "RE",
      "UM",
      "XK",
      "GP",
      "BQ",
      "MQ",
      "GI",
      "CX",
      "GF",
      "YT",
      "TV",
      "SJ",
      "CC",
    ])
      expect(
        stationLocation({ ...station, countrycode: code })?.approximate,
      ).toBe(true);
    expect(stationLocation({ ...station, countrycode: "XX" })).toBeNull();
  });

  it("uses valid station coordinates, including the equator and zero longitude", () => {
    expect(stationLocation({ ...station, geo_lat: 0, geo_long: 0 })).toEqual({
      coordinates: [0, 0],
      approximate: false,
    });
    expect(
      stationLocation({ ...station, geo_lat: 48.86, geo_long: 2.35 }),
    ).toEqual({ coordinates: [2.35, 48.86], approximate: false });
  });
  it("falls back to country locations for legacy records and invalid coordinates", () => {
    const expected = stationLocation(station);
    expect(expected?.approximate).toBe(true);
    for (const invalid of [
      { geo_lat: 91, geo_long: 2 },
      { geo_lat: 48, geo_long: 181 },
      { geo_lat: NaN, geo_long: 2 },
      { geo_lat: null, geo_long: 2 },
    ]) {
      expect(stationLocation({ ...station, ...invalid })).toEqual(expected);
    }
    expect(
      stationLocation({ ...station, countrycode: " sg " })?.approximate,
    ).toBe(true);
  });
  it("does not invent geography for unknown countries or personal sources", () => {
    expect(stationLocation({ ...station, countrycode: "" })).toBeNull();
    expect(stationLocation({ ...station, countrycode: "XX" })).toBeNull();
  });
  it("groups genres across tags and imported category paths", () => {
    expect(genreIndex(station)).toBe(0);
    expect(genreIndex({ ...station, tags: "音乐 / 爵士, 无损" })).toBe(0);
    expect(genreIndex({ ...station, tags: "english, classical" })).toBe(1);
    expect(genreIndex({ ...station, tags: "" })).toBe(7);
  });
  it("does not invent genres from partial words and follows actual tag order", () => {
    expect(genreIndex({ ...station, tags: "barock,popcorn,warehouse" })).toBe(
      7,
    );
    expect(genreIndex({ ...station, tags: "rock,jazz" })).toBe(3);
  });
  it("keeps a large catalog bounded and retains every station", () => {
    const stations = Array.from({ length: 35000 }, (_, i) => ({
      ...station,
      id: `station-${i}`,
    }));
    const layout = nebulaPositions(stations);
    expect(layout.size).toBe(35000);
    expect(
      [...layout.values()].every(
        ([x, y, z]) =>
          Math.abs(x) < 2.4 && Math.abs(y) < 1.8 && Math.abs(z) <= 0.5,
      ),
    ).toBe(true);
  });
  it("spreads stations sharing one genre into stable, distinct spiral positions", () => {
    const stations = Array.from({ length: 24 }, (_, index) => ({
      ...station,
      id: `radio-${index}`,
    }));
    const layout = nebulaPositions(stations);
    const positions = stations.map((item) => layout.get(item.id)!);
    expect(new Set(positions.map((position) => position.join(","))).size).toBe(
      24,
    );
    expect(positions.every((position) => position.every(Number.isFinite))).toBe(
      true,
    );
    expect(nebulaPositions([...stations]).get(stations[10].id)).toEqual(
      positions[10],
    );
  });
});

it("culls the back hemisphere and offscreen/behind-camera points before GPU submission", () => {
  const camera = new PerspectiveCamera(42, 1, 0.1, 100);
  camera.position.set(0, 0, 4.8);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  const projection = new Matrix4().multiplyMatrices(
    camera.projectionMatrix,
    camera.matrixWorldInverse,
  ).elements;
  const visible = (x: number, y: number, z: number, globe = false) =>
    markerInViewport({ x, y, z }, camera.position, projection, globe);
  expect(visible(0, 0, 1.46, true)).toBe(true);
  expect(visible(0, 0, -1.46, true)).toBe(false);
  expect(visible(0, 0, -1.46)).toBe(true);
  expect(visible(50, 0, 0)).toBe(false);
  expect(visible(0, 50, 0)).toBe(false);
  expect(visible(0, 0, 6)).toBe(false);
  expect(visible(0, 0, -200)).toBe(false);
});

it("locates country overview clusters for small countries from the detailed atlas", () => {
  for (const countrycode of ["LU", "BH", "BB", "SC"]) {
    expect(stationLocation({ ...station, countrycode })?.approximate).toBe(
      true,
    );
  }
});
