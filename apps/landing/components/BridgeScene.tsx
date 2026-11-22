import { Line, RoundedBox } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import { QuadraticBezierCurve3, Vector3, type Group, type Mesh, type MeshStandardMaterial } from "three";
import { useInView, useReducedMotion } from "@/lib/hooks";
import { useSiteState } from "./SiteState";

export type VmState = "online" | "asleep" | "waking";

export interface SceneVm {
  id: string;
  providerId: string;
  name: string;
  state: VmState;
}

const vmX = 3.9;
const vmRows = [1.35, 0, -1.35];
const bridgeLeft = new Vector3(-1.75, -0.05, 0);
const bridgeRight = new Vector3(1.75, -0.05, 0);
const devices = [new Vector3(-3.55, 0.25, 0), new Vector3(-3.05, -1.25, 0.6)];

const curve = (from: Vector3, to: Vector3, lift = 0.5) =>
  new QuadraticBezierCurve3(from, new Vector3((from.x + to.x) / 2, (from.y + to.y) / 2 + lift, (from.z + to.z) / 2), to);

/** Small spheres riding a curve. Requests go out in violet, replies come back in white. */
function Packets({ path, count, color, reverse = false, speed = 0.32 }: { path: QuadraticBezierCurve3; count: number; color: string; reverse?: boolean; speed?: number }) {
  const refs = useRef<(Mesh | null)[]>([]);
  useFrame(({ clock }) => {
    refs.current.forEach((mesh, i) => {
      if (!mesh) return;
      const t = (clock.elapsedTime * speed + i / count) % 1;
      mesh.position.copy(path.getPointAt(reverse ? 1 - t : t));
      mesh.scale.setScalar(Math.sin(t * Math.PI) * 0.9 + 0.1);
    });
  });
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <mesh key={i} ref={(mesh) => void (refs.current[i] = mesh)}>
          <sphereGeometry args={[0.055, 12, 12]} />
          <meshBasicMaterial color={color} toneMapped={false} />
        </mesh>
      ))}
    </>
  );
}

function Laptop({ position }: { position: Vector3 }) {
  return (
    <group position={position} rotation={[0.2, 0.32, 0]}>
      <RoundedBox args={[1.5, 0.07, 1.0]} radius={0.03} position={[0, -0.45, 0.2]}>
        <meshStandardMaterial color="#3a3a40" metalness={0.5} roughness={0.35} />
      </RoundedBox>
      <group position={[0, -0.42, -0.3]} rotation={[-0.2, 0, 0]}>
        <RoundedBox args={[1.5, 0.98, 0.05]} radius={0.03} position={[0, 0.49, 0]}>
          <meshStandardMaterial color="#3a3a40" metalness={0.5} roughness={0.35} />
        </RoundedBox>
        <mesh position={[0, 0.49, 0.027]}>
          <planeGeometry args={[1.38, 0.86]} />
          <meshBasicMaterial color="#0b0912" />
        </mesh>
        {/* A thread in T3 Code: a few lines of chat. */}
        {[0.75, 0.62, 0.49, 0.36, 0.23].map((y, i) => (
          <mesh key={y} position={[i % 2 ? 0.12 : -0.08, y, 0.03]}>
            <planeGeometry args={[i % 2 ? 0.9 : 1.05, 0.05]} />
            <meshBasicMaterial color={i % 2 ? "#3a3550" : "#8b5cf6"} transparent opacity={i % 2 ? 1 : 0.8} />
          </mesh>
        ))}
      </group>
    </group>
  );
}

function Phone({ position }: { position: Vector3 }) {
  return (
    <group position={position} rotation={[0.1, 0.35, -0.08]}>
      <RoundedBox args={[0.46, 0.92, 0.06]} radius={0.06}>
        <meshStandardMaterial color="#3a3a40" metalness={0.5} roughness={0.35} />
      </RoundedBox>
      <mesh position={[0, 0, 0.032]}>
        <planeGeometry args={[0.4, 0.84]} />
        <meshBasicMaterial color="#0b0912" />
      </mesh>
      {[0.25, 0.15, 0.05].map((y, i) => (
        <mesh key={y} position={[0, y, 0.034]}>
          <planeGeometry args={[0.3, 0.04]} />
          <meshBasicMaterial color={i === 1 ? "#3a3550" : "#8b5cf6"} />
        </mesh>
      ))}
    </group>
  );
}

/** The VM Bridge mark in 3D: an arch over a deck, with hangers and legs. */
function Bridge({ glow }: { glow: number }) {
  const arch = useMemo(() => curve(new Vector3(-1.55, 0, 0), new Vector3(1.55, 0, 0), 2.6), []);
  const hangers = [-0.75, 0, 0.75].map((x) => {
    const top = arch.getPoint((x + 1.55) / 3.1).y;
    return { x, top };
  });
  return (
    <group>
      <mesh>
        <tubeGeometry args={[arch, 64, 0.075, 12, false]} />
        <meshStandardMaterial color="#f5f5f5" roughness={0.3} metalness={0.2} />
      </mesh>
      <RoundedBox args={[3.6, 0.13, 0.6]} radius={0.05} position={[0, -0.05, 0]}>
        <meshStandardMaterial color="#f5f5f5" roughness={0.3} metalness={0.2} />
      </RoundedBox>
      {hangers.map(({ x, top }) => (
        <mesh key={x} position={[x, top / 2, 0]}>
          <cylinderGeometry args={[0.045, 0.045, top, 10]} />
          <meshStandardMaterial color="#d4d4d4" roughness={0.35} />
        </mesh>
      ))}
      {[-1.1, 1.1].map((x) => (
        <mesh key={x} position={[x, -0.55, 0]}>
          <cylinderGeometry args={[0.06, 0.06, 0.9, 10]} />
          <meshStandardMaterial color="#d4d4d4" roughness={0.35} />
        </mesh>
      ))}
      {/* The platform it stands on lights up with traffic. */}
      <RoundedBox args={[4.2, 0.08, 1.4]} radius={0.04} position={[0, -1.04, 0]}>
        <meshStandardMaterial color="#141414" emissive="#8b5cf6" emissiveIntensity={0.04 + glow * 0.12} roughness={0.8} metalness={0.2} />
      </RoundedBox>
    </group>
  );
}

function Vm({ vm, y, onToggle }: { vm: SceneVm; y: number; onToggle: () => void }) {
  const group = useRef<Group>(null);
  const led = useRef<MeshStandardMaterial>(null);
  const [hovered, setHovered] = useState(false);
  const asleep = vm.state === "asleep";

  useFrame(({ clock }, delta) => {
    if (!group.current || !led.current) return;
    const target = asleep ? y - 0.12 : y;
    group.current.position.y += (target - group.current.position.y) * Math.min(1, delta * 6);
    const scale = hovered ? 1.06 : 1;
    group.current.scale.setScalar(group.current.scale.x + (scale - group.current.scale.x) * Math.min(1, delta * 10));
    led.current.emissiveIntensity = vm.state === "waking" ? 1.2 + Math.sin(clock.elapsedTime * 10) * 1 : asleep ? 0.1 : 2;
  });

  useEffect(() => () => void (document.body.style.cursor = ""), []);

  return (
    <group
      ref={group}
      position={[vmX, y, 0]}
      rotation={[0.08, -0.4, 0]}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
      onPointerOver={(event) => {
        event.stopPropagation();
        setHovered(true);
        document.body.style.cursor = "pointer";
      }}
      onPointerOut={() => {
        setHovered(false);
        document.body.style.cursor = "";
      }}
    >
      <RoundedBox args={[1.5, 0.92, 0.92]} radius={0.1}>
        <meshStandardMaterial color={asleep ? "#0c0c0c" : "#18181b"} metalness={0.5} roughness={0.4} />
      </RoundedBox>
      {/* Violet strip on the front face. */}
      <mesh position={[-0.15, 0.18, 0.465]}>
        <planeGeometry args={[0.9, 0.08]} />
        <meshBasicMaterial color="#8b5cf6" transparent opacity={asleep ? 0.15 : 1} toneMapped={false} />
      </mesh>
      {[-0.02, -0.16].map((rowY) => (
        <mesh key={rowY} position={[-0.15, rowY, 0.465]}>
          <planeGeometry args={[0.9, 0.05]} />
          <meshBasicMaterial color="#2a2a2e" transparent opacity={asleep ? 0.4 : 1} />
        </mesh>
      ))}
      <mesh position={[0.52, 0.18, 0.47]}>
        <sphereGeometry args={[0.055, 16, 16]} />
        <meshStandardMaterial
          ref={led}
          color={vm.state === "online" ? "#8b5cf6" : vm.state === "waking" ? "#a78bfa" : "#3f3f46"}
          emissive={vm.state === "online" ? "#8b5cf6" : vm.state === "waking" ? "#a78bfa" : "#000"}
          toneMapped={false}
        />
      </mesh>
    </group>
  );
}

function Rig({ children, narrow }: { children: React.ReactNode; narrow: boolean }) {
  const group = useRef<Group>(null);
  const { camera, size } = useThree();
  useEffect(() => {
    // Fit the camera so the scene (~9 units wide) nearly fills the canvas width
    // at any aspect (visible width = 0.728 * distance * aspect); K leaves a
    // small margin so the right-hand VM panels clear the canvas edge.
    const aspect = size.width / size.height;
    camera.position.set(0, narrow ? 0.4 : 0.9, Math.max(14.6 / aspect, 5.3));
    camera.lookAt(0, 0, 0);
  }, [camera, size, narrow]);
  useFrame(({ pointer }, delta) => {
    if (!group.current) return;
    const ease = Math.min(1, delta * 3);
    group.current.rotation.y += (pointer.x * 0.22 - group.current.rotation.y) * ease;
    group.current.rotation.x += (-pointer.y * 0.1 - group.current.rotation.x) * ease;
  });
  return (
    <group ref={group} position={[0, -0.35, 0]}>
      {children}
    </group>
  );
}

export function BridgeScene({
  vms,
  onToggle,
  narrow,
  onReady,
}: {
  vms: SceneVm[];
  onToggle: (id: string) => void;
  narrow: boolean;
  /** Fires once the canvas exists, so the hero can fade the stage chrome in. */
  onReady?: () => void;
}) {
  const wrapper = useRef<HTMLDivElement>(null);
  const inView = useInView(wrapper);
  const reduced = useReducedMotion();
  const { phase } = useSiteState();
  const animate = inView && !reduced && phase !== "asleep";

  const deviceCurves = useMemo(() => devices.map((d) => curve(new Vector3(d.x + 0.6, d.y, d.z), bridgeLeft, 0.35)), []);
  const vmCurves = useMemo(() => vmRows.map((y) => curve(bridgeRight, new Vector3(vmX - 0.8, y, 0), 0.25)), []);
  const online = vms.filter((vm) => vm.state === "online").length;

  return (
    <div ref={wrapper} className="absolute inset-0">
      <Canvas
        frameloop={animate ? "always" : "demand"}
        dpr={[1, 2]}
        camera={{ fov: 40, position: [0, 0.9, 10] }}
        gl={{ antialias: true, alpha: true }}
        onCreated={onReady}
        aria-label="VM Bridge connecting your devices to cloud VMs"
      >
        <ambientLight intensity={0.8} />
        <directionalLight position={[-6, 2, 4]} intensity={1.2} />
        <directionalLight position={[3, 5, 6]} intensity={2.2} />
        <pointLight position={[0, 2.2, 2]} color="#8b5cf6" intensity={8} distance={8} />
        <Rig narrow={narrow}>
          <Laptop position={devices[0]} />
          <Phone position={devices[1]} />
          <Bridge glow={online / vms.length} />
          {deviceCurves.map((path, i) => (
            <group key={i}>
              <Line points={path.getPoints(40)} color="#3b2f63" lineWidth={1.5} />
              {animate ? <Packets path={path} count={3} color="#a78bfa" speed={0.3 + i * 0.05} /> : null}
            </group>
          ))}
          {vms.map((vm, i) => {
            const path = vmCurves[i];
            const live = vm.state === "online";
            return (
              <group key={vm.id}>
                <Line
                  points={path.getPoints(40)}
                  color={live ? "#4c3a8a" : "#2a2a2a"}
                  lineWidth={1.5}
                  dashed={!live}
                  dashSize={0.12}
                  gapSize={0.1}
                />
                {animate && live ? (
                  <>
                    <Packets path={path} count={2} color="#a78bfa" speed={0.42} />
                    <Packets path={path} count={2} color="#f5f5f5" reverse speed={0.36} />
                  </>
                ) : null}
                <Vm vm={vm} y={vmRows[i]} onToggle={() => onToggle(vm.id)} />
              </group>
            );
          })}
        </Rig>
      </Canvas>
    </div>
  );
}
