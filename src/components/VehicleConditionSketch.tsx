import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Eraser, MapPin, PenTool, RotateCcw, Trash2 } from 'lucide-react';
import type {
  ChecklistSignatureEntry,
  ChecklistSignatures,
  ChecklistSketchData,
  DamagePinType,
  SketchDamagePin,
  SketchStroke,
  SketchVehicleKind,
} from '../shared/types';

export const SKETCH_WIDTH = 800;
export const SKETCH_HEIGHT = 380;

export const PIN_TYPE_LABELS: Record<DamagePinType, string> = {
  S: 'Scratch',
  D: 'Dent',
  C: 'Chip / Crack',
  M: 'Missing Part',
  O: 'Other Mark',
};

export const SKETCH_KINDS: Array<{ id: SketchVehicleKind; label: string }> = [
  { id: 'sedan', label: 'Sedan' },
  { id: 'suv', label: 'SUV' },
  { id: 'doublecab', label: 'Double Cab' },
  { id: 'kombi', label: 'Kombi / Van' },
];

export function inferSketchKind(vehicleType?: string | null, makeModel?: string | null): SketchVehicleKind {
  const hay = `${vehicleType ?? ''} ${makeModel ?? ''}`.toLowerCase();
  if (/(kombi|bus|hiace|quantum|sprinter|van|minibus|mpv)/.test(hay)) return 'kombi';
  if (/(double|cab|pickup|hilux|ranger|amarok|triton|navara|d-max|dmax|bakkie|single cab)/.test(hay)) {
    return 'doublecab';
  }
  if (/(suv|4x4|fortuner|prado|cruiser|pajero|rav4|everest|trailblazer|x-trail|sportage)/.test(hay)) {
    return 'suv';
  }
  return 'sedan';
}

export function createEmptySketch(vehicleKind: SketchVehicleKind = 'sedan'): ChecklistSketchData {
  return {
    vehicle_kind: vehicleKind,
    strokes_out: [],
    pins_out: [],
    no_damage_out: false,
    strokes_in: [],
    pins_in: [],
    no_damage_in: false,
  };
}

function renderSilhouettePaths(kind: SketchVehicleKind) {
  // Top-down schematic centered horizontally in 800x380 viewBox (Front on Left, Rear on Right)
  // Body sits roughly x: 110..690, y: 78..302
  return (
    <g stroke="#334155" strokeWidth="2.5" fill="#f8fafc" strokeLinejoin="round" strokeLinecap="round">
      {/* Side mirrors */}
      <path d="M 272 78 L 282 54 L 302 58 L 296 78 Z" fill="#e2e8f0" />
      <path d="M 272 302 L 282 326 L 302 322 L 296 302 Z" fill="#e2e8f0" />

      {/* Main chassis outline */}
      {kind === 'kombi' ? (
        <rect x="115" y="76" width="570" height="228" rx="34" />
      ) : kind === 'doublecab' ? (
        <path d="M 115 110 Q 115 78 158 78 L 495 78 L 672 82 Q 690 84 690 108 L 690 272 Q 690 296 672 298 L 495 302 L 158 302 Q 115 302 115 270 Z" />
      ) : (
        <path d="M 115 116 Q 115 78 175 78 L 635 78 Q 688 78 688 122 L 688 258 Q 688 302 635 302 L 175 302 Q 115 302 115 264 Z" />
      )}

      {/* Wheel arches / tires */}
      <rect x="178" y="69" width="76" height="10" rx="4" fill="#64748b" stroke="none" />
      <rect x="178" y="301" width="76" height="10" rx="4" fill="#64748b" stroke="none" />
      <rect x="536" y="69" width="76" height="10" rx="4" fill="#64748b" stroke="none" />
      <rect x="536" y="301" width="76" height="10" rx="4" fill="#64748b" stroke="none" />

      {/* Hood / bonnet lines */}
      {kind === 'kombi' ? (
        <path d="M 185 88 L 185 292" stroke="#64748b" strokeWidth="1.75" fill="none" />
      ) : (
        <>
          <path d="M 155 112 L 245 104 L 245 276 L 155 268" stroke="#94a3b8" strokeWidth="1.5" fill="none" />
          {/* Front grille / headlamps */}
          <path d="M 122 104 L 136 100 L 136 124 L 122 124 Z" fill="#fef08a" stroke="#64748b" strokeWidth="1.2" />
          <path d="M 122 256 L 136 256 L 136 280 L 122 276 Z" fill="#fef08a" stroke="#64748b" strokeWidth="1.2" />
        </>
      )}

      {/* Windshield */}
      {kind === 'kombi' ? (
        <path d="M 162 94 L 222 106 L 222 274 L 162 286 Z" fill="#dbeafe" stroke="#475569" strokeWidth="1.8" />
      ) : (
        <path d="M 248 96 L 315 112 L 315 268 L 248 284 Z" fill="#dbeafe" stroke="#475569" strokeWidth="1.8" />
      )}

      {/* Roof & Cabin / Load bed */}
      {kind === 'sedan' && (
        <>
          <rect x="315" y="112" width="185" height="156" rx="10" fill="#f1f5f9" stroke="#64748b" strokeWidth="1.6" />
          <path d="M 500 112 L 568 98 L 568 282 L 500 268 Z" fill="#dbeafe" stroke="#475569" strokeWidth="1.8" />
          <path d="M 580 108 L 656 112 L 656 268 L 580 272" stroke="#94a3b8" strokeWidth="1.5" fill="none" />
        </>
      )}
      {kind === 'suv' && (
        <>
          <rect x="315" y="106" width="265" height="168" rx="10" fill="#f1f5f9" stroke="#64748b" strokeWidth="1.6" />
          <path d="M 580 106 L 638 96 L 638 284 L 580 274 Z" fill="#dbeafe" stroke="#475569" strokeWidth="1.8" />
          <line x1="340" y1="126" x2="555" y2="126" stroke="#94a3b8" strokeWidth="2" />
          <line x1="340" y1="254" x2="555" y2="254" stroke="#94a3b8" strokeWidth="2" />
        </>
      )}
      {kind === 'doublecab' && (
        <>
          <rect x="315" y="110" width="150" height="160" rx="8" fill="#f1f5f9" stroke="#64748b" strokeWidth="1.6" />
          <path d="M 465 110 L 490 96 L 490 284 L 465 270 Z" fill="#dbeafe" stroke="#475569" strokeWidth="1.8" />
          {/* Load bed */}
          <rect x="502" y="96" width="174" height="188" rx="6" fill="#e2e8f0" stroke="#475569" strokeWidth="1.8" />
          <line x1="522" y1="118" x2="660" y2="118" stroke="#94a3b8" strokeWidth="1.2" />
          <line x1="522" y1="154" x2="660" y2="154" stroke="#94a3b8" strokeWidth="1.2" />
          <line x1="522" y1="190" x2="660" y2="190" stroke="#94a3b8" strokeWidth="1.2" />
          <line x1="522" y1="226" x2="660" y2="226" stroke="#94a3b8" strokeWidth="1.2" />
          <line x1="522" y1="262" x2="660" y2="262" stroke="#94a3b8" strokeWidth="1.2" />
        </>
      )}
      {kind === 'kombi' && (
        <>
          <rect x="225" y="102" width="405" height="176" rx="12" fill="#f1f5f9" stroke="#64748b" strokeWidth="1.6" />
          <path d="M 630 102 L 664 94 L 664 286 L 630 278 Z" fill="#dbeafe" stroke="#475569" strokeWidth="1.8" />
          <line x1="360" y1="102" x2="360" y2="278" stroke="#cbd5e1" strokeWidth="1.2" />
          <line x1="495" y1="102" x2="495" y2="278" stroke="#cbd5e1" strokeWidth="1.2" />
        </>
      )}

      {/* Door seams */}
      <line x1="398" y1="80" x2="398" y2="108" stroke="#94a3b8" strokeWidth="1.4" />
      <line x1="398" y1="272" x2="398" y2="300" stroke="#94a3b8" strokeWidth="1.4" />
      {kind !== 'kombi' && (
        <>
          <line x1="315" y1="80" x2="315" y2="112" stroke="#94a3b8" strokeWidth="1.4" />
          <line x1="315" y1="268" x2="315" y2="300" stroke="#94a3b8" strokeWidth="1.4" />
        </>
      )}

      {/* Rear tail lamps */}
      <rect x="676" y="96" width="8" height="28" rx="3" fill="#ef4444" stroke="none" />
      <rect x="676" y="256" width="8" height="28" rx="3" fill="#ef4444" stroke="none" />
    </g>
  );
}

/**
 * Generates a composite PNG data URL matching the interactive Vehicle Condition Sketch.
 */
export async function exportSketchPngDataUrl(sketch: ChecklistSketchData): Promise<string | null> {
  if (typeof document === 'undefined') return null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = SKETCH_WIDTH;
    canvas.height = SKETCH_HEIGHT;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, SKETCH_WIDTH, SKETCH_HEIGHT);

    // Subtle grid border
    ctx.strokeStyle = '#cbd5e1';
    ctx.lineWidth = 2;
    ctx.strokeRect(4, 4, SKETCH_WIDTH - 8, SKETCH_HEIGHT - 8);

    // Orientation labels
    ctx.fillStyle = '#64748b';
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('LEFT / PASSENGER SIDE', SKETCH_WIDTH / 2, 26);
    ctx.fillText('RIGHT / DRIVER SIDE', SKETCH_WIDTH / 2, SKETCH_HEIGHT - 16);
    ctx.save();
    ctx.translate(28, SKETCH_HEIGHT / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText('FRONT', 0, 0);
    ctx.restore();
    ctx.save();
    ctx.translate(SKETCH_WIDTH - 24, SKETCH_HEIGHT / 2);
    ctx.rotate(Math.PI / 2);
    ctx.fillText('REAR', 0, 0);
    ctx.restore();

    // Draw basic body outline on canvas cleanly for offline/PDF embedding
    ctx.strokeStyle = '#334155';
    ctx.fillStyle = '#f8fafc';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.roundRect(115, 78, 575, 224, 30);
    ctx.fill();
    ctx.stroke();

    // Windshield & rear glass
    ctx.fillStyle = '#dbeafe';
    ctx.strokeStyle = '#475569';
    ctx.lineWidth = 1.6;
    if (sketch.vehicle_kind === 'kombi') {
      ctx.fillRect(165, 96, 55, 188);
      ctx.strokeRect(165, 96, 55, 188);
      ctx.fillRect(630, 96, 35, 188);
      ctx.strokeRect(630, 96, 35, 188);
    } else {
      ctx.fillRect(248, 102, 65, 176);
      ctx.strokeRect(248, 102, 65, 176);
      if (sketch.vehicle_kind === 'doublecab') {
        ctx.fillRect(465, 106, 26, 168);
        ctx.strokeRect(465, 106, 26, 168);
        ctx.fillStyle = '#e2e8f0';
        ctx.fillRect(502, 96, 174, 188);
        ctx.strokeRect(502, 96, 174, 188);
      } else {
        const rx = sketch.vehicle_kind === 'suv' ? 580 : 500;
        ctx.fillRect(rx, 102, 58, 176);
        ctx.strokeRect(rx, 102, 58, 176);
      }
    }

    const drawLayer = (strokes: SketchStroke[], pins: SketchDamagePin[], color: string) => {
      ctx.strokeStyle = color;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (const s of strokes) {
        if (s.points.length < 2) continue;
        ctx.lineWidth = s.width || 4;
        ctx.beginPath();
        ctx.moveTo(s.points[0].x, s.points[0].y);
        for (let i = 1; i < s.points.length; i += 1) {
          ctx.lineTo(s.points[i].x, s.points[i].y);
        }
        ctx.stroke();
      }
      for (const p of pins) {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 13, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 11px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`${p.type}${p.number}`, p.x, p.y + 0.5);
      }
    };

    drawLayer(sketch.strokes_out, sketch.pins_out, '#d92d20');
    drawLayer(sketch.strokes_in, sketch.pins_in, '#1d4ed8');

    return canvas.toDataURL('image/png');
  } catch {
    return null;
  }
}

interface VehicleConditionSketchProps {
  value: ChecklistSketchData;
  onChange?: (next: ChecklistSketchData) => void;
  activeLayer: 'out' | 'in';
  readOnly?: boolean;
  canChangeKind?: boolean;
}

export const VehicleConditionSketch: React.FC<VehicleConditionSketchProps> = ({
  value,
  onChange,
  activeLayer,
  readOnly = false,
  canChangeKind = false,
}) => {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [tool, setTool] = useState<'pin' | 'draw' | 'erase'>('pin');
  const [pinType, setPinType] = useState<DamagePinType>('S');
  const [activeStroke, setActiveStroke] = useState<SketchStroke | null>(null);
  const [selectedPinId, setSelectedPinId] = useState<string | null>(null);

  const strokesKey = activeLayer === 'out' ? 'strokes_out' : 'strokes_in';
  const pinsKey = activeLayer === 'out' ? 'pins_out' : 'pins_in';
  const noDamageKey = activeLayer === 'out' ? 'no_damage_out' : 'no_damage_in';

  const layerColor = activeLayer === 'out' ? '#d92d20' : '#1d4ed8';
  const activeStrokes = value[strokesKey];
  const activePins = value[pinsKey];
  const noDamageChecked = value[noDamageKey];

  const getSvgCoords = (e: React.PointerEvent<SVGSVGElement>): { x: number; y: number } => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const rect = svg.getBoundingClientRect();
    const x = Math.max(0, Math.min(SKETCH_WIDTH, ((e.clientX - rect.left) / rect.width) * SKETCH_WIDTH));
    const y = Math.max(0, Math.min(SKETCH_HEIGHT, ((e.clientY - rect.top) / rect.height) * SKETCH_HEIGHT));
    return { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 };
  };

  const handlePointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (readOnly || !onChange) return;
    const pt = getSvgCoords(e);

    if (tool === 'pin') {
      const nextNum =
        activePins.reduce((max, p) => Math.max(max, p.number), 0) + 1;
      const newPin: SketchDamagePin = {
        id: `pin_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        number: nextNum,
        x: pt.x,
        y: pt.y,
        type: pinType,
        note: '',
      };
      onChange({
        ...value,
        [pinsKey]: [...activePins, newPin],
        [noDamageKey]: false,
      });
      setSelectedPinId(newPin.id);
      return;
    }

    if (tool === 'draw') {
      e.currentTarget.setPointerCapture(e.pointerId);
      setActiveStroke({
        id: `str_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        points: [pt],
        width: 4,
      });
      return;
    }

    if (tool === 'erase') {
      // Check nearest pin within 22px
      const hitPin = activePins.find((p) => Math.hypot(p.x - pt.x, p.y - pt.y) <= 22);
      if (hitPin) {
        onChange({
          ...value,
          [pinsKey]: activePins.filter((p) => p.id !== hitPin.id),
        });
        return;
      }
      // Check nearest stroke point within 20px
      const hitStroke = activeStrokes.find((s) =>
        s.points.some((sp) => Math.hypot(sp.x - pt.x, sp.y - pt.y) <= 20)
      );
      if (hitStroke) {
        onChange({
          ...value,
          [strokesKey]: activeStrokes.filter((s) => s.id !== hitStroke.id),
        });
      }
    }
  };

  const handlePointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!activeStroke || readOnly) return;
    const pt = getSvgCoords(e);
    const last = activeStroke.points[activeStroke.points.length - 1];
    if (last && Math.hypot(last.x - pt.x, last.y - pt.y) < 3) return;
    setActiveStroke({
      ...activeStroke,
      points: [...activeStroke.points, pt],
    });
  };

  const handlePointerUp = () => {
    if (!activeStroke || readOnly || !onChange) return;
    if (activeStroke.points.length >= 2) {
      onChange({
        ...value,
        [strokesKey]: [...activeStrokes, activeStroke],
        [noDamageKey]: false,
      });
    }
    setActiveStroke(null);
  };

  const handleUndo = () => {
    if (readOnly || !onChange) return;
    if (activePins.length > 0 && (activeStrokes.length === 0 || activePins[activePins.length - 1].id > activeStrokes[activeStrokes.length - 1].id)) {
      onChange({ ...value, [pinsKey]: activePins.slice(0, -1) });
    } else if (activeStrokes.length > 0) {
      onChange({ ...value, [strokesKey]: activeStrokes.slice(0, -1) });
    }
  };

  const handleClearLayer = () => {
    if (readOnly || !onChange) return;
    onChange({
      ...value,
      [strokesKey]: [],
      [pinsKey]: [],
    });
  };

  const updatePinNote = (pinId: string, note: string) => {
    if (readOnly || !onChange) return;
    onChange({
      ...value,
      [pinsKey]: activePins.map((p) => (p.id === pinId ? { ...p, note } : p)),
    });
  };

  const removePin = (pinId: string) => {
    if (readOnly || !onChange) return;
    onChange({
      ...value,
      [pinsKey]: activePins.filter((p) => p.id !== pinId),
    });
  };

  const toPolylinePoints = (pts: { x: number; y: number }[]) =>
    pts.map((p) => `${p.x},${p.y}`).join(' ');

  return (
    <div className="space-y-3 rounded-2xl border border-blue-200 bg-white p-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="text-base font-bold text-blue-950">Vehicle Condition Sketch</h3>
          <p className="text-xs text-slate-600">
            OUT marks appear in <span className="font-semibold text-[#d92d20]">Red</span> · IN return marks appear in{' '}
            <span className="font-semibold text-[#1d4ed8]">Blue</span>. Tap the diagram to pin damage or draw freehand.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {canChangeKind && !readOnly && onChange ? (
            <select
              aria-label="Vehicle silhouette type"
              value={value.vehicle_kind}
              onChange={(e) =>
                onChange({ ...value, vehicle_kind: e.target.value as SketchVehicleKind })
              }
              className="cyan-glow-input min-h-[40px] rounded-lg border border-blue-200 bg-white px-3 text-xs font-semibold text-blue-950"
            >
              {SKETCH_KINDS.map((k) => (
                <option key={k.id} value={k.id}>
                  Diagram: {k.label}
                </option>
              ))}
            </select>
          ) : (
            <span className="rounded-lg border border-blue-200 bg-blue-50/70 px-3 py-1.5 text-xs font-semibold text-blue-900">
              Diagram: {SKETCH_KINDS.find((k) => k.id === value.vehicle_kind)?.label ?? value.vehicle_kind}
            </span>
          )}
        </div>
      </div>

      {!readOnly && onChange && (
        <div className="flex flex-wrap items-center gap-2 border-y border-blue-100 py-2.5">
          <button
            type="button"
            onClick={() => setTool('pin')}
            className={`inline-flex min-h-[38px] items-center gap-1.5 rounded-lg border px-3 text-xs font-semibold ${
              tool === 'pin'
                ? 'cyan-glow-active'
                : 'border-blue-200 bg-white text-blue-900 hover:bg-blue-50'
            }`}
          >
            <MapPin className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Pin Mark</span>
          </button>
          <button
            type="button"
            onClick={() => setTool('draw')}
            className={`inline-flex min-h-[38px] items-center gap-1.5 rounded-lg border px-3 text-xs font-semibold ${
              tool === 'draw'
                ? 'cyan-glow-active'
                : 'border-blue-200 bg-white text-blue-900 hover:bg-blue-50'
            }`}
          >
            <PenTool className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Draw</span>
          </button>
          <button
            type="button"
            onClick={() => setTool('erase')}
            className={`inline-flex min-h-[38px] items-center gap-1.5 rounded-lg border px-3 text-xs font-semibold ${
              tool === 'erase'
                ? 'cyan-glow-active'
                : 'border-blue-200 bg-white text-blue-900 hover:bg-blue-50'
            }`}
          >
            <Eraser className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Erase</span>
          </button>

          {tool === 'pin' && (
            <div className="flex flex-wrap items-center gap-1 pl-1 border-l border-blue-200">
              {(['S', 'D', 'C', 'M', 'O'] as DamagePinType[]).map((pt) => (
                <button
                  key={pt}
                  type="button"
                  onClick={() => setPinType(pt)}
                  title={PIN_TYPE_LABELS[pt]}
                  className={`min-h-[34px] rounded-md border px-2 text-xs font-mono font-bold ${
                    pinType === pt
                      ? activeLayer === 'out'
                        ? 'border-red-600 bg-red-600 text-white'
                        : 'border-blue-700 bg-blue-700 text-white'
                      : 'border-slate-300 bg-slate-50 text-slate-700 hover:bg-slate-100'
                  }`}
                >
                  {pt} ({PIN_TYPE_LABELS[pt].split(' ')[0]})
                </button>
              ))}
            </div>
          )}

          <div className="ml-auto flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleUndo}
              disabled={activePins.length === 0 && activeStrokes.length === 0}
              className="inline-flex min-h-[36px] items-center gap-1 rounded-lg border border-blue-200 bg-white px-2.5 text-xs font-semibold text-blue-900 disabled:opacity-40"
            >
              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Undo</span>
            </button>
            <button
              type="button"
              onClick={handleClearLayer}
              disabled={activePins.length === 0 && activeStrokes.length === 0}
              className="inline-flex min-h-[36px] items-center gap-1 rounded-lg border border-red-200 bg-red-50 px-2.5 text-xs font-semibold text-red-800 disabled:opacity-40"
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Clear {activeLayer.toUpperCase()}</span>
            </button>
          </div>
        </div>
      )}

      {/* Diagram Canvas */}
      <div className="relative overflow-hidden rounded-xl border border-slate-200 bg-slate-50/40 touch-none">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${SKETCH_WIDTH} ${SKETCH_HEIGHT}`}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          className={`w-full h-auto select-none ${
            readOnly ? 'cursor-default' : tool === 'erase' ? 'cursor-crosshair' : 'cursor-crosshair'
          }`}
          role="img"
          aria-label={`Vehicle condition diagram (${value.vehicle_kind})`}
        >
          {/* Orientation Labels */}
          <text x={SKETCH_WIDTH / 2} y="24" textAnchor="middle" className="fill-slate-500 text-[12px] font-bold tracking-wider">
            LEFT / PASSENGER SIDE
          </text>
          <text x={SKETCH_WIDTH / 2} y={SKETCH_HEIGHT - 12} textAnchor="middle" className="fill-slate-500 text-[12px] font-bold tracking-wider">
            RIGHT / DRIVER SIDE
          </text>
          <text
            x="24"
            y={SKETCH_HEIGHT / 2}
            textAnchor="middle"
            transform={`rotate(-90 24 ${SKETCH_HEIGHT / 2})`}
            className="fill-slate-500 text-[12px] font-bold tracking-wider"
          >
            FRONT
          </text>
          <text
            x={SKETCH_WIDTH - 24}
            y={SKETCH_HEIGHT / 2}
            textAnchor="middle"
            transform={`rotate(90 ${SKETCH_WIDTH - 24} ${SKETCH_HEIGHT / 2})`}
            className="fill-slate-500 text-[12px] font-bold tracking-wider"
          >
            REAR
          </text>

          {renderSilhouettePaths(value.vehicle_kind)}

          {/* OUT Layer (#d92d20) */}
          {value.strokes_out.map((s) => (
            <polyline
              key={s.id}
              fill="none"
              stroke="#d92d20"
              strokeWidth={s.width || 4}
              strokeLinecap="round"
              strokeLinejoin="round"
              points={toPolylinePoints(s.points)}
            />
          ))}
          {value.pins_out.map((p) => (
            <g
              key={p.id}
              onClick={(e) => {
                if (tool === 'erase' && activeLayer === 'out' && !readOnly) {
                  e.stopPropagation();
                  removePin(p.id);
                } else {
                  setSelectedPinId(p.id);
                }
              }}
              className="cursor-pointer"
            >
              <circle cx={p.x} cy={p.y} r="13" fill="#d92d20" stroke="#ffffff" strokeWidth="2.5" />
              <text
                x={p.x}
                y={p.y + 4}
                textAnchor="middle"
                className="fill-white font-mono text-[11px] font-bold pointer-events-none"
              >
                {p.type}{p.number}
              </text>
            </g>
          ))}

          {/* IN Layer (#1d4ed8) */}
          {value.strokes_in.map((s) => (
            <polyline
              key={s.id}
              fill="none"
              stroke="#1d4ed8"
              strokeWidth={s.width || 4}
              strokeLinecap="round"
              strokeLinejoin="round"
              points={toPolylinePoints(s.points)}
            />
          ))}
          {value.pins_in.map((p) => (
            <g
              key={p.id}
              onClick={(e) => {
                if (tool === 'erase' && activeLayer === 'in' && !readOnly) {
                  e.stopPropagation();
                  removePin(p.id);
                } else {
                  setSelectedPinId(p.id);
                }
              }}
              className="cursor-pointer"
            >
              <circle cx={p.x} cy={p.y} r="13" fill="#1d4ed8" stroke="#ffffff" strokeWidth="2.5" />
              <text
                x={p.x}
                y={p.y + 4}
                textAnchor="middle"
                className="fill-white font-mono text-[11px] font-bold pointer-events-none"
              >
                {p.type}{p.number}
              </text>
            </g>
          ))}

          {/* Active Stroke Preview */}
          {activeStroke && (
            <polyline
              fill="none"
              stroke={layerColor}
              strokeWidth={activeStroke.width}
              strokeLinecap="round"
              strokeLinejoin="round"
              points={toPolylinePoints(activeStroke.points)}
            />
          )}
        </svg>
      </div>

      {/* No Damage Found Toggle + Pin Notes */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        {!readOnly && onChange ? (
          <label className="inline-flex min-h-[40px] cursor-pointer items-center gap-2 rounded-xl border border-blue-200 bg-blue-50/40 px-3.5 py-1.5 text-sm font-semibold text-blue-950">
            <input
              type="checkbox"
              checked={noDamageChecked}
              onChange={(e) =>
                onChange({
                  ...value,
                  [noDamageKey]: e.target.checked,
                  ...(e.target.checked ? { [strokesKey]: [], [pinsKey]: [] } : {}),
                })
              }
              className="h-4 w-4 rounded border-blue-300 text-cyan-600 accent-cyan-600"
            />
            <span>No damage found ({activeLayer.toUpperCase()})</span>
          </label>
        ) : (
          <div className="flex flex-wrap items-center gap-2 text-xs font-semibold">
            {value.no_damage_out && (
              <span className="inline-flex items-center gap-1 rounded-lg bg-emerald-50 border border-emerald-200 px-2.5 py-1 text-emerald-800">
                <Check className="h-3.5 w-3.5" aria-hidden="true" />
                OUT: No damage found
              </span>
            )}
            {value.no_damage_in && (
              <span className="inline-flex items-center gap-1 rounded-lg bg-blue-50 border border-blue-200 px-2.5 py-1 text-blue-800">
                <Check className="h-3.5 w-3.5" aria-hidden="true" />
                IN: No damage found
              </span>
            )}
          </div>
        )}

        <div className="text-xs text-slate-500">
          OUT: {value.pins_out.length} pin{value.pins_out.length === 1 ? '' : 's'}, {value.strokes_out.length} mark{value.strokes_out.length === 1 ? '' : 's'}
          {' · '}
          IN: {value.pins_in.length} pin{value.pins_in.length === 1 ? '' : 's'}, {value.strokes_in.length} mark{value.strokes_in.length === 1 ? '' : 's'}
        </div>
      </div>

      {/* Pin Legend & Notes */}
      {(value.pins_out.length > 0 || value.pins_in.length > 0) && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 border-t border-blue-100 pt-3">
          {[
            ...value.pins_out.map((p) => ({ ...p, layer: 'out' as const })),
            ...value.pins_in.map((p) => ({ ...p, layer: 'in' as const })),
          ].map((pin) => {
            const editable = !readOnly && pin.layer === activeLayer;
            return (
              <div
                key={pin.id}
                className={`flex items-center gap-2 rounded-xl border p-2 text-xs ${
                  selectedPinId === pin.id
                    ? 'border-cyan-400 bg-cyan-50/50'
                    : 'border-slate-200 bg-slate-50/60'
                }`}
              >
                <span
                  className={`inline-flex h-6 min-w-[28px] items-center justify-center rounded-full px-1.5 font-mono text-[11px] font-bold text-white ${
                    pin.layer === 'out' ? 'bg-[#d92d20]' : 'bg-[#1d4ed8]'
                  }`}
                >
                  {pin.type}{pin.number}
                </span>
                <span className="font-semibold text-blue-950 shrink-0">
                  {pin.layer.toUpperCase()} · {PIN_TYPE_LABELS[pin.type]}
                </span>
                {editable ? (
                  <>
                    <input
                      type="text"
                      value={pin.note ?? ''}
                      onChange={(e) => updatePinNote(pin.id, e.target.value)}
                      placeholder="Short note (optional)..."
                      className="min-w-0 flex-1 rounded-lg border border-blue-200 bg-white px-2 py-1 text-xs text-blue-950"
                    />
                    <button
                      type="button"
                      onClick={() => removePin(pin.id)}
                      aria-label={`Remove ${pin.type}${pin.number}`}
                      className="text-red-600 hover:text-red-800 p-1"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </>
                ) : (
                  <span className="text-slate-600 truncate">{pin.note || '—'}</span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

interface SignaturePadFieldProps {
  title: string;
  subtitle?: string;
  value: ChecklistSignatureEntry | null;
  onChange?: (next: ChecklistSignatureEntry) => void;
  locked?: boolean;
  lockMessage?: string;
  required?: boolean;
}

export const SignaturePadField: React.FC<SignaturePadFieldProps> = ({
  title,
  subtitle,
  value,
  onChange,
  locked = false,
  lockMessage,
  required = false,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawingRef = useRef(false);
  const [name, setName] = useState(value?.name ?? '');
  const [idNumber, setIdNumber] = useState(value?.id_number ?? '');
  const [sigDataUrl, setSigDataUrl] = useState(value?.signature_data_url ?? '');

  useEffect(() => {
    setName(value?.name ?? '');
    setIdNumber(value?.id_number ?? '');
    setSigDataUrl(value?.signature_data_url ?? '');
  }, [value?.name, value?.id_number, value?.signature_data_url]);

  const emitChange = useCallback(
    (nextName: string, nextId: string, nextSig: string) => {
      onChange?.({
        name: nextName,
        id_number: nextId,
        signature_data_url: nextSig,
        signed_at: nextSig ? value?.signed_at ?? new Date().toISOString() : undefined,
      });
    },
    [onChange, value?.signed_at]
  );

  const getPoint = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * canvas.width,
      y: ((e.clientY - rect.top) / rect.height) * canvas.height,
    };
  };

  const handleDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (locked) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    canvas.setPointerCapture(e.pointerId);
    drawingRef.current = true;
    const pt = getPoint(e);
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 2.4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(pt.x, pt.y);
  };

  const handleMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current || locked) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const pt = getPoint(e);
    ctx.lineTo(pt.x, pt.y);
    ctx.stroke();
  };

  const handleUp = () => {
    if (!drawingRef.current || locked) return;
    drawingRef.current = false;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const url = canvas.toDataURL('image/png');
    setSigDataUrl(url);
    emitChange(name, idNumber, url);
  };

  const clearPad = () => {
    if (locked) return;
    const canvas = canvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext('2d');
      ctx?.clearRect(0, 0, canvas.width, canvas.height);
    }
    setSigDataUrl('');
    emitChange(name, idNumber, '');
  };

  return (
    <div
      className={`rounded-xl border p-3.5 space-y-2.5 ${
        locked ? 'border-slate-200 bg-slate-50/70' : 'border-blue-200 bg-white'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-sm font-bold text-blue-950">
            {title} {required && !locked ? '*' : ''}
          </div>
          {subtitle && <div className="text-xs text-slate-500">{subtitle}</div>}
        </div>
        {!locked && sigDataUrl && (
          <button
            type="button"
            onClick={clearPad}
            className="text-xs font-semibold text-red-700 hover:underline"
          >
            Clear
          </button>
        )}
      </div>

      {locked ? (
        <div className="space-y-2">
          {value?.signature_data_url ? (
            <div className="rounded-lg border border-slate-200 bg-white p-2 flex items-center justify-center min-h-[96px]">
              <img
                src={value.signature_data_url}
                alt={`${title} signature`}
                className="max-h-[88px] object-contain"
              />
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-slate-300 bg-white/60 p-4 text-center text-xs text-slate-500">
              {lockMessage || 'Locked until vehicle return'}
            </div>
          )}
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div>
              <span className="text-slate-500 block">Name</span>
              <span className="font-semibold text-blue-950">{value?.name || '—'}</span>
            </div>
            <div>
              <span className="text-slate-500 block">ID / Licence No.</span>
              <span className="font-mono font-semibold text-blue-950">{value?.id_number || '—'}</span>
            </div>
          </div>
        </div>
      ) : (
        <>
          <div className="relative rounded-lg border border-blue-200 bg-blue-50/20 touch-none overflow-hidden">
            {!sigDataUrl && (
              <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-slate-400">
                Sign here (finger, mouse, or stylus)
              </span>
            )}
            <canvas
              ref={canvasRef}
              width={440}
              height={120}
              onPointerDown={handleDown}
              onPointerMove={handleMove}
              onPointerUp={handleUp}
              onPointerCancel={handleUp}
              className="w-full h-[108px] cursor-crosshair block"
            />
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div>
              <label className="block text-[11px] font-semibold text-slate-600">
                Full Name {required ? '*' : ''}
              </label>
              <input
                type="text"
                required={required}
                value={name}
                onChange={(e) => {
                  const v = e.target.value;
                  setName(v);
                  emitChange(v, idNumber, sigDataUrl);
                }}
                placeholder="Print full name"
                className="cyan-glow-input mt-1 block w-full min-h-[40px] rounded-lg border border-blue-200 px-2.5 text-sm text-blue-950"
              />
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-slate-600">
                ID / Licence No. {required ? '*' : ''}
              </label>
              <input
                type="text"
                required={required}
                value={idNumber}
                onChange={(e) => {
                  const v = e.target.value;
                  setIdNumber(v);
                  emitChange(name, v, sigDataUrl);
                }}
                placeholder="e.g. 63-123456A77"
                className="cyan-glow-input mt-1 block w-full min-h-[40px] rounded-lg border border-blue-200 px-2.5 font-mono text-sm text-blue-950"
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
};

interface ChecklistSectionGProps {
  declarationText: string;
  signatures: ChecklistSignatures;
  mode: 'create' | 'return' | 'view';
  onChangeOutRenter?: (entry: ChecklistSignatureEntry) => void;
  onChangeOutCompany?: (entry: ChecklistSignatureEntry) => void;
  onChangeInRenter?: (entry: ChecklistSignatureEntry) => void;
  onChangeInCompany?: (entry: ChecklistSignatureEntry) => void;
}

export const ChecklistSectionG: React.FC<ChecklistSectionGProps> = ({
  declarationText,
  signatures,
  mode,
  onChangeOutRenter,
  onChangeOutCompany,
  onChangeInRenter,
  onChangeInCompany,
}) => {
  return (
    <div className="space-y-4 rounded-2xl border border-blue-200 bg-white p-4 sm:p-5">
      <div>
        <h3 className="text-base font-bold text-blue-950">Section G — Declaration &amp; Sign-Off</h3>
        <p className="mt-1.5 rounded-xl border border-blue-100 bg-blue-50/40 p-3 text-xs leading-relaxed text-slate-700">
          {declarationText}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <SignaturePadField
          title="1. Checked Out By (Renter / Driver)"
          subtitle="Vehicle condition accepted on departure"
          value={signatures.outRenter}
          onChange={onChangeOutRenter}
          locked={mode !== 'create'}
          required={mode === 'create'}
        />
        <SignaturePadField
          title="2. Checked Out By (Company Representative)"
          subtitle="Yard / Security dispatch verification"
          value={signatures.outCompany}
          onChange={onChangeOutCompany}
          locked={mode !== 'create'}
          required={mode === 'create'}
        />
        <SignaturePadField
          title="3. Checked In By (Renter / Driver)"
          subtitle="Vehicle condition accepted on return"
          value={signatures.inRenter}
          onChange={onChangeInRenter}
          locked={mode !== 'return'}
          lockMessage={mode === 'create' ? 'Signed upon vehicle return' : 'Not yet returned'}
          required={mode === 'return'}
        />
        <SignaturePadField
          title="4. Checked In By (Company Representative)"
          subtitle="Yard / Security check-in sign-off"
          value={signatures.inCompany}
          onChange={onChangeInCompany}
          locked={mode !== 'return'}
          lockMessage={mode === 'create' ? 'Signed upon vehicle return' : 'Not yet returned'}
          required={mode === 'return'}
        />
      </div>
    </div>
  );
};
