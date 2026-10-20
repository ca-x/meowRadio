import { describe, expect, it } from "vitest";
import type { Station } from "./api";
import { genreIndex, nebulaPosition, stationLocation } from "./stationSpatial";

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
  it("spreads stations sharing one genre into stable, distinct spiral positions", () => {
    const stations = Array.from({ length: 24 }, (_, index) => ({
      ...station,
      id: `radio-${index}`,
    }));
    const positions = stations.map((item) => nebulaPosition(item, stations));
    expect(new Set(positions.map((position) => position.join(","))).size).toBe(
      24,
    );
    expect(positions.every((position) => position.every(Number.isFinite))).toBe(
      true,
    );
    expect(nebulaPosition(stations[10], [...stations])).toEqual(positions[10]);
  });
});
