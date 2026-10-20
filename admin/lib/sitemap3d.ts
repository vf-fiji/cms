// Three.js scene for the 3D site map: a glowing "spider web" of pages,
// content and forms. React owns the UI around it; this owns the canvas.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CSS2DObject, CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import type { SiteGraph, SiteGraphEdge, SiteGraphNode } from "../../shared/types";

/**
 * Node colour groups, validated as a categorical set on the dark surface
 * (all-pairs). Kind is ALSO encoded by shape, so colour is never the only cue.
 */
export const GROUP_COLORS = { page: "#e66767", content: "#3987e5", form: "#199e70" } as const;
export const BRAND_RED = "#e60000";
export const groupOf = (n: SiteGraphNode): keyof typeof GROUP_COLORS => (n.kind === "home" || n.kind === "page" ? "page" : n.kind === "form" ? "form" : "content");

export interface SceneOptions {
  showItems: boolean;
  showForms: boolean;
  showLinks: boolean;
  showLabels: boolean;
  autoRotate: boolean;
}

interface NodeObj {
  node: SiteGraphNode;
  group: THREE.Group;
  mesh: THREE.Mesh;
  glow: THREE.Sprite;
  label?: CSS2DObject;
  radius: number;
  baseScale: number;
}
interface EdgeObj {
  edge: SiteGraphEdge;
  line: THREE.Line;
  curve: THREE.QuadraticBezierCurve3;
  baseOpacity: number;
}

const RING_GAP = 95;
const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/** Deterministic pseudo-random so the layout is stable between visits. */
function seeded(str: string) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

function nodeRadius(n: SiteGraphNode) {
  switch (n.kind) {
    case "home":
      return Math.min(16, 10 + Math.log2(1 + (n.views ?? 0)) * 0.9);
    case "page":
      return Math.min(11, 4.5 + Math.log2(1 + (n.views ?? 0)) * 1.3);
    case "type":
      return 6 + Math.min(5, Math.log2(1 + (n.size ?? 0)) * 1.2);
    case "form":
      return 4.5;
    default:
      return 2.2;
  }
}

/**
 * Spider-web layout: rings by depth (home in the middle), sectors per top-level
 * branch, then a short force simulation to untangle cross-links.
 */
export function layoutGraph(graph: SiteGraph): Map<string, THREE.Vector3> {
  const pos = new Map<string, THREE.Vector3>();
  const nodes = graph.nodes;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const children = new Map<string, string[]>();
  for (const e of graph.edges) if (e.kind === "child") (children.get(e.source) ?? children.set(e.source, []).get(e.source)!).push(e.target);
  const home = nodes.find((n) => n.kind === "home") ?? nodes.find((n) => n.kind === "page");
  const rand = seeded(nodes.map((n) => n.id).join("|"));

  // 1. pages: recursive angular sectors
  const place = (id: string, a0: number, a1: number, depth: number) => {
    const angle = (a0 + a1) / 2;
    const r = depth * RING_GAP;
    pos.set(id, new THREE.Vector3(Math.cos(angle) * r, (rand() - 0.5) * 30 * Math.min(depth, 1), Math.sin(angle) * r));
    const kids = children.get(id) ?? [];
    kids.forEach((k, i) => {
      const span = (a1 - a0) / kids.length;
      place(k, a0 + span * i, a0 + span * (i + 1), depth + 1);
    });
  };
  if (home) place(home.id, 0, Math.PI * 2, 0);
  nodes.filter((n) => (n.kind === "page" || n.kind === "home") && !pos.has(n.id)).forEach((n, i) => pos.set(n.id, new THREE.Vector3(Math.cos(i) * RING_GAP * 2, 0, Math.sin(i) * RING_GAP * 2)));

  // 2. types & forms: near the pages that use them, on the outer ring
  const users = new Map<string, string[]>();
  for (const e of graph.edges) if (e.kind === "lists" || e.kind === "form") (users.get(e.target) ?? users.set(e.target, []).get(e.target)!).push(e.source);
  const outer = (Math.max(1, ...nodes.filter((n) => n.kind === "page").map((n) => n.depth)) + 1) * RING_GAP;
  nodes
    .filter((n) => n.kind === "type" || n.kind === "form")
    .forEach((n, i) => {
      const us = (users.get(n.id) ?? []).map((u) => pos.get(u)!).filter(Boolean);
      const angle = us.length ? Math.atan2(us.reduce((a, p) => a + p.z, 0), us.reduce((a, p) => a + p.x, 0)) + (rand() - 0.5) * 0.5 : (i / 3) * Math.PI;
      const r = outer * (n.kind === "form" ? 0.9 : 1.05);
      pos.set(n.id, new THREE.Vector3(Math.cos(angle) * r, (n.kind === "form" ? -1 : 1) * (25 + rand() * 30), Math.sin(angle) * r));
    });

  // 3. items: a small cloud around their type
  for (const n of nodes.filter((x) => x.kind === "item")) {
    const c = pos.get(n.parent ?? "") ?? new THREE.Vector3();
    const theta = rand() * Math.PI * 2;
    const phi = Math.acos(2 * rand() - 1);
    const r = 22 + rand() * 22;
    pos.set(n.id, new THREE.Vector3(c.x + r * Math.sin(phi) * Math.cos(theta), c.y + r * Math.cos(phi), c.z + r * Math.sin(phi) * Math.sin(theta)));
  }

  // 4. relax: repulsion + springs, keeping pages near their ring
  const ids = [...pos.keys()];
  const rest: Record<SiteGraphEdge["kind"], number> = { child: RING_GAP, link: 150, lists: 120, form: 90, item: 28 };
  const tmp = new THREE.Vector3();
  for (let iter = 0; iter < 160; iter++) {
    const force = new Map(ids.map((id) => [id, new THREE.Vector3()]));
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++) {
        const a = pos.get(ids[i])!;
        const b = pos.get(ids[j])!;
        tmp.subVectors(a, b);
        const d2 = Math.max(tmp.lengthSq(), 25);
        if (d2 > 160 * 160) continue;
        tmp.multiplyScalar(900 / d2 / Math.sqrt(d2));
        force.get(ids[i])!.add(tmp);
        force.get(ids[j])!.sub(tmp);
      }
    for (const e of graph.edges) {
      const a = pos.get(e.source);
      const b = pos.get(e.target);
      if (!a || !b) continue;
      tmp.subVectors(b, a);
      const d = tmp.length() || 1;
      tmp.multiplyScalar(((d - rest[e.kind]) / d) * (e.kind === "link" ? 0.01 : 0.04));
      force.get(e.source)!.add(tmp);
      force.get(e.target)!.sub(tmp);
    }
    const cool = 1 - iter / 160;
    for (const id of ids) {
      const n = byId.get(id)!;
      if (n.kind === "home") continue;
      const p = pos.get(id)!;
      const f = force.get(id)!;
      if (n.kind === "page") {
        // radial pull towards the node's ring: this keeps the spider-web shape
        const flat = Math.hypot(p.x, p.z) || 1;
        const target = n.depth * RING_GAP;
        f.x += (p.x / flat) * (target - flat) * 0.08;
        f.z += (p.z / flat) * (target - flat) * 0.08;
        f.y -= p.y * 0.02;
      }
      p.addScaledVector(f.clampLength(0, 12), cool);
    }
  }
  return pos;
}

function glowTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.18, "rgba(255,255,255,.55)");
  grad.addColorStop(0.45, "rgba(255,255,255,.12)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class SiteMapScene {
  onHover: (n: SiteGraphNode | null, x: number, y: number) => void = () => {};
  onSelect: (n: SiteGraphNode | null) => void = () => {};
  onOpen: (n: SiteGraphNode) => void = () => {};

  private renderer: THREE.WebGLRenderer;
  private labels: CSS2DRenderer;
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private web = new THREE.Group();
  private content = new THREE.Group();
  private stars: THREE.Points;
  private flow?: { points: THREE.Points; tracks: { curve: THREE.Curve<THREE.Vector3>; t: number; speed: number }[] };
  private homeHalo?: THREE.Mesh;
  private nodeObjs = new Map<string, NodeObj>();
  private edgeObjs: EdgeObj[] = [];
  private hitTargets: THREE.Object3D[] = [];
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2(-9, -9);
  private hovered: string | null = null;
  private selected: string | null = null;
  private positions = new Map<string, THREE.Vector3>();
  private graph?: SiteGraph;
  private options!: SceneOptions;
  private frame = 0;
  private timer = new THREE.Timer();
  private flight?: { from: THREE.Vector3; to: THREE.Vector3; camFrom: THREE.Vector3; camTo: THREE.Vector3; t: number };
  private glowTex = glowTexture();
  private resizeObs: ResizeObserver;
  private disposed = false;

  constructor(private host: HTMLElement) {
    const w = host.clientWidth || 800;
    const h = host.clientHeight || 600;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.domElement.className = "sitemap-canvas";
    host.appendChild(this.renderer.domElement);

    this.labels = new CSS2DRenderer();
    this.labels.setSize(w, h);
    this.labels.domElement.className = "sitemap-labels";
    host.appendChild(this.labels.domElement);

    this.camera = new THREE.PerspectiveCamera(50, w / h, 1, 6000);
    this.camera.position.set(0, 330, 470);
    this.scene.fog = new THREE.FogExp2(0x0b0b0f, 0.0011);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.minDistance = 40;
    this.controls.maxDistance = 1600;
    this.controls.autoRotateSpeed = 0.45;
    this.controls.addEventListener("start", () => (this.flight = undefined));

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const key = new THREE.PointLight(0xffffff, 2.2, 0, 0);
    key.position.set(200, 400, 300);
    this.scene.add(key);
    const rim = new THREE.PointLight(0xe60000, 1.4, 0, 0);
    rim.position.set(-300, -150, -250);
    this.scene.add(rim);
    this.scene.add(this.web, this.content);

    this.stars = this.makeStars();
    this.scene.add(this.stars);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.85, 0.55, 0.12);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    const el = this.renderer.domElement;
    el.addEventListener("pointermove", this.onPointerMove);
    el.addEventListener("pointerleave", this.onPointerLeave);
    el.addEventListener("click", this.onClick);
    el.addEventListener("dblclick", this.onDblClick);
    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(host);
    this.loop();
  }

  setData(graph: SiteGraph, options: SceneOptions) {
    const firstTime = !this.graph;
    this.graph = graph;
    this.options = options;
    // positions are computed on the full graph, so toggling filters never reshuffles the web
    if (firstTime || graph.nodes.some((n) => !this.positions.has(n.id))) this.positions = layoutGraph(graph);
    this.build();
    if (firstTime) this.introFlight();
  }

  setOptions(options: SceneOptions) {
    const rebuild = ["showItems", "showForms", "showLinks", "showLabels"].some((k) => (options as any)[k] !== (this.options as any)[k]);
    this.options = options;
    this.controls.autoRotate = options.autoRotate && !reducedMotion();
    if (rebuild && this.graph) this.build();
  }

  focus(id: string | null) {
    this.selected = id;
    this.applyHighlight();
    const o = id ? this.nodeObjs.get(id) : null;
    if (!o) return;
    const target = o.group.position.clone();
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    const dist = Math.max(90, o.radius * 14);
    this.flyTo(target, target.clone().add(dir.multiplyScalar(dist)));
  }

  resetView() {
    this.selected = null;
    this.applyHighlight();
    this.flyTo(new THREE.Vector3(), new THREE.Vector3(0, 330, 470));
  }

  /** Screen position of a node, for anchoring UI to it. */
  screenPos(id: string) {
    const o = this.nodeObjs.get(id);
    if (!o) return null;
    const v = o.group.position.clone().project(this.camera);
    return { x: ((v.x + 1) / 2) * this.host.clientWidth, y: ((1 - v.y) / 2) * this.host.clientHeight };
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.resizeObs.disconnect();
    const el = this.renderer.domElement;
    el.removeEventListener("pointermove", this.onPointerMove);
    el.removeEventListener("pointerleave", this.onPointerLeave);
    el.removeEventListener("click", this.onClick);
    el.removeEventListener("dblclick", this.onDblClick);
    this.clear(this.web);
    this.clear(this.content);
    this.stars.geometry.dispose();
    (this.stars.material as THREE.Material).dispose();
    this.glowTex.dispose();
    this.timer.dispose();
    this.controls.dispose();
    this.composer.dispose();
    this.renderer.dispose();
    el.remove();
    this.labels.domElement.remove();
  }

  // ------------------------------------------------------------------ build
  private clear(group: THREE.Group) {
    group.traverse((o: any) => {
      if (o.isCSS2DObject) o.element.remove();
      o.geometry?.dispose?.();
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m: THREE.Material) => m.dispose());
    });
    group.clear();
  }

  private visibleNode(n: SiteGraphNode) {
    if (n.kind === "item") return this.options.showItems;
    if (n.kind === "form") return this.options.showForms;
    return true;
  }

  private build() {
    const graph = this.graph!;
    this.clear(this.web);
    this.clear(this.content);
    this.nodeObjs.clear();
    this.edgeObjs = [];
    this.hitTargets = [];
    this.homeHalo = undefined;
    this.flow = undefined;
    this.controls.autoRotate = this.options.autoRotate && !reducedMotion();

    // --- the web itself: rings per depth and spokes to top-level pages
    const maxDepth = Math.max(1, ...graph.nodes.filter((n) => n.kind === "page").map((n) => n.depth));
    for (let d = 1; d <= maxDepth + 1; d++) {
      const pts = new THREE.EllipseCurve(0, 0, d * RING_GAP, d * RING_GAP).getPoints(160).map((p) => new THREE.Vector3(p.x, 0, p.y));
      const ring = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: d === maxDepth + 1 ? 0.04 : 0.07, depthWrite: false }));
      this.web.add(ring);
    }
    const spokes: THREE.Vector3[] = [];
    for (const n of graph.nodes.filter((x) => x.kind === "page" && x.depth === 1)) {
      const p = this.positions.get(n.id)!;
      const dir = new THREE.Vector3(p.x, 0, p.z).normalize();
      spokes.push(new THREE.Vector3(), dir.multiplyScalar((maxDepth + 1) * RING_GAP));
    }
    if (spokes.length) this.web.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(spokes), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.05, depthWrite: false })));

    // --- nodes
    const geo = {
      sphere: new THREE.SphereGeometry(1, 32, 24),
      octa: new THREE.OctahedronGeometry(1.25, 0),
      item: new THREE.IcosahedronGeometry(1, 0),
      cube: new THREE.BoxGeometry(1.5, 1.5, 1.5),
      hit: new THREE.SphereGeometry(1, 8, 6),
    };
    const hitMat = new THREE.MeshBasicMaterial({ visible: false });
    for (const n of graph.nodes) {
      if (!this.visibleNode(n)) continue;
      const color = new THREE.Color(GROUP_COLORS[groupOf(n)]);
      const r = nodeRadius(n);
      const group = new THREE.Group();
      group.position.copy(this.positions.get(n.id)!);
      const geometry = n.kind === "type" ? geo.octa : n.kind === "item" ? geo.item : n.kind === "form" ? geo.cube : geo.sphere;
      const mat = new THREE.MeshStandardMaterial({
        color,
        emissive: n.kind === "home" ? new THREE.Color(BRAND_RED) : color,
        emissiveIntensity: n.live ? (n.kind === "home" ? 0.9 : 0.55) : 0.25,
        roughness: 0.3,
        metalness: 0.25,
        wireframe: !n.live, // drafts are hollow: status never relies on colour
        transparent: true,
      });
      const mesh = new THREE.Mesh(geometry.clone(), mat);
      mesh.scale.setScalar(r);
      group.add(mesh);

      const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glowTex, color: n.kind === "home" ? new THREE.Color(BRAND_RED) : color, transparent: true, opacity: n.live ? 0.55 : 0.2, blending: THREE.AdditiveBlending, depthWrite: false }));
      glow.scale.setScalar(r * (n.kind === "home" ? 9 : 5.5));
      group.add(glow);

      if (n.changesPending) {
        const ring = new THREE.Mesh(new THREE.TorusGeometry(r * 1.7, 0.35, 8, 48), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55 }));
        ring.rotation.x = Math.PI / 2.4;
        ring.userData.spin = true;
        group.add(ring);
      }
      if (n.kind === "home") {
        this.homeHalo = new THREE.Mesh(new THREE.RingGeometry(r * 1.9, r * 2.15, 64), new THREE.MeshBasicMaterial({ color: new THREE.Color(BRAND_RED), transparent: true, opacity: 0.6, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }));
        this.homeHalo.rotation.x = -Math.PI / 2;
        group.add(this.homeHalo);
      }

      const hit = new THREE.Mesh(geo.hit, hitMat);
      hit.scale.setScalar(Math.max(r * 1.6, 6));
      hit.userData.id = n.id;
      group.add(hit);
      this.hitTargets.push(hit);

      let label: CSS2DObject | undefined;
      if (n.kind !== "item" || this.options.showLabels) {
        const div = document.createElement("div");
        div.className = `sitemap-label kind-${n.kind}${n.live ? "" : " is-draft"}`;
        div.textContent = n.label;
        label = new CSS2DObject(div);
        label.position.set(0, -(r + 7), 0);
        label.center.set(0.5, 0);
        label.visible = this.options.showLabels && n.kind !== "item";
        group.add(label);
      }
      this.content.add(group);
      this.nodeObjs.set(n.id, { node: n, group, mesh, glow, label, radius: r, baseScale: r });
    }
    Object.values(geo).forEach((g) => g.dispose());

    // --- edges: curved threads, dashed for internal links
    const tracks: { curve: THREE.Curve<THREE.Vector3>; t: number; speed: number }[] = [];
    for (const e of graph.edges) {
      if (e.kind === "link" && !this.options.showLinks) continue;
      const a = this.nodeObjs.get(e.source);
      const b = this.nodeObjs.get(e.target);
      if (!a || !b) continue;
      const p0 = a.group.position;
      const p2 = b.group.position;
      const mid = p0.clone().add(p2).multiplyScalar(0.5);
      const lift = p0.distanceTo(p2) * (e.kind === "link" ? 0.35 : e.kind === "item" ? 0.05 : 0.15);
      mid.y += lift;
      const curve = new THREE.QuadraticBezierCurve3(p0.clone(), mid, p2.clone());
      const pts = curve.getPoints(e.kind === "item" ? 8 : 40);
      const geomLine = new THREE.BufferGeometry().setFromPoints(pts);
      const ca = new THREE.Color(GROUP_COLORS[groupOf(a.node)]);
      const cb = new THREE.Color(GROUP_COLORS[groupOf(b.node)]);
      const colors = new Float32Array(pts.length * 3);
      pts.forEach((_, i) => {
        const c = ca.clone().lerp(cb, i / (pts.length - 1));
        colors.set([c.r, c.g, c.b], i * 3);
      });
      geomLine.setAttribute("color", new THREE.BufferAttribute(colors, 3));
      const baseOpacity = e.kind === "child" ? 0.55 : e.kind === "item" ? 0.18 : e.kind === "link" ? 0.5 : 0.32;
      const material =
        e.kind === "link"
          ? new THREE.LineDashedMaterial({ vertexColors: true, transparent: true, opacity: baseOpacity, dashSize: 6, gapSize: 5, blending: THREE.AdditiveBlending, depthWrite: false })
          : new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: baseOpacity, blending: THREE.AdditiveBlending, depthWrite: false });
      const line = new THREE.Line(geomLine, material);
      if (e.kind === "link") line.computeLineDistances();
      this.content.add(line);
      this.edgeObjs.push({ edge: e, line, curve, baseOpacity });
      if (e.kind !== "item") {
        const r = seeded(e.source + e.target);
        tracks.push({ curve, t: r(), speed: 0.12 + r() * 0.12 });
      }
    }

    // --- light pulses travelling along the threads
    if (tracks.length && !reducedMotion()) {
      const geom = new THREE.BufferGeometry();
      geom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(tracks.length * 3), 3));
      const points = new THREE.Points(geom, new THREE.PointsMaterial({ color: 0xffffff, size: 3.2, map: this.glowTex, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true }));
      this.content.add(points);
      this.flow = { points, tracks };
    }
    this.applyHighlight();
  }

  private makeStars() {
    const n = 1800;
    const arr = new Float32Array(n * 3);
    const rand = seeded("stars");
    for (let i = 0; i < n; i++) {
      const r = 900 + rand() * 1800;
      const t = rand() * Math.PI * 2;
      const p = Math.acos(2 * rand() - 1);
      arr.set([r * Math.sin(p) * Math.cos(t), r * Math.cos(p), r * Math.sin(p) * Math.sin(t)], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(arr, 3));
    return new THREE.Points(g, new THREE.PointsMaterial({ color: 0xffffff, size: 2.2, map: glowTexture(), transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
  }

  // --------------------------------------------------------- interaction
  private neighbours(id: string) {
    const set = new Set([id]);
    for (const e of this.edgeObjs) {
      if (e.edge.source === id) set.add(e.edge.target);
      if (e.edge.target === id) set.add(e.edge.source);
    }
    return set;
  }

  private applyHighlight() {
    const focus = this.hovered ?? this.selected;
    const near = focus ? this.neighbours(focus) : null;
    for (const [id, o] of this.nodeObjs) {
      const on = !near || near.has(id);
      (o.mesh.material as THREE.MeshStandardMaterial).opacity = on ? 1 : 0.12;
      (o.glow.material as THREE.SpriteMaterial).opacity = on ? (o.node.live ? 0.55 : 0.2) * (id === focus ? 1.6 : 1) : 0.04;
      if (o.label) {
        o.label.visible = (this.options.showLabels && o.node.kind !== "item") || (!!near && near.has(id));
        o.label.element.classList.toggle("is-dim", !on);
        o.label.element.classList.toggle("is-focus", id === focus);
      }
      o.group.userData.targetScale = id === focus ? 1.35 : 1;
    }
    for (const e of this.edgeObjs) {
      const on = !focus || e.edge.source === focus || e.edge.target === focus;
      (e.line.material as THREE.LineBasicMaterial).opacity = focus ? (on ? Math.min(1, e.baseOpacity * 2.2) : 0.03) : e.baseOpacity;
    }
  }

  private pick(): SiteGraphNode | null {
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.raycaster.intersectObjects(this.hitTargets, false)[0];
    return hit ? this.nodeObjs.get(hit.object.userData.id)?.node ?? null : null;
  }

  private onPointerMove = (e: PointerEvent) => {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    const n = this.pick();
    const id = n?.id ?? null;
    if (id !== this.hovered) {
      this.hovered = id;
      this.renderer.domElement.style.cursor = id ? "pointer" : "grab";
      this.applyHighlight();
    }
    this.onHover(n, e.clientX - rect.left, e.clientY - rect.top);
  };
  private onPointerLeave = () => {
    this.hovered = null;
    this.applyHighlight();
    this.onHover(null, 0, 0);
  };
  private onClick = () => {
    const n = this.pick();
    this.onSelect(n);
    this.focus(n?.id ?? null);
  };
  private onDblClick = () => {
    const n = this.pick();
    if (n) this.onOpen(n);
  };

  // ---------------------------------------------------------------- camera
  private flyTo(target: THREE.Vector3, cam: THREE.Vector3) {
    if (reducedMotion()) {
      this.controls.target.copy(target);
      this.camera.position.copy(cam);
      return;
    }
    this.flight = { from: this.controls.target.clone(), to: target, camFrom: this.camera.position.clone(), camTo: cam, t: 0 };
  }

  private introFlight() {
    if (reducedMotion()) return;
    this.camera.position.set(0, 900, 1400);
    this.flyTo(new THREE.Vector3(), new THREE.Vector3(0, 330, 470));
  }

  private resize() {
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.labels.setSize(w, h);
    this.composer.setSize(w, h);
    this.bloom.setSize(w, h);
  }

  private loop = () => {
    if (this.disposed) return;
    this.frame = requestAnimationFrame(this.loop);
    this.timer.update();
    const dt = Math.min(this.timer.getDelta(), 0.05);
    const time = this.timer.getElapsed();
    if (this.flight) {
      const f = this.flight;
      f.t = Math.min(1, f.t + dt / 1.1);
      const k = 1 - Math.pow(1 - f.t, 4); // ease-out quart, like a spring settling
      this.controls.target.lerpVectors(f.from, f.to, k);
      this.camera.position.lerpVectors(f.camFrom, f.camTo, k);
      if (f.t >= 1) this.flight = undefined;
    }
    this.controls.update();
    this.stars.rotation.y += dt * 0.004;
    if (this.homeHalo) {
      const s = 1 + Math.sin(time * 1.6) * 0.08;
      this.homeHalo.scale.setScalar(s);
      (this.homeHalo.material as THREE.MeshBasicMaterial).opacity = 0.35 + Math.sin(time * 1.6) * 0.2;
    }
    for (const o of this.nodeObjs.values()) {
      const target = (o.group.userData.targetScale as number) ?? 1;
      o.group.scale.setScalar(THREE.MathUtils.lerp(o.group.scale.x, target, 0.15));
      if (o.node.kind === "type" || o.node.kind === "form") o.mesh.rotation.y += dt * 0.5;
      for (const c of o.group.children) if (c.userData.spin) c.rotation.z += dt * 0.8;
    }
    if (this.flow) {
      const arr = this.flow.points.geometry.getAttribute("position") as THREE.BufferAttribute;
      this.flow.tracks.forEach((tr, i) => {
        tr.t = (tr.t + dt * tr.speed) % 1;
        const p = tr.curve.getPoint(tr.t);
        arr.setXYZ(i, p.x, p.y, p.z);
      });
      arr.needsUpdate = true;
    }
    this.composer.render();
    this.labels.render(this.scene, this.camera);
  };
}
