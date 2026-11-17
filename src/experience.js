import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import Lenis from "lenis";
import * as THREE from "three";

gsap.registerPlugin(ScrollTrigger);

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const ambientCanvas = document.querySelector("#site-ambient");
const revealTargets = gsap.utils.toArray(
  ".trust-inner > *, .section-heading, .service-cluster-heading, .service-card, .domain-check, .pricing-label, .price-card, .price-disclaimer, .work-card, .process-intro, .step, .maintenance-copy, .maintenance-list > div, .about-grid > *, .faq-layout > *, .faq-item, .cta-inner, .footer-main > *",
);

let lenis;
let renderer;
const tickLenis = (time) => lenis?.raf(time * 1000);

if (!reducedMotion.matches) {
  lenis = new Lenis({
    anchors: true,
    autoRaf: false,
    duration: 1.05,
    easing: (progress) => 1 - (1 - progress) ** 4,
    smoothWheel: true,
  });
  lenis.on("scroll", ScrollTrigger.update);
  gsap.ticker.add(tickLenis);
  gsap.ticker.lagSmoothing(0);

  gsap.set(revealTargets, { autoAlpha: 0, y: 22 });
  ScrollTrigger.batch(revealTargets, {
    batchMax: 4,
    once: true,
    onEnter: (elements) => gsap.to(elements, {
      autoAlpha: 1,
      duration: 0.72,
      ease: "power2.out",
      overwrite: true,
      stagger: 0.07,
      y: 0,
    }),
    start: "top 88%",
  });
}

if (ambientCanvas) {
  try {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(38, window.innerWidth / window.innerHeight, 0.1, 40);
    camera.position.z = 8;
    renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: true,
      canvas: ambientCanvas,
      powerPreference: "low-power",
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.setSize(window.innerWidth, window.innerHeight, false);

    const mark = new THREE.Group();
    const sculpture = new THREE.Group();
    const lighting = new THREE.HemisphereLight(0xe4eee9, 0x1b2d3b, 2.1);
    const keyLight = new THREE.DirectionalLight(0xf2efe8, 2.6);
    keyLight.position.set(-3, 4, 6);
    scene.add(lighting, keyLight);

    const barMaterial = new THREE.MeshStandardMaterial({
      color: 0x90aaa5,
      emissive: 0x355f6b,
      emissiveIntensity: 0.32,
      metalness: 0.28,
      roughness: 0.3,
    });
    const barEdgeMaterial = new THREE.LineBasicMaterial({ color: 0xe4eee9, transparent: true, opacity: 0.76 });
    const routeMaterial = new THREE.MeshBasicMaterial({ color: 0xdce7e2, transparent: true, opacity: 0.88 });
    const orbitMaterial = new THREE.MeshBasicMaterial({ color: 0x90aaa5, transparent: true, opacity: 0.72 });
    const nodeMaterial = new THREE.MeshBasicMaterial({ color: 0xf2efe8 });
    const barHeights = [1.55, 2.7, 2.05];
    const barPositions = [-0.72, 0, 0.72];
    const barSegments = [];
    const barHeightsBySegment = [];
    let markBaseY = -0.04;
    let markBaseX = 2.75;
    let markBaseScale = 1;
    let viewWidth = 0;
    let viewHeight = 0;
    const roundedBar = (width, height, depth, radius) => {
      const shape = new THREE.Shape();
      shape.moveTo(-width / 2 + radius, 0);
      shape.lineTo(width / 2 - radius, 0);
      shape.quadraticCurveTo(width / 2, 0, width / 2, radius);
      shape.lineTo(width / 2, height - radius);
      shape.quadraticCurveTo(width / 2, height, width / 2 - radius, height);
      shape.lineTo(-width / 2 + radius, height);
      shape.quadraticCurveTo(-width / 2, height, -width / 2, height - radius);
      shape.lineTo(-width / 2, radius);
      shape.quadraticCurveTo(-width / 2, 0, -width / 2 + radius, 0);
      const geometry = new THREE.ExtrudeGeometry(shape, {
        bevelEnabled: true,
        bevelSegments: 3,
        bevelSize: 0.045,
        bevelThickness: 0.045,
        depth,
        steps: 1,
      });
      geometry.translate(0, -height / 2, -depth / 2);
      return geometry;
    };

    barHeights.forEach((height, index) => {
      const geometry = roundedBar(0.43, height, 0.24, 0.1);
      const bar = new THREE.Mesh(geometry, barMaterial);
      const segment = new THREE.Group();
      segment.position.set(barPositions[index], height / 2 - 1.15, 0);
      segment.add(bar);
      const edge = new THREE.LineSegments(new THREE.EdgesGeometry(geometry), barEdgeMaterial);
      segment.add(edge);
      const node = new THREE.Mesh(new THREE.SphereGeometry(0.065, 16, 12), nodeMaterial);
      node.position.set(0, height / 2 + 0.12, 0.16);
      segment.add(node);
      sculpture.add(segment);
      barSegments.push(segment);
      barHeightsBySegment.push(height);
    });

    const route = new THREE.CatmullRomCurve3([
      new THREE.Vector3(-1.35, -0.55, 0.08),
      new THREE.Vector3(-0.95, 0.9, 0.22),
      new THREE.Vector3(0, 1.35, 0.38),
      new THREE.Vector3(0.95, 0.9, 0.22),
      new THREE.Vector3(1.35, -0.55, 0.08),
      new THREE.Vector3(0.75, -1.12, 0.24),
      new THREE.Vector3(0, -1.35, 0.38),
      new THREE.Vector3(-0.75, -1.12, 0.24),
    ], true);
    sculpture.add(new THREE.Mesh(new THREE.TubeGeometry(route, 72, 0.025, 8, false), routeMaterial));

    const orbit = new THREE.Group();
    const outerOrbit = new THREE.Mesh(new THREE.TorusGeometry(1.75, 0.018, 8, 120), orbitMaterial);
    outerOrbit.scale.y = 0.78;
    outerOrbit.rotation.set(0.76, 0.22, -0.28);
    const innerOrbit = new THREE.Mesh(new THREE.TorusGeometry(1.22, 0.012, 8, 96), orbitMaterial);
    innerOrbit.scale.y = 0.72;
    innerOrbit.rotation.set(1.08, -0.52, 0.45);
    orbit.add(outerOrbit, innerOrbit);
    sculpture.add(orbit);

    const routeNodes = [0, 1, 2].map(() => {
      const node = new THREE.Mesh(new THREE.SphereGeometry(0.075, 16, 12), nodeMaterial);
      sculpture.add(node);
      return node;
    });

    mark.add(sculpture);
    scene.add(mark);

    const placeMark = () => {
      const width = window.innerWidth;
      const layout = width < 700
        ? { cameraZ: 10, x: 0.16, y: -0.07, scale: 0.48 }
        : width < 1020
          ? { cameraZ: 8.5, x: 0.23, y: -0.03, scale: 0.72 }
          : { cameraZ: 8, x: 0.23, y: -0.03, scale: 1 };
      camera.position.z = layout.cameraZ;
      viewHeight = 2 * camera.position.z * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
      viewWidth = viewHeight * camera.aspect;
      markBaseX = viewWidth * layout.x;
      markBaseY = viewHeight * layout.y;
      markBaseScale = layout.scale;
      mark.position.set(markBaseX, markBaseY, 0);
      mark.scale.setScalar(layout.scale);
    };

    const scrollPose = { progress: 0 };
    const renderScene = () => {
      const progress = scrollPose.progress;
      const phase = progress * Math.PI * 2;
      const horizontalOffset = gsap.utils.interpolate([0, 0.025, 0.055, 0.025, -0.03, 0.02, 0], progress) * viewWidth;
      const verticalOffset = gsap.utils.interpolate([0, -0.07, 0.04, 0.1, -0.06, 0.04, 0], progress) * viewHeight;
      mark.position.set(
        markBaseX + horizontalOffset,
        markBaseY + verticalOffset,
        0,
      );
      mark.rotation.set(
        Math.sin(phase) * 0.16,
        phase,
        Math.sin(phase * 2) * 0.08,
      );
      mark.scale.setScalar(markBaseScale * (1 - progress * 0.12 + Math.sin(phase) * 0.035));
      sculpture.rotation.set(
        Math.sin(phase * 2) * 0.12,
        0,
        -Math.sin(phase) * 0.1,
      );
      orbit.rotation.set(0, phase * 1.5, -phase);
      barSegments.forEach((segment, index) => {
        const height = barHeightsBySegment[index];
        const rise = gsap.utils.clamp(0, 1, (progress - index * 0.035) / 0.14);
        const barScale = 0.7 + rise * 0.3;
        segment.position.y = height * barScale / 2 - 1.15;
        segment.scale.y = barScale;
        segment.rotation.set(
          Math.sin(phase + index) * 0.08,
          Math.sin(phase + index * 0.8) * 0.2,
          Math.cos(phase + index) * 0.045,
        );
      });
      routeNodes.forEach((node, index) => {
        node.position.copy(route.getPointAt((progress * 2 + index / routeNodes.length) % 1));
      });
      renderer.render(scene, camera);
    };

    const resizeScene = () => {
      const { width, height } = ambientCanvas.getBoundingClientRect();
      camera.aspect = width / height;
      placeMark();
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
      renderScene();
    };

    window.addEventListener("resize", resizeScene, { passive: true });
    reducedMotion.addEventListener("change", (event) => {
      if (!event.matches) return;
      gsap.killTweensOf(scrollPose);
      ScrollTrigger.getAll().forEach((trigger) => trigger.kill());
      scrollPose.progress = 0;
      renderScene();
    });

    resizeScene();
    if (!reducedMotion.matches) {
      gsap.to(scrollPose, {
        progress: 1,
        ease: "none",
        onUpdate: renderScene,
        scrollTrigger: {
          trigger: "#main-content",
          start: "top top",
          end: "bottom bottom",
          scrub: 0.45,
          invalidateOnRefresh: true,
        },
      });
    }
    window.addEventListener("pagehide", (event) => {
      if (event.persisted) return;
      renderer.dispose();
      const disposedMaterials = new Set();
      mark.traverse((object) => {
        object.geometry?.dispose();
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        materials.forEach((material) => {
          if (material && !disposedMaterials.has(material)) {
            material.dispose();
            disposedMaterials.add(material);
          }
        });
      });
    });
  } catch (error) {
    console.warn("Three.js background is unavailable; the page will continue without it.", error);
    ambientCanvas.hidden = true;
  }
}

reducedMotion.addEventListener("change", (event) => {
  if (!event.matches) return;
  gsap.ticker.remove(tickLenis);
  lenis?.destroy();
  lenis = undefined;
  gsap.killTweensOf(revealTargets);
  ScrollTrigger.getAll().forEach((trigger) => trigger.kill());
  gsap.set(revealTargets, { clearProps: "opacity,transform,visibility" });
});
