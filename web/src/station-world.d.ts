declare module "world-atlas/countries-110m.json" {
  import type { Topology, GeometryCollection } from "topojson-specification";
  const topology: Topology<{ countries: GeometryCollection }>;
  export default topology;
}

declare module "world-atlas/countries-50m.json" {
  import type { Topology, GeometryCollection } from "topojson-specification";
  const topology: Topology<{ countries: GeometryCollection }>;
  export default topology;
}
