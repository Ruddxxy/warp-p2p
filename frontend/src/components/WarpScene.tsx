import { useRef, useMemo, useCallback } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import * as THREE from "three";

// --- Types ---

type ScenePhase =
  | "idle"
  | "connecting"
  | "transferring"
  | "completed"
  | "error";

interface WarpSceneProps {
  phase: ScenePhase;
}

// --- Constants ---

const TUNNEL_PARTICLE_COUNT = 600;
const AMBIENT_PARTICLE_COUNT = 200;
const TUNNEL_RADIUS = 4;
const TUNNEL_LENGTH = 20;

// Indigo primary color
const PRIMARY_COLOR = new THREE.Color("#6366F1");
const PRIMARY_BRIGHT = new THREE.Color("#818CF8");
const SUCCESS_COLOR = new THREE.Color("#22C55E");
const ERROR_COLOR = new THREE.Color("#EF4444");
const FAINT_COLOR = new THREE.Color("#71717A");

// --- Tunnel Particles ---
// These form the warp tunnel effect — a cylinder of particles streaming forward

function TunnelParticles({ phase }: { phase: ScenePhase }) {
  const meshRef = useRef<THREE.Points>(null);
  const materialRef = useRef<THREE.PointsMaterial>(null);

  const { positions, velocities } = useMemo(() => {
    const pos = new Float32Array(TUNNEL_PARTICLE_COUNT * 3);
    const vel = new Float32Array(TUNNEL_PARTICLE_COUNT);

    for (let i = 0; i < TUNNEL_PARTICLE_COUNT; i++) {
      const angle = Math.random() * Math.PI * 2;
      const radius = TUNNEL_RADIUS * (0.3 + Math.random() * 0.7);
      const z = (Math.random() - 0.5) * TUNNEL_LENGTH;

      pos[i * 3] = Math.cos(angle) * radius;
      pos[i * 3 + 1] = Math.sin(angle) * radius;
      pos[i * 3 + 2] = z;

      vel[i] = 0.5 + Math.random() * 1.5;
    }

    return { positions: pos, velocities: vel };
  }, []);

  const getTargetSpeed = useCallback((p: ScenePhase) => {
    switch (p) {
      case "idle":
        return 0.02;
      case "connecting":
        return 0.08;
      case "transferring":
        return 0.25;
      case "completed":
        return 0.01;
      case "error":
        return 0.005;
    }
  }, []);

  const getTargetColor = useCallback((p: ScenePhase) => {
    switch (p) {
      case "idle":
        return FAINT_COLOR;
      case "connecting":
        return PRIMARY_COLOR;
      case "transferring":
        return PRIMARY_BRIGHT;
      case "completed":
        return SUCCESS_COLOR;
      case "error":
        return ERROR_COLOR;
    }
  }, []);

  const currentSpeed = useRef(0.02);
  const currentColor = useRef(new THREE.Color(FAINT_COLOR));

  useFrame((_, delta) => {
    if (!meshRef.current) return;
    const geo = meshRef.current.geometry;
    const posAttr = geo.attributes.position as THREE.BufferAttribute;
    const arr = posAttr.array as Float32Array;

    // Smoothly interpolate speed
    const targetSpeed = getTargetSpeed(phase);
    currentSpeed.current += (targetSpeed - currentSpeed.current) * delta * 2;

    // Smoothly interpolate color
    const targetColor = getTargetColor(phase);
    currentColor.current.lerp(targetColor, delta * 3);
    if (materialRef.current) {
      materialRef.current.color.copy(currentColor.current);
    }

    const speed = currentSpeed.current;

    for (let i = 0; i < TUNNEL_PARTICLE_COUNT; i++) {
      // Move along Z axis (the tunnel direction)
      arr[i * 3 + 2] += speed * velocities[i] * 60 * delta;

      // Wrap around when reaching end of tunnel
      if (arr[i * 3 + 2] > TUNNEL_LENGTH / 2) {
        arr[i * 3 + 2] = -TUNNEL_LENGTH / 2;
        // Randomize XY position on wrap
        const angle = Math.random() * Math.PI * 2;
        const radius = TUNNEL_RADIUS * (0.3 + Math.random() * 0.7);
        arr[i * 3] = Math.cos(angle) * radius;
        arr[i * 3 + 1] = Math.sin(angle) * radius;
      }

      // Subtle orbital rotation for idle/connecting
      if (phase === "idle" || phase === "connecting") {
        const x = arr[i * 3];
        const y = arr[i * 3 + 1];
        const rotSpeed = 0.1 * delta;
        arr[i * 3] = x * Math.cos(rotSpeed) - y * Math.sin(rotSpeed);
        arr[i * 3 + 1] = x * Math.sin(rotSpeed) + y * Math.cos(rotSpeed);
      }
    }

    posAttr.needsUpdate = true;
  });

  return (
    <points ref={meshRef}>
      <bufferGeometry>
        <bufferAttribute
          attach="attributes-position"
          args={[positions, 3]}
          count={TUNNEL_PARTICLE_COUNT}
        />
      </bufferGeometry>
      <pointsMaterial
        ref={materialRef}
        size={phase === "transferring" ? 0.06 : 0.04}
        color={FAINT_COLOR}
        transparent
        opacity={phase === "idle" ? 0.3 : phase === "completed" ? 0.5 : 0.7}
        sizeAttenuation
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </points>
  );
}

// --- Ambient Particles ---
// Gentle floating dots that add depth — always present

function AmbientParticles({ phase }: { phase: ScenePhase }) {
  const meshRef = useRef<THREE.Points>(null);
  const materialRef = useRef<THREE.PointsMaterial>(null);

  const positions = useMemo(() => {
    const pos = new Float32Array(AMBIENT_PARTICLE_COUNT * 3);
    for (let i = 0; i < AMBIENT_PARTICLE_COUNT; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 16;
      pos[i * 3 + 1] = (Math.random() - 0.5) * 12;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 10;
    }
    return pos;
  }, []);

  const currentColor = useRef(new THREE.Color(FAINT_COLOR));

  useFrame((state, delta) => {
    if (!meshRef.current) return;
    const posAttr = meshRef.current.geometry.attributes
      .position as THREE.BufferAttribute;
    const arr = posAttr.array as Float32Array;
    const t = state.clock.elapsedTime;

    // Target color matches phase
    const targetColor =
      phase === "completed"
        ? SUCCESS_COLOR
        : phase === "transferring"
          ? PRIMARY_COLOR
          : FAINT_COLOR;
    currentColor.current.lerp(targetColor, delta * 2);
    if (materialRef.current) {
      materialRef.current.color.copy(currentColor.current);
    }

    for (let i = 0; i < AMBIENT_PARTICLE_COUNT; i++) {
      // Gentle drift
      arr[i * 3 + 1] += Math.sin(t * 0.3 + i * 0.5) * 0.002;
      arr[i * 3] += Math.cos(t * 0.2 + i * 0.3) * 0.001;

      // Wrap boundaries
      if (arr[i * 3] > 8) arr[i * 3] = -8;
      if (arr[i * 3] < -8) arr[i * 3] = 8;
      if (arr[i * 3 + 1] > 6) arr[i * 3 + 1] = -6;
      if (arr[i * 3 + 1] < -6) arr[i * 3 + 1] = 6;
    }

    posAttr.needsUpdate = true;
  });

  return (
    <points ref={meshRef}>
      <bufferGeometry>
        <bufferAttribute
          attach="attributes-position"
          args={[positions, 3]}
          count={AMBIENT_PARTICLE_COUNT}
        />
      </bufferGeometry>
      <pointsMaterial
        ref={materialRef}
        size={0.025}
        color={FAINT_COLOR}
        transparent
        opacity={0.25}
        sizeAttenuation
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </points>
  );
}

// --- Completion Burst ---
// A brief outward explosion of particles when transfer completes

function CompletionBurst({ active }: { active: boolean }) {
  const meshRef = useRef<THREE.Points>(null);
  const materialRef = useRef<THREE.PointsMaterial>(null);
  const burstTime = useRef(0);
  const hasTriggered = useRef(false);

  const BURST_COUNT = 150;

  const { positions, velocities } = useMemo(() => {
    const pos = new Float32Array(BURST_COUNT * 3);
    const vel = new Float32Array(BURST_COUNT * 3);
    for (let i = 0; i < BURST_COUNT; i++) {
      // Start at center
      pos[i * 3] = 0;
      pos[i * 3 + 1] = 0;
      pos[i * 3 + 2] = 0;
      // Random outward velocity
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const speed = 2 + Math.random() * 4;
      vel[i * 3] = Math.sin(phi) * Math.cos(theta) * speed;
      vel[i * 3 + 1] = Math.sin(phi) * Math.sin(theta) * speed;
      vel[i * 3 + 2] = Math.cos(phi) * speed;
    }
    return { positions: pos, velocities: vel };
  }, []);

  useFrame((_, delta) => {
    if (!meshRef.current || !materialRef.current) return;

    if (active && !hasTriggered.current) {
      // Reset burst
      hasTriggered.current = true;
      burstTime.current = 0;
      const posAttr = meshRef.current.geometry.attributes
        .position as THREE.BufferAttribute;
      const arr = posAttr.array as Float32Array;
      for (let i = 0; i < BURST_COUNT; i++) {
        arr[i * 3] = 0;
        arr[i * 3 + 1] = 0;
        arr[i * 3 + 2] = 0;
      }
      posAttr.needsUpdate = true;
    }

    if (!active) {
      hasTriggered.current = false;
    }

    if (hasTriggered.current) {
      burstTime.current += delta;
      const posAttr = meshRef.current.geometry.attributes
        .position as THREE.BufferAttribute;
      const arr = posAttr.array as Float32Array;

      // Fade out over 2 seconds
      const fade = Math.max(0, 1 - burstTime.current / 2);
      materialRef.current.opacity = fade * 0.8;

      for (let i = 0; i < BURST_COUNT; i++) {
        arr[i * 3] += velocities[i * 3] * delta * fade;
        arr[i * 3 + 1] += velocities[i * 3 + 1] * delta * fade;
        arr[i * 3 + 2] += velocities[i * 3 + 2] * delta * fade;
      }

      posAttr.needsUpdate = true;
    }
  });

  return (
    <points ref={meshRef}>
      <bufferGeometry>
        <bufferAttribute
          attach="attributes-position"
          args={[positions, 3]}
          count={BURST_COUNT}
        />
      </bufferGeometry>
      <pointsMaterial
        ref={materialRef}
        size={0.05}
        color={SUCCESS_COLOR}
        transparent
        opacity={0}
        sizeAttenuation
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </points>
  );
}

// --- Scene Composition ---

function Scene({ phase }: { phase: ScenePhase }) {
  return (
    <>
      <TunnelParticles phase={phase} />
      <AmbientParticles phase={phase} />
      <CompletionBurst active={phase === "completed"} />
    </>
  );
}

// --- Exported Component ---

export function WarpScene({ phase }: WarpSceneProps) {
  return (
    <div
      className="fixed inset-0 pointer-events-none"
      style={{ zIndex: 0 }}
      aria-hidden="true"
    >
      <Canvas
        camera={{ position: [0, 0, 6], fov: 60 }}
        dpr={[1, 1.5]}
        gl={{
          antialias: false,
          alpha: true,
          powerPreference: "low-power",
        }}
        style={{ background: "transparent" }}
      >
        <Scene phase={phase} />
      </Canvas>
    </div>
  );
}
