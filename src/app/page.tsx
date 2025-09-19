'use client';

import {
  useEffect, useMemo, useRef, useState, useCallback,
  type MutableRefObject,
} from 'react';
import type { ReactNode, ButtonHTMLAttributes } from 'react';
import * as THREE from 'three';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Environment, ContactShadows, OrthographicCamera, Html, MapControls } from '@react-three/drei';
import type { MapControls as MapControlsImpl } from 'three-stdlib';

/* ───────────────── Types & Constants ───────────────── */
type StepPreset = 'fine' | 'med' | 'coarse';
type WallSide = 'back' | 'left';
type ItemType =
  | 'bed' | 'desk' | 'dresser' | 'tv' | 'rug' | 'lamp' | 'plant'
  | 'window' | 'frame' | 'mirror' | 'trash' | 'chair';
type WoodTone = 'light' | 'mid' | 'dark';

type Item = {
  id: string;
  type: ItemType;
  position: [number, number, number];
  rotationY: number;
  scale: number;
  props?: {
    bedSheet?: string;
    rugW?: number; rugD?: number; rugColor?: string;
    wood?: WoodTone;
    wall?: WallSide;
  };
};

type Theme = { name: string; floor: string; wall: string };

type DragKind = 'floor' | 'back' | 'left' | null;
type DragState = { id: string | null; kind: DragKind; offset: THREE.Vector3 };

type Steps = { grid: number; gridY: number; move: number; rotate: number; scale: number };

/* ── Room size: “놓을 수 있는 구역” ── */
const ROOM = { halfX: 3.0, halfZ: 3.0, height: 3.0 };
const WALL = { thick: 0.12, eps: 0.002 };
const WORLD = {
  FLOOR_Y: 0,
  BACK_Z: -ROOM.halfZ - WALL.thick / 2,
  LEFT_X: -ROOM.halfX - WALL.thick / 2,
  LIMIT_X: ROOM.halfX,
  LIMIT_Z: ROOM.halfZ,
};
const FRONT = {
  BACK_Z: -ROOM.halfZ + WALL.eps,
  LEFT_X: -ROOM.halfX + WALL.eps,
};

const THEMES: Theme[] = [
  { name: 'Sky',   floor: '#D7EBFF', wall: '#F2F7FF' },
  { name: 'Mauve', floor: '#E9D3D6', wall: '#F2E4E7' },
  { name: 'Cream', floor: '#F4E6C8', wall: '#FFF3D9' },
  { name: 'Mint',  floor: '#D9F1EA', wall: '#EDFBF7' },
];

const UI = {
  panel: '#F7F2EE', panelText: '#3A332F', btnBorder: '#D8CFC8', btnText: '#3A332F',
  badgeBG: 'rgba(31,41,55,0.9)',
};

/* ───────────────── Utils ───────────────── */
const DEG = (d: number) => (d * Math.PI) / 180;
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const quantize = (v: number, g: number) => Math.round(v / g) * g;
const isWallType = (t: ItemType) => t === 'window' || t === 'frame' || t === 'mirror';
const defaultWall: Partial<Record<ItemType, WallSide>> = {
  window: 'back',
  frame: 'left',
  mirror: 'back',
} as const;

const SUPPORT_TYPES: ItemType[] = ['desk', 'dresser'];
const STACKABLE_TYPES: ItemType[] = ['tv', 'plant', 'lamp', 'trash'];

/* ───────────────── Main Page ───────────────── */
export default function Page() {
  const [themeIdx, setThemeIdx] = useState(0);
  const [zoom, setZoom] = useState(120);
  const [stepPreset, setStepPreset] = useState<StepPreset>('med');
  const [items, setItems] = useState<Item[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hideLabels, setHideLabels] = useState(false);
  const [showHelp, setShowHelp] = useState(false);

  // 화면 팬 제어(ref): 드래그 중에는 비활성화
  const controlsRef = useRef<MapControlsImpl | null>(null);

  const theme = THEMES[themeIdx];
  const steps: Steps = useMemo(() => {
    if (stepPreset === 'fine') return { move: 0.12, rotate: 5, scale: 0.02, grid: 0.12, gridY: 0.08 };
    if (stepPreset === 'coarse') return { move: 0.5, rotate: 30, scale: 0.1, grid: 0.5, gridY: 0.25 };
    return { move: 0.25, rotate: 15, scale: 0.05, grid: 0.25, gridY: 0.16 };
  }, [stepPreset]);

  /* ── Save / Load / Export / Import ── */
  const STORAGE_KEY = 'room-builder-save-v1';

  const doSaveLocal = useCallback(() => {
    if (typeof window === 'undefined') return;
    const payload = { version: 1, items, themeIdx, zoom };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    alert('저장 완료!');
  }, [items, themeIdx, zoom]);

  const doLoadLocal = useCallback(() => {
    if (typeof window === 'undefined') return;
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) { alert('저장된 데이터가 없어요.'); return; }
    try {
      const data = JSON.parse(raw) as { items: Item[]; themeIdx: number; zoom: number };
      if (Array.isArray(data.items)) setItems(data.items);
      if (typeof data.themeIdx === 'number') setThemeIdx(data.themeIdx);
      if (typeof data.zoom === 'number') setZoom(data.zoom);
      setSelectedId(null);
      alert('불러오기 완료!');
    } catch {
      alert('불러오기 실패(형식 오류).');
    }
  }, []);

  const doExportJSON = useCallback(() => {
    const payload = { version: 1, items, themeIdx, zoom };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'room-save.json'; a.click();
    URL.revokeObjectURL(url);
  }, [items, themeIdx, zoom]);

  const fileRef = useRef<HTMLInputElement | null>(null);
  const doImportJSON = useCallback((file?: File) => {
    const f = file ?? fileRef.current?.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result || '{}')) as { items?: Item[]; themeIdx?: number; zoom?: number };
        if (Array.isArray(data.items)) setItems(data.items);
        if (typeof data.themeIdx === 'number') setThemeIdx(data.themeIdx);
        if (typeof data.zoom === 'number') setZoom(data.zoom);
        setSelectedId(null);
        alert('가져오기 완료!');
      } catch {
        alert('가져오기 실패(형식 오류).');
      }
    };
    reader.readAsText(f);
  }, []);

  /* ── Add / Remove ── */
  const addItem = (type: ItemType) => {
    const id = `${type}-${Date.now()}-${(Math.random() * 1e5) | 0}`;
    const props: Item['props'] = {};
    if (type === 'bed') props.bedSheet = '#C7D6E8';
    if (type === 'rug') { props.rugW = 1.6; props.rugD = 1.2; props.rugColor = '#C2A6A0'; }
    if (type === 'desk' || type === 'dresser' || type === 'chair') props.wood = 'mid';
    if (isWallType(type)) props.wall = (defaultWall as Record<ItemType, WallSide | undefined>)[type] ?? 'back';

    const pos: [number, number, number] =
      isWallType(type) ? initWallPos(props.wall!) : nextFloorSlot(items, steps.grid);

    setItems((p) => [...p, { id, type, position: pos, rotationY: wallRotation(type, props.wall), scale: 1, props }]);
    setSelectedId(id);
  };

  const removeSelected = () => {
    if (!selectedId) return;
    setItems((p) => p.filter((i) => i.id !== selectedId));
    setSelectedId(null);
  };

  /* ── Move/Rotate/Scale (buttons) ── */
  const sel = items.find((i) => i.id === selectedId) ?? null;
  const WALL_INSET = 0.2;

  const moveDir = (dir: 'left'|'right'|'up'|'down') => {
    if (!sel) return;

    if (isWallType(sel.type)) {
      const side: WallSide = sel.props?.wall ?? 'back';
      const { grid, gridY } = steps;
      setItems((prev) => prev.map((it) => {
        if (it.id !== sel.id) return it;
        let [x,y] = it.position;
        if (side === 'back') {
          if (dir === 'left')  x = quantize(clamp(x - grid, -ROOM.halfX + WALL_INSET, ROOM.halfX - WALL_INSET), grid);
          if (dir === 'right') x = quantize(clamp(x + grid, -ROOM.halfX + WALL_INSET, ROOM.halfX - WALL_INSET), grid);
          if (dir === 'up')    y = quantize(clamp(y + gridY, 0.2, ROOM.height - 0.6), gridY);
          if (dir === 'down')  y = quantize(clamp(y - gridY, 0.2, ROOM.height - 0.6), gridY);
          return { ...it, position: [x, y, FRONT.BACK_Z], rotationY: 0 };
        } else {
          let z = it.position[2];
          if (dir === 'left')  z = quantize(clamp(z + grid, -ROOM.halfZ + WALL_INSET, ROOM.halfZ - WALL_INSET), grid);
          if (dir === 'right') z = quantize(clamp(z - grid, -ROOM.halfZ + WALL_INSET, ROOM.halfZ - WALL_INSET), grid);
          if (dir === 'up')    y = quantize(clamp(y + gridY, 0.2, ROOM.height - 0.6), gridY);
          if (dir === 'down')  y = quantize(clamp(y - gridY, 0.2, ROOM.height - 0.6), gridY);
          return { ...it, position: [FRONT.LEFT_X, y, z], rotationY: Math.PI / 2 };
        }
      }));
      return;
    }

    const s = steps.move;
    const dx = dir === 'left' ? -s : dir === 'right' ? s : 0;
    const dz = dir === 'up' ? -s : dir === 'down' ? s : 0;

    setItems((prev) => prev.map((it) => {
      if (it.id !== sel.id) return it;
      const nx = quantize(clamp(it.position[0] + dx, -ROOM.halfX, ROOM.halfX), steps.grid);
      const nz = quantize(clamp(it.position[2] + dz, -ROOM.halfZ, ROOM.halfZ), steps.grid);
      const ny = STACKABLE_TYPES.includes(it.type) ? computeStackY(prev, it, nx, nz) : WORLD.FLOOR_Y;
      return { ...it, position: [nx, ny, nz] };
    }));
  };

  const rotateBy = (deg: number) => {
    if (!sel || isWallType(sel.type)) return;
    setItems((prev) => prev.map((it) => it.id === sel.id ? { ...it, rotationY: it.rotationY + DEG(deg) } : it));
  };

  const scaleBy = (ds: number) => {
    if (!sel || isWallType(sel.type)) return;
    setItems((prev) => prev.map((it) => it.id === sel.id ? { ...it, scale: clamp(it.scale + ds, 0.3, 2.2) } : it));
  };

  /* ── Drag state (controls disable/enable) ── */
  const dragRef = useRef<DragState>({ id: null, kind: null, offset: new THREE.Vector3() });

  const startDrag = (it: Item, ePoint: THREE.Vector3) => {
    dragRef.current.id = it.id;
    if (controlsRef.current) controlsRef.current.enabled = false; // 팬 비활성
    if (isWallType(it.type)) {
      const side = (it.props?.wall ?? defaultWall[it.type as ItemType]) as WallSide;
      dragRef.current.kind = side === 'back' ? 'back' : 'left';
      if (side === 'back') dragRef.current.offset.set(it.position[0] - ePoint.x, it.position[1] - ePoint.y, 0);
      else dragRef.current.offset.set(0, it.position[1] - ePoint.y, it.position[2] - ePoint.z);
    } else {
      dragRef.current.kind = 'floor';
      dragRef.current.offset.set(it.position[0] - ePoint.x, 0, it.position[2] - ePoint.z);
    }
  };

  const endDrag = useCallback(() => {
    dragRef.current.id = null;
    dragRef.current.kind = null;
    if (controlsRef.current) controlsRef.current.enabled = true; // 팬 재활성
  }, []);

  return (
    <main style={{ width: '100vw', height: '100vh', background: '#F5EFEA' }}>
      {/* Top bar */}
      <div style={{ position:'absolute', top:12, left:12, display:'flex', gap:8, zIndex:20, fontFamily:'ui-sans-serif, system-ui' }}>
        <Pill><Label>Step/Grid</Label>
          <Seg active={stepPreset==='fine'} onClick={()=>setStepPreset('fine')}>Fine</Seg>
          <Seg active={stepPreset==='med'}  onClick={()=>setStepPreset('med')}>Med</Seg>
          <Seg active={stepPreset==='coarse'} onClick={()=>setStepPreset('coarse')}>Coarse</Seg>
        </Pill>
        <Pill><Label>Zoom</Label>
          <Seg onClick={()=>setZoom((z)=>clamp(z-10, 60, 200))}>-</Seg>
          <span style={{ padding:'6px 8px', color: UI.panelText }}>{zoom}</span>
          <Seg onClick={()=>setZoom((z)=>clamp(z+10, 60, 200))}>+</Seg>
        </Pill>
        <Pill>
          <Seg onClick={()=>setHideLabels(v=>!v)}>{hideLabels?'Show Labels':'Hide Labels'}</Seg>
          <Seg onClick={() => setShowHelp(v=>!v)}>{showHelp?'Hide Help':'Show Help'}</Seg>
          <Seg onClick={removeSelected}>Delete</Seg>
          <Seg onClick={()=>{ setItems([]); setSelectedId(null); }}>Clear All</Seg>
        </Pill>

        {/* Save / Load */}
        <Pill>
          <Seg onClick={doSaveLocal}>Save</Seg>
          <Seg onClick={doLoadLocal}>Load</Seg>
          <Seg onClick={doExportJSON}>Export</Seg>
          <Seg onClick={()=>fileRef.current?.click()}>Import</Seg>
          <input
            ref={fileRef}
            type="file"
            accept="application/json"
            style={{ display:'none' }}
            onChange={(e)=>doImportJSON(e.target.files?.[0])}
          />
        </Pill>
      </div>

      {/* Shelf */}
      <Shelf onAdd={addItem} themeIdx={themeIdx} setThemeIdx={setThemeIdx} />

      {/* Pads */}
      <div style={{ position:'absolute', bottom:16, left:'50%', transform:'translateX(-50%)',
        display:'flex', gap:10, zIndex:15, fontFamily:'ui-sans-serif, system-ui' }}>
        <Pad><PadRow><PadBtn onMouseDown={()=>moveDir('up')} onTouchStart={()=>moveDir('up')}>↑</PadBtn></PadRow>
             <PadRow>
               <PadBtn onMouseDown={()=>moveDir('left')} onTouchStart={()=>moveDir('left')}>←</PadBtn>
               <PadBtn onMouseDown={()=>moveDir('down')} onTouchStart={()=>moveDir('down')}>↓</PadBtn>
               <PadBtn onMouseDown={()=>moveDir('right')} onTouchStart={()=>moveDir('right')}>→</PadBtn>
             </PadRow></Pad>
        <Pad><PadRow><PadBtn onMouseDown={()=>rotateBy(+steps.rotate)} onTouchStart={()=>rotateBy(+steps.rotate)}>⟳</PadBtn>
                   <PadBtn onMouseDown={()=>rotateBy(-steps.rotate)} onTouchStart={()=>rotateBy(-steps.rotate)}>⟲</PadBtn></PadRow></Pad>
        <Pad><PadRow><PadBtn onMouseDown={()=>scaleBy(-steps.scale)} onTouchStart={()=>scaleBy(-steps.scale)}>－</PadBtn>
                   <PadBtn onMouseDown={()=>scaleBy(+steps.scale)} onTouchStart={()=>scaleBy(+steps.scale)}>＋</PadBtn></PadRow></Pad>
      </div>

      {/* Help */}
      {showHelp && <HelpTip />}

      {/* Inspector */}
      {sel && (
        <Inspector
          item={sel}
          onChange={(patch) =>
            setItems((prev) =>
              prev.map((it) => {
                if (it.id !== sel.id) return it;
                const nextProps = { ...it.props, ...(patch ?? {}) };
                if (isWallType(sel.type)) {
                  const side = (patch?.wall ?? nextProps.wall ?? defaultWall[sel.type]) as WallSide;
                  const nextRot = wallRotation(sel.type, side);
                  const nextPos = patch?.wall ? snapToWall(it.position, side) : it.position;
                  return { ...it, props: nextProps, rotationY: nextRot, position: nextPos };
                }
                return { ...it, props: nextProps };
              })
            )
          }
        />
      )}

      <Canvas shadows onPointerMissed={() => { setSelectedId(null); endDrag(); }}>
        {/* 카메라 + 팬(이동) 전용 컨트롤 */}
        <SceneCamera zoom={zoom} controlsRef={controlsRef} />

        <SceneRoom theme={theme} />
        <ambientLight intensity={0.6} />
        <directionalLight position={[6,10,6]} intensity={1.1} castShadow shadow-mapSize-width={2048} shadow-mapSize-height={2048} />

        {/* Drag catchers: 드래그 종료 시에도 팬 재활성화 */}
        <DragCatchers dragRef={dragRef} steps={steps} setItems={setItems} onRelease={endDrag} />

        {items.map((it)=>(
          <ItemNode
            key={it.id}
            item={it}
            selected={selectedId===it.id}
            hideLabel={hideLabels}
            onSelect={()=>setSelectedId(it.id)}
            onStartDrag={startDrag}
            onEndDrag={endDrag}
          />
        ))}

        <ContactShadows position={[0,0,0]} opacity={0.3} scale={Math.max(ROOM.halfX, ROOM.halfZ)*2+2} blur={2.8} far={3} />
        <Environment preset="city" />
      </Canvas>
    </main>
  );
}

/* ───────────────── Camera (pan-only) ───────────────── */
function SceneCamera({ zoom, controlsRef }:{
  zoom: number;
  controlsRef: MutableRefObject<MapControlsImpl | null>;
}) {
  const camRef = useRef<THREE.OrthographicCamera | null>(null);
  const ctrlRef = useRef<MapControlsImpl | null>(null);

  useEffect(()=>{ controlsRef.current = ctrlRef.current; }, [controlsRef]);

  const PAN = { x: ROOM.halfX + 1.0, z: ROOM.halfZ + 1.0 };

  useFrame(() => {
    const ctrl = ctrlRef.current;
    if (!ctrl) return;
    const t = ctrl.target as THREE.Vector3;
    const obj = ctrl.object as THREE.Camera & { position: THREE.Vector3 };
    const nx = clamp(t.x, -PAN.x, PAN.x);
    const nz = clamp(t.z, -PAN.z, PAN.z);
    const dx = nx - t.x, dz = nz - t.z;
    if (dx || dz) { t.set(nx, t.y, nz); obj.position.x += dx; obj.position.z += dz; ctrl.update(); }
  });

  return (
    <>
      <OrthographicCamera ref={camRef} makeDefault zoom={zoom} position={[7,7,7]} onUpdate={(c)=>c.lookAt(0,0,0)} />
      <MapControls ref={ctrlRef} enableRotate={false} enableZoom={false} screenSpacePanning panSpeed={1} />
    </>
  );
}

/* ───────────────── Drag catchers ───────────────── */
function DragCatchers({
  dragRef, steps, setItems, onRelease,
}:{
  dragRef: MutableRefObject<DragState>;
  steps: Steps;
  setItems: React.Dispatch<React.SetStateAction<Item[]>>;
  onRelease: () => void;
}) {
  const { gl } = useThree();

  useEffect(() => {
    const up: (ev: PointerEvent) => void = () => { onRelease(); };
    gl.domElement.addEventListener('pointerup', up);
    return () => gl.domElement.removeEventListener('pointerup', up);
  }, [gl, onRelease]);

  return (
    <>
      {/* 바닥 */}
      <mesh
        position={[0, WORLD.FLOOR_Y, 0]}
        rotation={[-Math.PI/2, 0, 0]}
        onPointerMove={(e)=>{
          if (dragRef.current.kind!=='floor' || !dragRef.current.id) return;
          const d = dragRef.current;
          const nx = quantize(clamp(e.point.x + d.offset.x, -ROOM.halfX, ROOM.halfX), steps.grid);
          const nz = quantize(clamp(e.point.z + d.offset.z, -ROOM.halfZ, ROOM.halfZ), steps.grid);
          const id = d.id;
          setItems((prev)=>prev.map((it)=>{
            if (it.id !== id) return it;
            const ny = STACKABLE_TYPES.includes(it.type) ? computeStackY(prev, it, nx, nz) : WORLD.FLOOR_Y;
            return { ...it, position:[nx, ny, nz] };
          }));
        }}
      >
        <planeGeometry args={[ROOM.halfX*2, ROOM.halfZ*2]} />
        <meshBasicMaterial transparent opacity={0} />
      </mesh>

      {/* 뒷벽(앞면) */}
      <mesh
        position={[0, ROOM.height/2, FRONT.BACK_Z]}
        onPointerMove={(e)=>{
          if (dragRef.current.kind!=='back' || !dragRef.current.id) return;
          const d = dragRef.current;
          const x = quantize(clamp(e.point.x + d.offset.x, -ROOM.halfX + 0.2, ROOM.halfX - 0.2), steps.grid);
          const y = quantize(clamp(e.point.y + d.offset.y, 0.2, ROOM.height - 0.6), steps.gridY);
          const id = d.id;
          setItems((prev)=>prev.map((it)=> it.id===id ? { ...it, position:[x, y, FRONT.BACK_Z], rotationY: 0 } : it));
        }}
      >
        <planeGeometry args={[ROOM.halfX*2, ROOM.height]} />
        <meshBasicMaterial transparent opacity={0} />
      </mesh>

      {/* 왼벽(앞면) */}
      <mesh
        position={[FRONT.LEFT_X, ROOM.height/2, 0]}
        rotation={[0, Math.PI/2, 0]}
        onPointerMove={(e)=>{
          if (dragRef.current.kind!=='left' || !dragRef.current.id) return;
          const d = dragRef.current;
          const z = quantize(clamp(e.point.z + d.offset.z, -ROOM.halfZ + 0.2, ROOM.halfZ - 0.2), steps.grid);
          const y = quantize(clamp(e.point.y + d.offset.y, 0.2, ROOM.height - 0.6), steps.gridY);
          const id = d.id;
          setItems((prev)=>prev.map((it)=> it.id===id ? { ...it, position:[FRONT.LEFT_X, y, z], rotationY: Math.PI/2 } : it));
        }}
      >
        <planeGeometry args={[ROOM.halfZ*2, ROOM.height]} />
        <meshBasicMaterial transparent opacity={0} />
      </mesh>
    </>
  );
}

/* ───────────────── UI ───────────────── */
function Pill({ children }: { children: ReactNode }) {
  return <div style={{ display:'inline-flex', alignItems:'center', gap:6, padding:'6px 8px', borderRadius:999, background:'#FFFFFFCC',
    border:`1px solid ${UI.btnBorder}`, boxShadow:'0 6px 16px rgba(0,0,0,0.06)' }}>{children}</div>;
}
function Label({ children }: { children: ReactNode }) {
  return <span style={{ fontSize:12, color:'#6B5E57', padding:'0 4px' }}>{children}</span>;
}
function Seg({ children, onClick, active }:{
  children: ReactNode; onClick?:()=>void; active?:boolean
}) {
  return <button onClick={onClick} style={{ padding:'6px 10px', borderRadius:8, border:`1px solid ${UI.btnBorder}`,
    background: active?'#3A332F':'#fff', color: active?'#fff':UI.btnText, cursor:'pointer', fontSize:13 }}>{children}</button>;
}
function Pad({ children }: { children: ReactNode }) {
  return <div style={{ background: UI.panel, border:`2px solid ${UI.btnBorder}`, borderRadius:12, padding:8,
    display:'inline-flex', flexDirection:'column', gap:6, boxShadow:'0 10px 24px rgba(0,0,0,0.12)' }}>{children}</div>;
}
function PadRow({ children }: { children: ReactNode }) {
  return <div style={{ display:'flex', gap:6, justifyContent:'center' }}>{children}</div>;
}
function PadBtn(props: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button {...props} style={{ width:44, height:44, borderRadius:10, border:`2px solid ${UI.btnBorder}`, background:'#fff',
    fontSize:18, color:UI.btnText, cursor:'pointer', userSelect:'none', touchAction:'none' }} />;
}
function HelpTip() {
  return (
    <div style={{
      position: 'fixed',
      bottom: 20, left: '50%', transform: 'translateX(-50%)',
      padding: '8px 12px', borderRadius: 10,
      background: 'rgba(31,41,55,0.85)', color: '#fff',
      fontSize: 12, fontFamily: 'ui-sans-serif, system-ui',
      whiteSpace: 'nowrap', pointerEvents: 'none', zIndex: 5,
      display: 'inline-block', width: 'auto', maxWidth: 'max-content',
      boxShadow: '0 8px 18px rgba(0,0,0,0.18)',
    }}>
      화면 이동(팬)은 빈 공간 드래그, 오브젝트 드래그 중엔 자동 비활성 · ⌨︎ 패드 버튼으로 미세 조정
    </div>
  );
}

/* ───────────────── Shelf / Theme ───────────────── */
function Shelf({ onAdd, themeIdx, setThemeIdx }:{
  onAdd:(t:ItemType)=>void; themeIdx:number; setThemeIdx:(n:number)=>void;
}) {
  return (
    <aside style={{ position:'absolute', right:12, top:12, bottom:12, width:260, background:UI.panel, border:`2px solid ${UI.btnBorder}`,
      borderRadius:12, padding:12, boxShadow:'0 12px 28px rgba(0,0,0,0.12)', zIndex:15, display:'flex', flexDirection:'column', gap:10, overflow:'hidden',
      fontFamily:'ui-sans-serif, system-ui', color:UI.panelText }}>
      <div style={{ fontWeight:700, letterSpacing:2, textAlign:'center', padding:'6px 0' }}>ITEMS</div>
      <div style={{ overflow:'auto', display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
        {(['bed','desk','dresser','chair','tv','rug','lamp','plant','window','frame','mirror','trash'] as ItemType[])
          .map((t)=><ItemBtn key={t} onClick={()=>onAdd(t)}>{t}</ItemBtn>)}
      </div>
      <div style={{ height:10 }} />
      <div style={{ fontWeight:700, letterSpacing:2, textAlign:'center', padding:'6px 0' }}>PALETTE</div>
      <div style={{ display:'flex', gap:8, justifyContent:'center', flexWrap:'wrap' }}>
        {THEMES.map((th,i)=>(<Swatch key={th.name} color={th.floor} active={i===themeIdx} onClick={()=>setThemeIdx(i)} />))}
      </div>
      <div style={{ flex:1 }} />
      <div style={{ fontSize:12, opacity:0.8, textAlign:'center', whiteSpace:'nowrap' }}>Drag + Buttons for fine control</div>
    </aside>
  );
}
function ItemBtn({ children, onClick }:{children: ReactNode; onClick: ()=>void;}) {
  return <button onClick={onClick} style={{ padding:'10px 8px', borderRadius:10, border:`2px solid ${UI.btnBorder}`, background:'#fff',
    color:UI.btnText, fontWeight:600, cursor:'pointer', textTransform:'capitalize' }}>{children}</button>;
}
function Swatch({ color, active, onClick }:{ color:string; active?:boolean; onClick:()=>void }) {
  return <button onClick={onClick} style={{ width:28, height:28, borderRadius:6, background:color,
    border:`2px solid ${active ? '#3A332F' : UI.btnBorder}`, boxShadow: active ? 'inset 0 0 0 2px #fff' : undefined }} />;
}

/* ───────────────── Inspector ───────────────── */
function Inspector({ item, onChange }:{ item: Item; onChange:(patch: Item['props'])=>void }) {
  const woodChip = (v:WoodTone, label:string) => (
    <Seg active={item.props?.wood===v} onClick={()=>onChange({ wood:v })}>{label}</Seg>
  );
  return (
    <div style={{
      position:'absolute', left:12, bottom:104, zIndex:16, background:'#FFFFFFEE', border:`1px solid ${UI.btnBorder}`,
      borderRadius:12, padding:10, display:'flex', flexDirection:'column', gap:8, fontFamily:'ui-sans-serif, system-ui', color:UI.panelText
    }}>
      <div style={{ fontWeight:700 }}>{item.type.toUpperCase()} · Properties</div>

      {item.type==='bed' && (
        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
          <Label>Sheet</Label>
          {['#C7D6E8','#F0DADA','#F6F0E3','#CFE7CF','#D7D0F5'].map((c)=>(
            <button key={c} onClick={()=>onChange({ bedSheet:c })}
              style={{ width:22, height:22, borderRadius:6, background:c, border:`2px solid ${UI.btnBorder}` }} />
          ))}
        </div>
      )}

      {item.type==='rug' && (
        <>
          <div style={{ display:'flex', alignItems:'center', gap:8 }}>
            <Label>Size</Label>
            {[
              {w:1.2,d:0.9, name:'S'},
              {w:1.6,d:1.2, name:'M'},
              {w:2.2,d:1.6, name:'L'},
            ].map(({w,d,name})=>(
              <Seg key={name} active={item.props?.rugW===w && item.props?.rugD===d}
                onClick={()=>onChange({ rugW:w, rugD:d })}>{name}</Seg>
            ))}
          </div>
          <div style={{ display:'flex', alignItems:'center', gap:8 }}>
            <Label>Color</Label>
            {['#C2A6A0','#AC8F7C','#BFA7D0','#95C3B3','#8EA8D0'].map((c)=>(
              <button key={c} onClick={()=>onChange({ rugColor:c })}
                style={{ width:22, height:22, borderRadius:6, background:c, border:`2px solid ${UI.btnBorder}` }} />
            ))}
          </div>
        </>
      )}

      {(item.type==='desk' || item.type==='dresser' || item.type==='chair') && (
        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
          <Label>Wood</Label>
          {woodChip('light','Light')}
          {woodChip('mid','Mid')}
          {woodChip('dark','Dark')}
        </div>
      )}

      {isWallType(item.type) && (
        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
          <Label>Wall</Label>
          <Seg active={(item.props?.wall ?? defaultWall[item.type])==='back'} onClick={()=>onChange({ wall:'back' })}>Back</Seg>
          <Seg active={(item.props?.wall ?? defaultWall[item.type])==='left'} onClick={()=>onChange({ wall:'left' })}>Left</Seg>
        </div>
      )}
    </div>
  );
}

/* ───────────────── Room ───────────────── */
function SceneRoom({ theme }: { theme: Theme }) {
  const floorC = useMemo(() => new THREE.Color(theme.floor), [theme.floor]);
  const wallC  = useMemo(() => new THREE.Color(theme.wall), [theme.wall]);

  const Floor = () => (
    <mesh position={[0, 0.001, 0]} rotation={[-Math.PI/2,0,0]} receiveShadow>
      <planeGeometry args={[ROOM.halfX*2, ROOM.halfZ*2]} />
      <meshStandardMaterial color={floorC} roughness={1} />
    </mesh>
  );

  return (
    <group>
      <Floor />
      <mesh position={[0, ROOM.height/2, WORLD.BACK_Z]} receiveShadow castShadow>
        <boxGeometry args={[ROOM.halfX*2, ROOM.height, WALL.thick]} />
        <meshStandardMaterial color={wallC} roughness={1} />
      </mesh>
      <mesh position={[WORLD.LEFT_X, ROOM.height/2, 0]} rotation={[0, Math.PI/2, 0]} receiveShadow castShadow>
        <boxGeometry args={[ROOM.halfZ*2, ROOM.height, WALL.thick]} />
        <meshStandardMaterial color={wallC} roughness={1} />
      </mesh>
    </group>
  );
}

/* ───────────────── Item Node ───────────────── */
function ItemNode({
  item, selected, hideLabel, onSelect, onStartDrag, onEndDrag,
}:{
  item: Item; selected: boolean; hideLabel: boolean;
  onSelect: () => void;
  onStartDrag: (it: Item, p: THREE.Vector3) => void;
  onEndDrag: () => void;
}) {
  const g = useRef<THREE.Group | null>(null);
  const targetPos   = useRef(new THREE.Vector3(...item.position));
  const targetRotY  = useRef(item.rotationY);
  const targetScale = useRef(item.scale);

  useEffect(()=>{ targetPos.current.set(...item.position); }, [item.position]);
  useEffect(()=>{ targetRotY.current = item.rotationY; }, [item.rotationY]);
  useEffect(()=>{ targetScale.current = item.scale; }, [item.scale]);

  useFrame((_s, dt) => {
    if (!g.current) return;
    const k = 9;
    g.current.position.x = THREE.MathUtils.damp(g.current.position.x, targetPos.current.x, k, dt);
    g.current.position.y = THREE.MathUtils.damp(g.current.position.y, targetPos.current.y, k, dt);
    g.current.position.z = THREE.MathUtils.damp(g.current.position.z, targetPos.current.z, k, dt);
    g.current.rotation.y = THREE.MathUtils.damp(g.current.rotation.y, targetRotY.current, k, dt);
    const s = THREE.MathUtils.damp(g.current.scale.x, targetScale.current, k, dt);
    g.current.scale.setScalar(s);
  });

  return (
    <group
      ref={g}
      onPointerDown={(e)=>{ e.stopPropagation(); onSelect(); onStartDrag(item, e.point.clone()); }}
      onPointerUp={(e)=>{ e.stopPropagation(); onEndDrag(); }}
    >
      <ItemMesh type={item.type} props={item.props} selected={selected} />
      {!hideLabel && selected && (
        <Html transform distanceFactor={8}>
          <div style={{ display:'inline-block', width:'auto', maxWidth:'max-content', padding:'6px 8px',
                        borderRadius:8, background: UI.badgeBG, color:'#fff', fontSize:11,
                        whiteSpace:'nowrap', userSelect:'none', pointerEvents:'none' }}>
            {item.type}
          </div>
        </Html>
      )}
    </group>
  );
}

/* ───────────────── Mesh Library ───────────────── */
function ItemMesh({ type, props, selected }:{
  type: ItemType; props?: Item['props']; selected?: boolean;
}) {
  switch (type) {
    case 'bed':     return <BedMesh sel={selected} sheet={props?.bedSheet ?? '#C7D6E8'} />;
    case 'desk':    return <DeskMesh sel={selected} tone={props?.wood ?? 'mid'} />;
    case 'dresser': return <DresserMesh sel={selected} tone={props?.wood ?? 'mid'} />;
    case 'chair':   return <ChairMesh sel={selected} tone={props?.wood ?? 'mid'} />;
    case 'tv':      return <TVMesh sel={selected} />;
    case 'rug':     return <RugMesh sel={selected} w={props?.rugW ?? 1.6} d={props?.rugD ?? 1.2} color={props?.rugColor ?? '#C2A6A0'} />;
    case 'lamp':    return <LampMesh sel={selected} />;
    case 'plant':   return <PlantMesh sel={selected} />;
    case 'window':  return <WindowMesh sel={selected} />;
    case 'frame':   return <FrameMesh sel={selected} />;
    case 'mirror':  return <MirrorMesh sel={selected} />;
    case 'trash':   return <TrashMesh sel={selected} />;
    default:        return null;
  }
}
function woodColor(tone:WoodTone) {
  if (tone==='light') return { base:'#E2D2BE', leg:'#C8B49A' };
  if (tone==='dark')  return { base:'#A7896B', leg:'#8D7357' };
  return { base:'#CDBAA7', leg:'#B49E87' }; // mid
}
function SelGlow({ active, r=0.45 }:{ active:boolean; r?:number }) {
  if (!active) return null;
  return (
    <mesh position={[0, 0.003, 0]} rotation={[-Math.PI/2, 0, 0]}>
      <ringGeometry args={[r, r+0.015, 48]} />
      <meshBasicMaterial color={'#3A332F'} transparent opacity={0.18} depthWrite={false} />
    </mesh>
  );
}

function BedMesh({ sel, sheet }:{ sel?:boolean; sheet:string }) {
  const wood = '#BFA88E';
  return (
    <group>
      <mesh castShadow receiveShadow position={[0, 0.25, 0]}><boxGeometry args={[1.8, 0.2, 1.2]} /><meshStandardMaterial color={wood} roughness={0.95} /></mesh>
      <mesh castShadow receiveShadow position={[0, 0.45, 0]}><boxGeometry args={[1.7, 0.2, 1.1]} /><meshStandardMaterial color={sheet} roughness={0.95} /></mesh>
      <mesh castShadow receiveShadow position={[0, 0.7, -0.55]}><boxGeometry args={[1.8, 0.5, 0.1]} /><meshStandardMaterial color={wood} roughness={0.95} /></mesh>
      <mesh castShadow receiveShadow position={[0, 0.55, -0.3]}><boxGeometry args={[0.6, 0.12, 0.35]} /><meshStandardMaterial color={'#FFFFFF'} roughness={1} /></mesh>
      <SelGlow active={!!sel} r={0.55} />
    </group>
  );
}
function DeskMesh({ sel, tone }:{ sel?:boolean; tone:WoodTone }) {
  const c = woodColor(tone);
  return (
    <group>
      <mesh castShadow receiveShadow position={[0, 0.62, 0]}><boxGeometry args={[1.3, 0.06, 0.6]} /><meshStandardMaterial color={c.base} roughness={0.98} /></mesh>
      {[
        [-0.58, 0.31, -0.26],[0.58, 0.31, -0.26],[-0.58, 0.31, 0.26],[0.58, 0.31, 0.26],
      ].map((p,i)=>(
        <mesh key={i} castShadow receiveShadow position={p as [number,number,number]}><boxGeometry args={[0.06, 0.62, 0.06]} /><meshStandardMaterial color={c.leg} roughness={1} /></mesh>
      ))}
      <SelGlow active={!!sel} />
    </group>
  );
}
function DresserMesh({ sel, tone }:{ sel?:boolean; tone:WoodTone }) {
  const c = woodColor(tone);
  return (
    <group position={[0, 0.45, 0]}>
      <mesh castShadow receiveShadow><boxGeometry args={[1.0, 0.9, 0.45]} /><meshStandardMaterial color={c.base} roughness={1} /></mesh>
      {[0.25,0,-0.25].map((y,i)=>(
        <mesh key={i} castShadow receiveShadow position={[0,y,0.23]}><boxGeometry args={[0.9, 0.02, 0.02]} /><meshStandardMaterial color={c.leg} roughness={1} /></mesh>
      ))}
      <SelGlow active={!!sel} />
    </group>
  );
}
function ChairMesh({ sel, tone }:{ sel?:boolean; tone:WoodTone }) {
  const c = woodColor(tone);
  return (
    <group>
      <mesh castShadow receiveShadow position={[0, 0.45, 0]}><boxGeometry args={[0.5, 0.05, 0.5]} /><meshStandardMaterial color={c.base} roughness={1} /></mesh>
      {[
        [-0.22, 0.225, -0.22], [0.22, 0.225, -0.22], [-0.22, 0.225,  0.22], [0.22, 0.225,  0.22],
      ].map((p,i)=>(
        <mesh key={i} castShadow receiveShadow position={p as [number,number,number]}><boxGeometry args={[0.05, 0.45, 0.05]} /><meshStandardMaterial color={c.leg} roughness={1} /></mesh>
      ))}
      <mesh castShadow receiveShadow position={[0, 0.75, -0.22]}><boxGeometry args={[0.5, 0.6, 0.05]} /><meshStandardMaterial color={c.base} roughness={1} /></mesh>
      <SelGlow active={!!sel} r={0.35} />
    </group>
  );
}
function TVMesh({ sel }:{ sel?:boolean }) {
  return (
    <group position={[0, 0.4, 0]}>
      <mesh castShadow receiveShadow><boxGeometry args={[0.8, 0.48, 0.04]} /><meshStandardMaterial color={'#111827'} metalness={0.35} roughness={0.45} /></mesh>
      <mesh castShadow receiveShadow position={[0, -0.28, 0]}><boxGeometry args={[0.5, 0.02, 0.25]} /><meshStandardMaterial color={'#2B3447'} roughness={0.85} /></mesh>
      <SelGlow active={!!sel} />
    </group>
  );
}
function RugMesh({ sel, w, d, color }:{ sel?:boolean; w:number; d:number; color:string }) {
  return (
    <group>
      <mesh receiveShadow position={[0, 0.02, 0]}><boxGeometry args={[w, 0.02, d]} /><meshStandardMaterial color={color} roughness={1} /></mesh>
      <SelGlow active={!!sel} r={Math.max(w,d)/2 - 0.3} />
    </group>
  );
}
function LampMesh({ sel }:{ sel?:boolean }) {
  return (
    <group position={[0, 0.5, 0]}>
      <mesh castShadow receiveShadow><cylinderGeometry args={[0.04,0.04,1.0,16]} /><meshStandardMaterial color={'#7E8AA3'} roughness={0.95} /></mesh>
      <mesh castShadow receiveShadow position={[0,0.6,0]}><coneGeometry args={[0.18,0.22,24]} /><meshStandardMaterial color={'#C9D2E6'} roughness={0.85} /></mesh>
      <pointLight position={[0,0.58,0]} distance={2.2} intensity={0.9} color={'#fff7d1'} />
      <SelGlow active={!!sel} />
    </group>
  );
}
function PlantMesh({ sel }:{ sel?:boolean }) {
  return (
    <group>
      <mesh castShadow receiveShadow position={[0, 0.12, 0]}><cylinderGeometry args={[0.12,0.14,0.18,24]} /><meshStandardMaterial color={'#D6C3A6'} roughness={0.95} /></mesh>
      <mesh castShadow receiveShadow position={[0, 0.27, 0]}><icosahedronGeometry args={[0.14,0]} /><meshStandardMaterial color={'#53B273'} roughness={0.7} /></mesh>
      <SelGlow active={!!sel} />
    </group>
  );
}
function WindowMesh({ sel }:{ sel?:boolean }) {
  return (
    <group>
      <mesh castShadow receiveShadow><boxGeometry args={[0.9,0.7,0.06]} /><meshStandardMaterial color={'#CBB9A4'} roughness={1} /></mesh>
      <mesh position={[0,0,0.04]}><planeGeometry args={[0.78,0.58]} /><meshStandardMaterial color={'#BFD8F5'} roughness={0.2} metalness={0.1} /></mesh>
      <SelGlow active={!!sel} r={0.48} />
    </group>
  );
}
function FrameMesh({ sel }:{ sel?:boolean }) {
  return (
    <group>
      <mesh castShadow receiveShadow><boxGeometry args={[0.6,0.8,0.05]} /><meshStandardMaterial color={'#CBB9A4'} roughness={1} /></mesh>
      <mesh position={[0,0,0.03]}><planeGeometry args={[0.5,0.7]} /><meshStandardMaterial color={'#E6A0A7'} roughness={1} /></mesh>
      <SelGlow active={!!sel} r={0.35} />
    </group>
  );
}
function MirrorMesh({ sel }:{ sel?:boolean }) {
  return (
    <group>
      <mesh castShadow receiveShadow><boxGeometry args={[0.5,0.9,0.05]} /><meshStandardMaterial color={'#9AA8C7'} roughness={0.6} /></mesh>
      <mesh position={[0,0,0.03]}><planeGeometry args={[0.42,0.8]} /><meshStandardMaterial color={'#E9F2FF'} roughness={0.05} metalness={0.2} /></mesh>
      <SelGlow active={!!sel} r={0.3} />
    </group>
  );
}
function TrashMesh({ sel }:{ sel?:boolean }) {
  return (
    <group position={[0,0.18,0]}>
      <mesh castShadow receiveShadow><cylinderGeometry args={[0.12,0.14,0.36,24]} /><meshStandardMaterial color={'#9AA3AF'} roughness={0.9} /></mesh>
      <SelGlow active={!!sel} />
    </group>
  );
}

/* ───────────────── Stack helpers ───────────────── */
function supportTopSpec(it: Item): { topOffsetY: number; hx: number; hz: number } | null {
  const s = it.scale ?? 1;
  switch (it.type) {
    case 'desk':    return { topOffsetY: s * (0.62 + 0.03), hx: s * (1.3/2), hz: s * (0.6/2) };
    case 'dresser': return { topOffsetY: s * (0.9),         hx: s * (1.0/2), hz: s * (0.45/2) };
    default:        return null;
  }
}
function stackeeBottomOffset(type: ItemType): number {
  switch (type) {
    case 'tv':    return 0.11;
    case 'plant': return 0.03;
    case 'lamp':  return 0;
    case 'trash': return 0;
    default:      return 0;
  }
}
function insideSupportTop(x: number, z: number, sup: Item, hx: number, hz: number): boolean {
  const dx = x - sup.position[0];
  const dz = z - sup.position[2];
  const c = Math.cos(-sup.rotationY), s = Math.sin(-sup.rotationY);
  const lx = c * dx - s * dz;
  const lz = s * dx + c * dz;
  return Math.abs(lx) <= hx && Math.abs(lz) <= hz;
}
function computeStackY(all: Item[], me: Item, x: number, z: number): number {
  if (!STACKABLE_TYPES.includes(me.type)) return WORLD.FLOOR_Y;
  const supports = all.filter(o => SUPPORT_TYPES.includes(o.type));
  let bestTop: number | null = null;
  for (const sup of supports) {
    const spec = supportTopSpec(sup);
    if (!spec) continue;
    const { topOffsetY, hx, hz } = spec;
    if (insideSupportTop(x, z, sup, hx, hz)) {
      const topY = sup.position[1] + topOffsetY;
      if (bestTop === null || topY > bestTop) bestTop = topY;
    }
  }
  if (bestTop === null) return WORLD.FLOOR_Y;
  const bottom = stackeeBottomOffset(me.type) * (me.scale ?? 1);
  return bestTop - bottom + 0.001;
}

/* ───────────────── Helpers for walls & slots ───────────────── */
function wallRotation(type: ItemType, side?: WallSide) {
  if (!isWallType(type)) return 0;
  return side === 'left' ? Math.PI / 2 : 0;
}
function initWallPos(side: WallSide): [number, number, number] {
  return side === 'left' ? [FRONT.LEFT_X, 1.2, 0] : [0, 1.2, FRONT.BACK_Z];
}
function snapToWall([x,y]:[number, number, number], side: WallSide): [number, number, number] {
  if (side === 'left') return [FRONT.LEFT_X, clamp(y, 0.2, ROOM.height - 0.6),  clamp(0, -ROOM.halfZ + 0.2, ROOM.halfZ - 0.2)];
  return [clamp(x, -ROOM.halfX + 0.2, ROOM.halfX - 0.2), clamp(y, 0.2, ROOM.height - 0.6), FRONT.BACK_Z];
}
function nextFloorSlot(existing: Item[], grid: number): [number, number, number] {
  const step = grid;
  const minX = Math.ceil(-ROOM.halfX/step), maxX = Math.floor(ROOM.halfX/step);
  const minZ = Math.ceil(-ROOM.halfZ/step), maxZ = Math.floor(ROOM.halfZ/step);
  const used = new Set(
    existing.filter((e)=>!isWallType(e.type)).map((it)=>`${quantize(it.position[0], step)},${quantize(it.position[2], step)}`)
  );
  for (let z=minZ; z<=maxZ; z++) for (let x=minX; x<=maxX; x++) {
    const px = x*step, pz = z*step;
    const key = `${px},${pz}`; if (!used.has(key)) return [px, WORLD.FLOOR_Y, pz];
  }
  return [0, WORLD.FLOOR_Y, 0];
}
