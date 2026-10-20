import {
  AdditiveBlending,
  AmbientLight,
  BufferGeometry,
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
  genreGroups,
  genreIndex,
  hash,
  nebulaPosition,
  stationLocation,
} from "./stationSpatial";

export type SceneView = "globe" | "nebula";
export type StationScene = {
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
  const markers: Sprite[] = [];
  const markerById = new Map<string, Sprite>();
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
    if (view === "globe") {
      for (const marker of markers)
        marker.visible = marker.position.dot(camera.position) > 1.45 ** 2;
    }
    renderer.render(scene, camera);
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
    for (let group = 0; group < genreGroups.length; group++) {
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
  for (const station of stations) {
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
        const radius = Math.sqrt(index) * 0.026;
        position
          .addScaledVector(tangent, Math.cos(index * 2.399963) * radius)
          .addScaledVector(bitangent, Math.sin(index * 2.399963) * radius)
          .normalize()
          .multiplyScalar(1.465);
      }
    } else position = new Vector3(...nebulaPosition(station, stations));
    const material = new SpriteMaterial({
      map: glow,
      color:
        view === "globe" ? "#ffd19a" : genreGroups[genreIndex(station)].color,
      transparent: true,
      opacity: 1,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    const marker = new Sprite(material);
    marker.position.copy(position);
    marker.scale.setScalar(view === "globe" ? 0.085 : 0.12);
    marker.userData.stationId = station.id;
    world.add(marker);
    markers.push(marker);
    markerById.set(station.id, marker);
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
    return raycaster.intersectObjects(
      markers.filter((marker) => marker.visible),
      false,
    )[0]?.object.userData.stationId as string | undefined;
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
      if (id) onPick(id);
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

  return {
    focus(id) {
      const marker = markerById.get(id);
      if (!marker) return;
      controls.target.set(0, 0, 0);
      if (view === "globe") {
        const distance = camera.position.length();
        camera.position
          .copy(marker.position)
          .normalize()
          .multiplyScalar(distance);
      } else {
        controls.target.copy(marker.position);
        camera.position.copy(marker.position).add(new Vector3(0, 0, 3.4));
      }
      controls.update();
      requestRender();
    },
    select(id) {
      for (const marker of markers) {
        const chosen = marker.userData.stationId === id;
        marker.scale.setScalar(
          (view === "globe" ? 0.085 : 0.12) * (chosen ? 1.8 : 1),
        );
        marker.material.color.set(
          chosen
            ? "#ffffff"
            : view === "globe"
              ? "#ffd19a"
              : genreGroups[
                  genreIndex(
                    stations.find(
                      (item) => item.id === marker.userData.stationId,
                    )!,
                  )
                ].color,
        );
      }
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
