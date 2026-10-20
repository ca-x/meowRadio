import {
  AdditiveBlending,
  AmbientLight,
  BufferGeometry,
  BufferAttribute,
  Matrix4,
  CanvasTexture,
  Color,
  DirectionalLight,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Points,
  PointsMaterial,
  Raycaster,
  Scene,
  SphereGeometry,
  ShaderMaterial,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { geoEquirectangular, geoGraticule10, geoPath } from "d3-geo";
import type { Station } from "./api";
import {
  countries,
  markerInViewport,
  genreGroups,
  genreIndex,
  hash,
  nebulaPositions,
  stationLocation,
} from "./stationSpatial";

export type SceneView = "globe" | "nebula";
export type SceneVisibility = {
  ids: string[];
  countries: string[];
  /** -1 means the visible category contains overlapping/unknown aggregates. */
  genreCounts: number[];
  distance: number;
  cameraKey: string;
};
export type CameraState = {
  position: [number, number, number];
  target: [number, number, number];
  fitFactor: number;
};
export type StationScene = {
  setGenreFilter: (index: number | null) => void;
  getCameraState: () => CameraState;
  restoreCameraState: (state: CameraState) => void;
  focus: (id: string) => void;
  select: (id?: string) => void;
  reset: () => void;
  zoom: (direction: number) => void;
  rotate: (horizontal: number, vertical: number) => void;
  setActive: (active: boolean) => void;
  dispose: () => void;
};

function earthTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 2048;
  canvas.height = 1024;
  const context = canvas.getContext("2d")!;
  context.fillStyle = "#17343b";
  context.fillRect(0, 0, canvas.width, canvas.height);
  const projection = geoEquirectangular()
    .scale(canvas.width / (Math.PI * 2))
    .translate([1024, 512]);
  const path = geoPath(projection, context);
  context.beginPath();
  path(countries);
  context.fillStyle = "#8eaa97";
  context.fill();
  context.strokeStyle = "#294e50";
  context.lineWidth = 0.8;
  context.stroke();
  context.beginPath();
  path(geoGraticule10());
  context.strokeStyle = "#b8d9d01b";
  context.lineWidth = 0.8;
  context.stroke();
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

function glowTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const context = canvas.getContext("2d")!;
  const gradient = context.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, "#ffffffff");
  gradient.addColorStop(0.12, "#fffffff0");
  gradient.addColorStop(0.28, "#ffffff80");
  gradient.addColorStop(1, "#ffffff00");
  context.fillStyle = gradient;
  context.fillRect(0, 0, 64, 64);
  return new CanvasTexture(canvas);
}

function globeVector(lon: number, lat: number, radius = 1.46) {
  const phi = (lat * Math.PI) / 180;
  const theta = (lon * Math.PI) / 180;
  return new Vector3(
    Math.cos(phi) * Math.cos(theta),
    Math.sin(phi),
    -Math.cos(phi) * Math.sin(theta),
  ).multiplyScalar(radius);
}

export function createStationScene(
  host: HTMLDivElement,
  view: SceneView,
  stations: Station[],
  onPick: (id: string) => void,
  onHover: (id: string | null) => void,
  onLost: () => void,
  onVisibility?: (visibility: SceneVisibility) => void,
): StationScene {
  // Three r186 requires WebGL 2, the same renderer used by RoamDial.
  const renderer = new WebGLRenderer({
    antialias: true,
    alpha: false,
    powerPreference: "low-power",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor("#0a171c");
  renderer.domElement.setAttribute("aria-hidden", "true");
  host.appendChild(renderer.domElement);
  const scene = new Scene();
  const camera = new PerspectiveCamera(42, 1, 0.1, 100);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = !window.matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches;
  controls.dampingFactor = 0.1;
  controls.enablePan = false;
  controls.minDistance = view === "globe" ? 2.1 : 2.6;
  controls.maxDistance = view === "globe" ? 7.5 : 10;
  controls.rotateSpeed = 0.55;
  controls.zoomSpeed = 0.65;
  const world = new Group();
  scene.add(world);
  const glow = glowTexture();
  const markerPositions: Vector3[] = [];
  const markerIds: string[] = [];
  const markerById = new Map<string, number>();
  const markerColors: number[] = [];
  const markerStations: Station[] = [];
  const markerGenres: number[] = [];
  let genreFilter: number | null = null;
  let visibilityTimer: ReturnType<typeof setTimeout> | undefined;
  let lastVisibility = "";
  const textures: CanvasTexture[] = [glow];
  let frame = 0;
  let active = true;
  let disposed = false;
  let intersecting = true;
  let hovering: string | null = null;
  let fitFactor = 1;

  function requestRender() {
    if (!disposed && active && intersecting && !document.hidden && !frame)
      frame = requestAnimationFrame(render);
  }
  function render() {
    frame = 0;
    if (disposed || !active || !intersecting || document.hidden) return;
    const changing = controls.update();
    updateVisibleMarkers();
    renderer.render(scene, camera);
    clearTimeout(visibilityTimer);
    visibilityTimer = setTimeout(emitVisibility, 180);
    if (changing) requestRender();
  }

  scene.add(new AmbientLight("#c5e5dd", 1.6));
  const sunlight = new DirectionalLight("#fbe5bd", 2.4);
  sunlight.position.set(-3, 5, 4);
  scene.add(sunlight);

  if (view === "globe") {
    const texture = earthTexture();
    textures.push(texture);
    const sphere = new Mesh(
      new SphereGeometry(1.45, 96, 64),
      new MeshStandardMaterial({ map: texture, roughness: 1, metalness: 0 }),
    );
    world.add(sphere);
    const atmosphere = new Sprite(
      new SpriteMaterial({
        map: glow,
        color: "#78b9ba",
        opacity: 0.16,
        blending: AdditiveBlending,
        depthWrite: false,
      }),
    );
    atmosphere.scale.set(4.1, 4.1, 1);
    atmosphere.position.z = -0.2;
    world.add(atmosphere);
  } else {
    // Each genre has a volumetric particle cloud; positions are deterministic.
    const positions: number[] = [];
    const colors: number[] = [];
    const occupied = new Set(stations.map(genreIndex));
    for (let group = 0; group < genreGroups.length; group++) {
      if (!occupied.has(group)) continue;
      const angle = (group * Math.PI * 2) / genreGroups.length;
      const color = new Color(genreGroups[group].color);
      for (let index = 0; index < 220; index++) {
        const seed = hash(`${group}/${index}`);
        const theta = index * 2.399963;
        const radius = Math.sqrt((seed % 1000) / 1000) * 0.72;
        positions.push(
          Math.cos(angle) * 1.7 + Math.cos(theta) * radius,
          Math.sin(angle) * 1.1 + Math.sin(theta) * radius * 0.65,
          ((seed % 997) / 997 - 0.5) * 0.8,
        );
        colors.push(color.r, color.g, color.b);
      }
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
    geometry.setAttribute("color", new Float32BufferAttribute(colors, 3));
    world.add(
      new Points(
        geometry,
        new PointsMaterial({
          size: 0.21,
          map: glow,
          vertexColors: true,
          transparent: true,
          opacity: 0.1,
          blending: AdditiveBlending,
          depthWrite: false,
        }),
      ),
    );
  }

  const placeCounts = new Map<string, number>();
  const nebula = view === "nebula" ? nebulaPositions(stations) : null;
  for (const station of stations) {
    if (markerById.has(station.id)) continue;
    let position: Vector3;
    if (view === "globe") {
      const location = stationLocation(station);
      if (!location) continue;
      const [lon, lat] = location.coordinates;
      position = globeVector(lon, lat);
      const key = `${lon.toFixed(1)},${lat.toFixed(1)}`;
      const index = placeCounts.get(key) || 0;
      placeCounts.set(key, index + 1);
      if (index > 0) {
        const normal = position.clone().normalize();
        const tangent = new Vector3()
          .crossVectors(normal, new Vector3(0, 1, 0))
          .normalize();
        if (tangent.lengthSq() === 0) tangent.set(1, 0, 0);
        const bitangent = new Vector3().crossVectors(normal, tangent);
        const radius = Math.min(0.075, Math.sqrt(index) * 0.006);
        position
          .addScaledVector(tangent, Math.cos(index * 2.399963) * radius)
          .addScaledVector(bitangent, Math.sin(index * 2.399963) * radius)
          .normalize()
          .multiplyScalar(1.465);
      }
    } else position = new Vector3(...nebula!.get(station.id)!);
    markerById.set(station.id, markerPositions.length);
    markerPositions.push(position);
    markerIds.push(station.id);
    markerStations.push(station);
    markerGenres.push(genreIndex(station));
    const color = new Color(
      view === "globe" ? "#ffd19a" : genreGroups[genreIndex(station)].color,
    );
    markerColors.push(color.r, color.g, color.b);
  }
  // All station lights share one GPU draw call, including large world catalogs.
  const markerGeometry = new BufferGeometry();
  markerGeometry.setAttribute(
    "position",
    new Float32BufferAttribute(
      markerPositions.flatMap((position) => position.toArray()),
      3,
    ),
  );
  const colorAttribute = new Float32BufferAttribute(markerColors, 3);
  markerGeometry.setAttribute("color", colorAttribute);
  const baseSize = view === "globe" ? 0.045 : 0.055;
  const sizeAttribute = new Float32BufferAttribute(
    new Float32Array(
      markerStations.map((station) => baseSize * (station.cluster ? 2.2 : 1)),
    ),
    1,
  );
  markerGeometry.setAttribute("pointSize", sizeAttribute);
  const markerMaterial = new ShaderMaterial({
    uniforms: { viewportHeight: { value: 510 } },
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    vertexShader: `attribute float pointSize;
      uniform float viewportHeight;
      varying vec3 pointColor;
      void main() {
        pointColor = color;
        vec4 positionInView = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * positionInView;
        gl_PointSize = clamp(pointSize * viewportHeight / -positionInView.z, 1.5, 60.0);
      }`,
    fragmentShader: `varying vec3 pointColor;
      void main() {
        float radius = length(gl_PointCoord - vec2(0.5)) * 2.0;
        if (radius > 1.0) discard;
        float alpha = pow(1.0 - radius, 1.5);
        gl_FragColor = vec4(pointColor, alpha);
        #include <colorspace_fragment>
      }`,
  });
  const stationPoints = new Points(markerGeometry, markerMaterial);
  stationPoints.renderOrder = 2;
  world.add(stationPoints);
  let selectedIndex: number | undefined;
  const visibleIndices = new Uint32Array(markerIds.length);
  const indexAttribute = new BufferAttribute(visibleIndices, 1);
  markerGeometry.setIndex(indexAttribute);
  const projection = new Matrix4();
  let visibleCount = 0;
  function updateVisibleMarkers() {
    camera.updateMatrixWorld();
    projection.multiplyMatrices(
      camera.projectionMatrix,
      camera.matrixWorldInverse,
    );
    visibleCount = 0;
    for (let index = 0; index < markerPositions.length; index++) {
      const position = markerPositions[index];
      if (genreFilter !== null && markerGenres[index] !== genreFilter) continue;
      if (
        !markerInViewport(
          position,
          camera.position,
          projection.elements,
          view === "globe",
        )
      )
        continue;
      visibleIndices[visibleCount++] = index;
    }
    markerGeometry.setDrawRange(0, visibleCount);
    indexAttribute.needsUpdate = true;
  }
  function emitVisibility() {
    if (disposed || !active) return;
    const ids: string[] = [];
    const countries = new Map<string, number>();
    const screen = new Vector3();
    const genreCounts = genreGroups.map(() => 0);
    for (let offset = 0; offset < visibleCount; offset++) {
      const index = visibleIndices[offset];
      const station = markerStations[index];
      ids.push(station.id);
      const country = station.countrycode.trim().toUpperCase();
      if (country) {
        screen.copy(markerPositions[index]).project(camera);
        const distance = screen.x * screen.x + screen.y * screen.y;
        countries.set(
          country,
          Math.min(countries.get(country) ?? Infinity, distance),
        );
      }
      const genre = markerGenres[index];
      if (
        station.cluster?.kind === "genre" ||
        station.cluster?.count === null
      ) {
        // Raw directory tags overlap; adding their station totals invents a union count.
        genreCounts[genre] = -1;
      } else if (genreCounts[genre] >= 0) {
        genreCounts[genre] += station.cluster ? station.cluster.count! : 1;
      }
    }
    const payload = {
      ids,
      countries: [...countries.keys()].sort(
        (a, b) => countries.get(a)! - countries.get(b)! || a.localeCompare(b),
      ),
      genreCounts,
      distance: camera.position.distanceTo(controls.target),
      cameraKey: [...camera.position.toArray(), ...controls.target.toArray()]
        .map((value) => value.toFixed(3))
        .join(","),
    };
    const signature = JSON.stringify(payload);
    if (signature !== lastVisibility) {
      lastVisibility = signature;
      onVisibility?.(payload);
    }
  }

  // A quiet, fixed star field establishes depth without idle animation.
  const starPositions: number[] = [];
  for (let index = 0; index < 650; index++) {
    const seed = hash(`background/${index}`);
    const theta = index * 2.399963;
    const y = 1 - (index / 649) * 2;
    const r = Math.sqrt(1 - y * y);
    const distance = 16 + (seed % 7);
    starPositions.push(
      Math.cos(theta) * r * distance,
      y * distance,
      Math.sin(theta) * r * distance,
    );
  }
  const starsGeometry = new BufferGeometry();
  starsGeometry.setAttribute(
    "position",
    new Float32BufferAttribute(starPositions, 3),
  );
  scene.add(
    new Points(
      starsGeometry,
      new PointsMaterial({
        color: "#b9cfcc",
        size: 0.025,
        transparent: true,
        opacity: 0.55,
      }),
    ),
  );

  const initialLocation = stations
    .map(stationLocation)
    .find((location) => location !== null);
  const initialPosition =
    view === "globe"
      ? globeVector(...(initialLocation?.coordinates || [15, 20]), 4.8)
      : new Vector3(0, 0.4, 6.2);
  camera.position.copy(initialPosition);
  controls.update();

  const raycaster = new Raycaster();
  const pointer = new Vector2();
  let pointerStart: { x: number; y: number; id: number } | null = null;
  let pointerCount = 0;
  let gesture = false;
  function pick(event: PointerEvent) {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      (-(event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(pointer, camera);
    raycaster.params.Points.threshold = 0.08;
    let closest: string | undefined;
    let closestDistance = 144;
    for (const hit of raycaster.intersectObject(stationPoints, false)) {
      const index = hit.index;
      if (index === undefined) continue;
      const position = markerPositions[index];
      if (view === "globe" && position.dot(camera.position) <= 1.45 ** 2)
        continue;
      const screen = position.clone().project(camera);
      const dx = ((screen.x - pointer.x) * rect.width) / 2;
      const dy = ((screen.y - pointer.y) * rect.height) / 2;
      const distance = dx * dx + dy * dy;
      if (distance < closestDistance) {
        closestDistance = distance;
        closest = markerIds[index];
      }
    }
    return closest;
  }

  function pointerDown(event: PointerEvent) {
    pointerCount++;
    if (pointerCount > 1) gesture = true;
    pointerStart = { x: event.clientX, y: event.clientY, id: event.pointerId };
  }
  function pointerMove(event: PointerEvent) {
    if (pointerCount) return;
    const next = pick(event) || null;
    if (next !== hovering) {
      hovering = next;
      renderer.domElement.style.cursor = next ? "pointer" : "grab";
      onHover(next);
    }
  }
  function pointerUp(event: PointerEvent) {
    pointerCount = Math.max(0, pointerCount - 1);
    if (
      !gesture &&
      pointerStart?.id === event.pointerId &&
      Math.hypot(
        event.clientX - pointerStart.x,
        event.clientY - pointerStart.y,
      ) < 6
    ) {
      const id = pick(event);
      if (id) {
        if (markerStations[markerById.get(id)!].cluster) focusMarker(id);
        onPick(id);
      }
    }
    if (!pointerCount) {
      pointerStart = null;
      gesture = false;
    }
  }
  function pointerCancel() {
    pointerCount = 0;
    pointerStart = null;
    gesture = false;
  }
  function pointerLeave() {
    hovering = null;
    onHover(null);
  }
  function contextLost(event: Event) {
    event.preventDefault();
    onLost();
  }
  const canvas = renderer.domElement;
  canvas.addEventListener("pointerdown", pointerDown);
  canvas.addEventListener("pointermove", pointerMove);
  canvas.addEventListener("pointerup", pointerUp);
  canvas.addEventListener("pointercancel", pointerCancel);
  canvas.addEventListener("pointerleave", pointerLeave);
  canvas.addEventListener("webglcontextlost", contextLost);
  controls.addEventListener("change", requestRender);
  document.addEventListener("visibilitychange", requestRender);
  const resize = new ResizeObserver(() => {
    const { width, height } = host.getBoundingClientRect();
    if (width <= 0 || height <= 0) return;
    renderer.setSize(width, height);
    markerMaterial.uniforms.viewportHeight.value = renderer.domElement.height;
    camera.aspect = width / height;
    const nextFit = Math.max(1, 1.15 / camera.aspect);
    const offset = camera.position.clone().sub(controls.target);
    camera.position
      .copy(controls.target)
      .add(offset.multiplyScalar(nextFit / fitFactor));
    fitFactor = nextFit;
    controls.maxDistance = (view === "globe" ? 7.5 : 10) * fitFactor;
    camera.updateProjectionMatrix();
    requestRender();
  });
  resize.observe(host);
  const visibility = new IntersectionObserver(([entry]) => {
    intersecting = entry.isIntersecting;
    requestRender();
  });
  visibility.observe(host);
  requestRender();

  function focusMarker(id: string) {
    const index = markerById.get(id);
    if (index === undefined) return;
    const position = markerPositions[index];
    controls.target.set(0, 0, 0);
    if (view === "globe") {
      const distance = markerStations[index].cluster
        ? Math.min(camera.position.length(), 3.2)
        : camera.position.length();
      camera.position.copy(position).normalize().multiplyScalar(distance);
    } else {
      controls.target.copy(position);
      camera.position.copy(position).add(new Vector3(0, 0, 3.4));
    }
    controls.update();
    requestRender();
  }
  return {
    focus: focusMarker,
    setGenreFilter(index) {
      genreFilter = index;
      requestRender();
    },
    getCameraState() {
      return {
        position: camera.position.toArray(),
        target: controls.target.toArray(),
        fitFactor,
      };
    },
    restoreCameraState(state) {
      fitFactor = state.fitFactor;
      camera.position.fromArray(state.position);
      controls.target.fromArray(state.target);
      controls.update();
      requestRender();
    },
    select(id) {
      if (selectedIndex !== undefined) {
        colorAttribute.setXYZ(
          selectedIndex,
          ...(markerColors.slice(selectedIndex * 3, selectedIndex * 3 + 3) as [
            number,
            number,
            number,
          ]),
        );
        sizeAttribute.setX(
          selectedIndex,
          baseSize * (markerStations[selectedIndex].cluster ? 2.2 : 1),
        );
      }
      selectedIndex = id ? markerById.get(id) : undefined;
      if (selectedIndex !== undefined) {
        colorAttribute.setXYZ(selectedIndex, 1, 1, 1);
        sizeAttribute.setX(selectedIndex, baseSize * 2.5);
      }
      colorAttribute.needsUpdate = true;
      sizeAttribute.needsUpdate = true;
      requestRender();
    },
    reset() {
      controls.target.set(0, 0, 0);
      camera.position.copy(initialPosition).multiplyScalar(fitFactor);
      controls.update();
      requestRender();
    },
    zoom(direction) {
      const offset = camera.position.clone().sub(controls.target);
      const distance = Math.max(
        controls.minDistance,
        Math.min(
          controls.maxDistance,
          offset.length() * (direction > 0 ? 0.82 : 1.22),
        ),
      );
      camera.position
        .copy(controls.target)
        .add(offset.normalize().multiplyScalar(distance));
      controls.update();
      requestRender();
    },
    rotate(horizontal, vertical) {
      const offset = camera.position.clone().sub(controls.target);
      offset.applyAxisAngle(new Vector3(0, 1, 0), horizontal);
      const right = new Vector3().crossVectors(offset, camera.up).normalize();
      offset.applyAxisAngle(right, vertical);
      camera.position.copy(controls.target).add(offset);
      controls.update();
      requestRender();
    },
    setActive(value) {
      active = value;
      requestRender();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(frame);
      clearTimeout(visibilityTimer);
      resize.disconnect();
      visibility.disconnect();
      controls.dispose();
      document.removeEventListener("visibilitychange", requestRender);
      canvas.removeEventListener("pointerdown", pointerDown);
      canvas.removeEventListener("pointermove", pointerMove);
      canvas.removeEventListener("pointerup", pointerUp);
      canvas.removeEventListener("pointercancel", pointerCancel);
      canvas.removeEventListener("pointerleave", pointerLeave);
      canvas.removeEventListener("webglcontextlost", contextLost);
      scene.traverse((object) => {
        if (object instanceof Mesh || object instanceof Points)
          object.geometry.dispose();
        if (
          object instanceof Mesh ||
          object instanceof Points ||
          object instanceof Sprite
        ) {
          const materials = Array.isArray(object.material)
            ? object.material
            : [object.material];
          materials.forEach((material) => material.dispose());
        }
      });
      textures.forEach((texture) => texture.dispose());
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
    },
  };
}
