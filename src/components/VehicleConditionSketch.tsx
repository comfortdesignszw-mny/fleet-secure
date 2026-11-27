import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Eraser, MapPin, PenTool, RotateCcw, Trash2 } from 'lucide-react';
import {
  getCachedSketchImageSync,
  resolveCachedSketchImageSrc,
  warmVehicleSketchImages,
} from '../lib/offlineCache';
import {
  SKETCH_3D_MEDIA_BY_KIND,
  type ChecklistHirerType,
  type ChecklistSignatureEntry,
  type ChecklistSignatures,
  type ChecklistSketchData,
  type DamagePinType,
  type SketchDamagePin,
  type SketchPanelView,
  type SketchStroke,
  type SketchVehicleKind,
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

export const VIEW_PANEL_LABELS: Record<SketchPanelView, string> = {
  left: 'Left Side (3D)',
  right: 'Right Side (3D)',
  top: 'Top 2D',
};

export const SKETCH_KINDS: Array<{ id: SketchVehicleKind; label: string }> = [
  { id: 'sedan', label: 'Sedan' },
  { id: 'suv', label: 'SUV' },
  { id: 'doublecab', label: 'Double Cab' },
  { id: 'singlecab', label: 'Single Cab' },
  { id: 'kombi', label: 'Kombi / Van' },
  { id: 'hatchback', label: 'Hatchback' },
];

export function matchSketchKindFromText(text?: string | null): SketchVehicleKind | null {
  const hay = (text ?? '').toLowerCase().trim();
  if (!hay) return null;
  if (/(single\s*cab|singlecab|chassis\s*cab)/.test(hay)) {
    return 'singlecab';
  }
  if (
    /(double\s*cab|doublecab|pickup|bakkie|hilux|ranger|amarok|triton|navara|d-?max|bt-?50|np\s?300|truck)/.test(
      hay
    )
  ) {
    return 'doublecab';
  }
  if (/(kombi|quantum|hiace|minibus|sprinter|\bvan\b|mpv|urvan|caravan|nv350|coaster|\bbus\b)/.test(hay)) {
    return 'kombi';
  }
  if (
    /(mini\s*suv|\bsuv\b|4x4|fortuner|prado|cruiser|pajero|rav4|everest|trailblazer|x-?trail|sportage|cr-?v|cx-?5|harrier|tucson|tiguan|forester|outlander|qashqai|vanguard)/.test(
      hay
    )
  ) {
    return 'suv';
  }
  if (
    /(hatchback|hatch|\bfit\b|\bvitz\b|\bdemio\b|\bpolo\b|\bgolf\b|\bswift\b|\byaris\b|\bi20\b|\bi10\b|\bmarch\b|\brunx\b)/.test(
      hay
    )
  ) {
    return 'hatchback';
  }
  if (
    /(sedan|executive\s*sedan|corolla|camry|civic|accord|belta|axio|allion|premio)/.test(
      hay
    )
  ) {
    return 'sedan';
  }
  return null;
}

export function inferSketchKind(vehicleType?: string | null, makeModel?: string | null): SketchVehicleKind {
  return matchSketchKindFromText(vehicleType) ?? matchSketchKindFromText(makeModel) ?? 'sedan';
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
      ) : kind === 'doublecab' || kind === 'singlecab' ? (
        <path d="M 115 110 Q 115 78 158 78 L 495 78 L 672 82 Q 690 84 690 108 L 690 272 Q 690 296 672 298 L 495 302 L 158 302 Q 115 302 115 270 Z" />
      ) : kind === 'hatchback' ? (
        <path d="M 122 116 Q 122 78 180 78 L 598 78 Q 644 78 644 122 L 644 258 Q 644 302 598 302 L 180 302 Q 122 302 122 264 Z" />
      ) : (
        <path d="M 115 116 Q 115 78 175 78 L 635 78 Q 688 78 688 122 L 688 258 Q 688 302 635 302 L 175 302 Q 115 302 115 264 Z" />
      )}

      {/* Wheel arches / tires */}
      <rect x="178" y="69" width="76" height="10" rx="4" fill="#64748b" stroke="none" />
      <rect x="178" y="301" width="76" height="10" rx="4" fill="#64748b" stroke="none" />
      <rect x={kind === 'hatchback' ? 506 : 536} y="69" width="76" height="10" rx="4" fill="#64748b" stroke="none" />
      <rect x={kind === 'hatchback' ? 506 : 536} y="301" width="76" height="10" rx="4" fill="#64748b" stroke="none" />

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
      {kind === 'hatchback' && (
        <>
          <rect x="315" y="110" width="222" height="160" rx="10" fill="#f1f5f9" stroke="#64748b" strokeWidth="1.6" />
          <path d="M 537 110 L 598 96 L 598 284 L 537 270 Z" fill="#dbeafe" stroke="#475569" strokeWidth="1.8" />
          <line x1="612" y1="98" x2="612" y2="282" stroke="#64748b" strokeWidth="2.2" />
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
      {kind === 'singlecab' && (
        <>
          <rect x="315" y="110" width="90" height="160" rx="8" fill="#f1f5f9" stroke="#64748b" strokeWidth="1.6" />
          <path d="M 405 110 L 424 98 L 424 282 L 405 270 Z" fill="#dbeafe" stroke="#475569" strokeWidth="1.8" />
          {/* Long single-cab load bed */}
          <rect x="436" y="96" width="240" height="188" rx="6" fill="#e2e8f0" stroke="#475569" strokeWidth="1.8" />
          <line x1="454" y1="118" x2="660" y2="118" stroke="#94a3b8" strokeWidth="1.2" />
          <line x1="454" y1="154" x2="660" y2="154" stroke="#94a3b8" strokeWidth="1.2" />
          <line x1="454" y1="190" x2="660" y2="190" stroke="#94a3b8" strokeWidth="1.2" />
          <line x1="454" y1="226" x2="660" y2="226" stroke="#94a3b8" strokeWidth="1.2" />
          <line x1="454" y1="262" x2="660" y2="262" stroke="#94a3b8" strokeWidth="1.2" />
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
      {kind !== 'singlecab' && (
        <>
          <line x1="398" y1="80" x2="398" y2="108" stroke="#94a3b8" strokeWidth="1.4" />
          <line x1="398" y1="272" x2="398" y2="300" stroke="#94a3b8" strokeWidth="1.4" />
        </>
      )}
      {kind !== 'kombi' && (
        <>
          <line x1="315" y1="80" x2="315" y2="112" stroke="#94a3b8" strokeWidth="1.4" />
          <line x1="315" y1="268" x2="315" y2="300" stroke="#94a3b8" strokeWidth="1.4" />
        </>
      )}

      {/* Rear tail lamps */}
      <rect x={kind === 'hatchback' ? 632 : 676} y="96" width="8" height="28" rx="3" fill="#ef4444" stroke="none" />
      <rect x={kind === 'hatchback' ? 632 : 676} y="256" width="8" height="28" rx="3" fill="#ef4444" stroke="none" />
    </g>
  );
}

async function loadImageElement(src: string): Promise<HTMLImageElement | null> {
  const resolvedSrc = await resolveCachedSketchImageSrc(src);
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = resolvedSrc;
  });
}

/**
 * Generates a composite PNG data URL across all 3 views (Left 3D, Right 3D, and Top 2D).
 */
export async function exportSketchPngDataUrl(sketch: ChecklistSketchData): Promise<string | null> {
  if (typeof document === 'undefined') return null;
  try {
    const panelW = 380;
    const panelH = 210;
    const gap = 14;
    const totalW = panelW * 3 + gap * 4;
    const totalH = panelH + 40;

    const canvas = document.createElement('canvas');
    canvas.width = totalW;
    canvas.height = totalH;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, totalW, totalH);

    const media = SKETCH_3D_MEDIA_BY_KIND[sketch.vehicle_kind] ?? SKETCH_3D_MEDIA_BY_KIND.sedan;
    const [leftImg, rightImg] = await Promise.all([
      loadImageElement(media.left),
      loadImageElement(media.right),
    ]);

    const kindLabel =
      SKETCH_KINDS.find((k) => k.id === sketch.vehicle_kind)?.label.toUpperCase() ??
      sketch.vehicle_kind.toUpperCase();

    const panels: Array<{ view: SketchPanelView; title: string; x: number }> = [
      { view: 'left', title: `LEFT SIDE (3D · ${kindLabel})`, x: gap },
      { view: 'right', title: `RIGHT SIDE (3D · ${kindLabel})`, x: gap * 2 + panelW },
      { view: 'top', title: `TOP VIEW (2D · ${kindLabel})`, x: gap * 3 + panelW * 2 },
    ];

    for (const panel of panels) {
      const y = 26;
      ctx.fillStyle = '#1e3a8a';
      ctx.font = 'bold 12px sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(panel.title, panel.x, 18);

      ctx.strokeStyle = '#cbd5e1';
      ctx.lineWidth = 1.5;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(panel.x, y, panelW, panelH);
      ctx.strokeRect(panel.x, y, panelW, panelH);

      if (panel.view === 'left' && leftImg) {
        ctx.drawImage(leftImg, panel.x + 2, y + 2, panelW - 4, panelH - 4);
      } else if (panel.view === 'right' && rightImg) {
        if (media.flipRight) {
          ctx.save();
          ctx.translate(panel.x + panelW - 2, y + 2);
          ctx.scale(-1, 1);
          ctx.drawImage(rightImg, 0, 0, panelW - 4, panelH - 4);
          ctx.restore();
        } else {
          ctx.drawImage(rightImg, panel.x + 2, y + 2, panelW - 4, panelH - 4);
        }
      } else {
        // Draw compact 2D top-down schematic inside panel 3
        const sx = panelW / SKETCH_WIDTH;
        const sy = panelH / SKETCH_HEIGHT;
        ctx.save();
        ctx.translate(panel.x, y);
        ctx.scale(sx, sy);
        ctx.strokeStyle = '#334155';
        ctx.fillStyle = '#f8fafc';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.roundRect(115, 78, 575, 224, 30);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = '#dbeafe';
        ctx.strokeStyle = '#475569';
        ctx.lineWidth = 2;
        if (sketch.vehicle_kind === 'kombi') {
          ctx.fillRect(165, 96, 55, 188);
          ctx.strokeRect(165, 96, 55, 188);
          ctx.fillRect(630, 96, 35, 188);
          ctx.strokeRect(630, 96, 35, 188);
        } else {
          ctx.fillRect(248, 102, 65, 176);
          ctx.strokeRect(248, 102, 65, 176);
          const rx =
            sketch.vehicle_kind === 'singlecab'
              ? 405
              : sketch.vehicle_kind === 'doublecab'
                ? 465
                : sketch.vehicle_kind === 'suv'
                  ? 580
                  : sketch.vehicle_kind === 'hatchback'
                    ? 537
                    : 500;
          ctx.fillRect(rx, 102, 50, 176);
          ctx.strokeRect(rx, 102, 50, 176);
        }
        ctx.restore();
      }

      const drawMarks = (strokes: SketchStroke[], pins: SketchDamagePin[], color: string) => {
        const sx = panelW / SKETCH_WIDTH;
        const sy = panelH / SKETCH_HEIGHT;
        ctx.save();
        ctx.translate(panel.x, y);
        ctx.strokeStyle = color;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        for (const s of strokes) {
          if ((s.view ?? 'top') !== panel.view || s.points.length < 2) continue;
          ctx.lineWidth = Math.max(2, (s.width || 4) * sx);
          ctx.beginPath();
          ctx.moveTo(s.points[0].x * sx, s.points[0].y * sy);
          for (let i = 1; i < s.points.length; i += 1) {
            ctx.lineTo(s.points[i].x * sx, s.points[i].y * sy);
          }
          ctx.stroke();
        }
        for (const p of pins) {
          if ((p.view ?? 'top') !== panel.view) continue;
          const px = p.x * sx;
          const py = p.y * sy;
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(px, py, 10, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 1.5;
          ctx.stroke();
          ctx.fillStyle = '#ffffff';
          ctx.font = 'bold 9px monospace';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(`${p.type}${p.number}`, px, py + 0.5);
        }
        ctx.restore();
      };

      drawMarks(sketch.strokes_out, sketch.pins_out, '#d92d20');
      drawMarks(sketch.strokes_in, sketch.pins_in, '#1d4ed8');
    }

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
  const svgRefs = useRef<Record<SketchPanelView, SVGSVGElement | null>>({
    left: null,
    right: null,
    top: null,
  });
  const [tool, setTool] = useState<'pin' | 'draw' | 'erase'>('pin');
  const [pinType, setPinType] = useState<DamagePinType>('S');
  const [activeStroke, setActiveStroke] = useState<SketchStroke | null>(null);
  const [selectedPinId, setSelectedPinId] = useState<string | null>(null);

  const media = SKETCH_3D_MEDIA_BY_KIND[value.vehicle_kind] ?? SKETCH_3D_MEDIA_BY_KIND.sedan;
  const [leftSrc, setLeftSrc] = useState<string>(() => getCachedSketchImageSync(media.left));
  const [rightSrc, setRightSrc] = useState<string>(() => getCachedSketchImageSync(media.right));

  useEffect(() => {
    void warmVehicleSketchImages();
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLeftSrc(getCachedSketchImageSync(media.left));
    setRightSrc(getCachedSketchImageSync(media.right));
    void resolveCachedSketchImageSrc(media.left).then((resolved) => {
      if (!cancelled) setLeftSrc(resolved);
    });
    void resolveCachedSketchImageSrc(media.right).then((resolved) => {
      if (!cancelled) setRightSrc(resolved);
    });
    return () => {
      cancelled = true;
    };
  }, [media.left, media.right]);

  const strokesKey = activeLayer === 'out' ? 'strokes_out' : 'strokes_in';
  const pinsKey = activeLayer === 'out' ? 'pins_out' : 'pins_in';
  const noDamageKey = activeLayer === 'out' ? 'no_damage_out' : 'no_damage_in';

  const layerColor = activeLayer === 'out' ? '#d92d20' : '#1d4ed8';
  const activeStrokes = value[strokesKey];
  const activePins = value[pinsKey];
  const noDamageChecked = value[noDamageKey];

  const getSvgCoords = (
    e: React.PointerEvent<SVGSVGElement>,
    panelView: SketchPanelView
  ): { x: number; y: number } => {
    const svg = svgRefs.current[panelView];
    if (!svg) return { x: 0, y: 0 };
    const rect = svg.getBoundingClientRect();
    const x = Math.max(0, Math.min(SKETCH_WIDTH, ((e.clientX - rect.left) / rect.width) * SKETCH_WIDTH));
    const y = Math.max(0, Math.min(SKETCH_HEIGHT, ((e.clientY - rect.top) / rect.height) * SKETCH_HEIGHT));
    return { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 };
  };

  const handlePointerDown = (e: React.PointerEvent<SVGSVGElement>, panelView: SketchPanelView) => {
    if (readOnly || !onChange) return;
    const pt = getSvgCoords(e, panelView);

    if (tool === 'pin') {
      const nextNum = activePins.reduce((max, p) => Math.max(max, p.number), 0) + 1;
      const newPin: SketchDamagePin = {
        id: `pin_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        view: panelView,
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
        view: panelView,
        points: [pt],
        width: 5,
      });
      return;
    }

    if (tool === 'erase') {
      const hitPin = activePins.find(
        (p) => (p.view ?? 'top') === panelView && Math.hypot(p.x - pt.x, p.y - pt.y) <= 28
      );
      if (hitPin) {
        onChange({
          ...value,
          [pinsKey]: activePins.filter((p) => p.id !== hitPin.id),
        });
        return;
      }
      const hitStroke = activeStrokes.find(
        (s) =>
          (s.view ?? 'top') === panelView &&
          s.points.some((sp) => Math.hypot(sp.x - pt.x, sp.y - pt.y) <= 26)
      );
      if (hitStroke) {
        onChange({
          ...value,
          [strokesKey]: activeStrokes.filter((s) => s.id !== hitStroke.id),
        });
      }
    }
  };

  const handlePointerMove = (e: React.PointerEvent<SVGSVGElement>, panelView: SketchPanelView) => {
    if (!activeStroke || activeStroke.view !== panelView || readOnly) return;
    const pt = getSvgCoords(e, panelView);
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
    if (
      activePins.length > 0 &&
      (activeStrokes.length === 0 ||
        activePins[activePins.length - 1].id > activeStrokes[activeStrokes.length - 1].id)
    ) {
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

  const renderPanelOverlayMarks = (panelView: SketchPanelView) => (
    <>
      {/* OUT Layer (#d92d20) */}
      {value.strokes_out
        .filter((s) => (s.view ?? 'top') === panelView)
        .map((s) => (
          <polyline
            key={s.id}
            fill="none"
            stroke="#d92d20"
            strokeWidth={s.width || 5}
            strokeLinecap="round"
            strokeLinejoin="round"
            points={toPolylinePoints(s.points)}
          />
        ))}
      {value.pins_out
        .filter((p) => (p.view ?? 'top') === panelView)
        .map((p) => (
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
            <circle cx={p.x} cy={p.y} r="17" fill="#d92d20" stroke="#ffffff" strokeWidth="3" />
            <text
              x={p.x}
              y={p.y + 4.5}
              textAnchor="middle"
              className="fill-white font-mono text-[13px] font-bold pointer-events-none"
            >
              {p.type}
              {p.number}
            </text>
          </g>
        ))}

      {/* IN Layer (#1d4ed8) */}
      {value.strokes_in
        .filter((s) => (s.view ?? 'top') === panelView)
        .map((s) => (
          <polyline
            key={s.id}
            fill="none"
            stroke="#1d4ed8"
            strokeWidth={s.width || 5}
            strokeLinecap="round"
            strokeLinejoin="round"
            points={toPolylinePoints(s.points)}
          />
        ))}
      {value.pins_in
        .filter((p) => (p.view ?? 'top') === panelView)
        .map((p) => (
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
            <circle cx={p.x} cy={p.y} r="17" fill="#1d4ed8" stroke="#ffffff" strokeWidth="3" />
            <text
              x={p.x}
              y={p.y + 4.5}
              textAnchor="middle"
              className="fill-white font-mono text-[13px] font-bold pointer-events-none"
            >
              {p.type}
              {p.number}
            </text>
          </g>
        ))}

      {/* Active Stroke Preview */}
      {activeStroke && (activeStroke.view ?? 'top') === panelView && (
        <polyline
          fill="none"
          stroke={layerColor}
          strokeWidth={activeStroke.width}
          strokeLinecap="round"
          strokeLinejoin="round"
          points={toPolylinePoints(activeStroke.points)}
        />
      )}
    </>
  );

  return (
    <div className="space-y-3 rounded-2xl border border-blue-200 bg-white p-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="text-base font-bold text-blue-950">Vehicle Condition Sketch (3-View Inspection)</h3>
          <p className="text-xs text-slate-600">
            OUT marks appear in <span className="font-semibold text-[#d92d20]">Red</span> · IN return marks appear in{' '}
            <span className="font-semibold text-[#1d4ed8]">Blue</span>. Tap Left Side (3D), Right Side (3D), or Top (2D) to pin or draw scratches &amp; deformities.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {canChangeKind && !readOnly && onChange ? (
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                All 3 Views:
              </span>
              <select
                aria-label="Vehicle model 3D and 2D diagram"
                value={value.vehicle_kind}
                onChange={(e) =>
                  onChange({ ...value, vehicle_kind: e.target.value as SketchVehicleKind })
                }
                className="cyan-glow-input min-h-[38px] rounded-lg border border-blue-200 bg-white px-3 text-xs font-semibold text-blue-950"
              >
                {SKETCH_KINDS.map((k) => (
                  <option key={k.id} value={k.id}>
                    Model View: {k.label}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <span className="rounded-lg border border-blue-200 bg-blue-50/70 px-3 py-1.5 text-xs font-semibold text-blue-900">
              Model View: {SKETCH_KINDS.find((k) => k.id === value.vehicle_kind)?.label ?? value.vehicle_kind}
            </span>
          )}
        </div>
      </div>

      {!readOnly && onChange && (
        <div className="flex flex-wrap items-center gap-2 border-y border-blue-100 py-2">
          <button
            type="button"
            onClick={() => setTool('pin')}
            className={`inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border px-3 text-xs font-semibold ${
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
            className={`inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border px-3 text-xs font-semibold ${
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
            className={`inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border px-3 text-xs font-semibold ${
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
                  className={`min-h-[32px] rounded-md border px-2 text-xs font-mono font-bold ${
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
              className="inline-flex min-h-[34px] items-center gap-1 rounded-lg border border-blue-200 bg-white px-2.5 text-xs font-semibold text-blue-900 disabled:opacity-40"
            >
              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Undo</span>
            </button>
            <button
              type="button"
              onClick={handleClearLayer}
              disabled={activePins.length === 0 && activeStrokes.length === 0}
              className="inline-flex min-h-[34px] items-center gap-1 rounded-lg border border-red-200 bg-red-50 px-2.5 text-xs font-semibold text-red-800 disabled:opacity-40"
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Clear {activeLayer.toUpperCase()}</span>
            </button>
          </div>
        </div>
      )}

      {/* Compact 3-Panel Inspection Grid: Stacked cleanly & compact on Mobile; 3 columns on Desktop & Print A4 */}
      <div className="flex flex-col items-center gap-2.5 md:grid md:grid-cols-3 md:items-stretch print:grid print:grid-cols-3 print:gap-2">
        {/* Panel 1: Left Side (3D) */}
        <div className="w-[82%] max-w-[270px] sm:w-[70%] sm:max-w-[300px] md:w-full md:max-w-none print:w-full print:max-w-none rounded-xl border border-blue-200 bg-white shadow-xs overflow-hidden flex flex-col">
          <div className="flex items-center justify-between border-b border-blue-100 bg-gradient-to-r from-blue-50 to-cyan-50/70 px-2.5 py-1.5 text-[11px] font-bold text-blue-950">
            <span>1. Left Side (3D)</span>
            <span className="text-[10px] font-mono text-slate-600">
              {SKETCH_KINDS.find((k) => k.id === value.vehicle_kind)?.label ?? 'Sedan'}
            </span>
          </div>
          <div className="relative aspect-[16/9] w-full bg-white touch-none overflow-hidden">
            <img
              key={`${value.vehicle_kind}-left`}
              src={leftSrc}
              alt={`Left side 3D ${value.vehicle_kind} inspection view`}
              referrerPolicy="no-referrer"
              decoding="async"
              draggable={false}
              className="h-full w-full object-contain pointer-events-none select-none"
            />
            <svg
              ref={(el) => {
                svgRefs.current.left = el;
              }}
              viewBox={`0 0 ${SKETCH_WIDTH} ${SKETCH_HEIGHT}`}
              onPointerDown={(e) => handlePointerDown(e, 'left')}
              onPointerMove={(e) => handlePointerMove(e, 'left')}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerUp}
              className={`absolute inset-0 h-full w-full select-none ${
                readOnly ? 'cursor-default' : 'cursor-crosshair'
              }`}
              role="img"
              aria-label="Left side 3D vehicle condition diagram"
            >
              {renderPanelOverlayMarks('left')}
            </svg>
          </div>
        </div>

        {/* Panel 2: Right Side (3D) */}
        <div className="w-[82%] max-w-[270px] sm:w-[70%] sm:max-w-[300px] md:w-full md:max-w-none print:w-full print:max-w-none rounded-xl border border-blue-200 bg-white shadow-xs overflow-hidden flex flex-col">
          <div className="flex items-center justify-between border-b border-blue-100 bg-gradient-to-r from-blue-50 to-cyan-50/70 px-2.5 py-1.5 text-[11px] font-bold text-blue-950">
            <span>2. Right Side (3D)</span>
            <span className="text-[10px] font-mono text-slate-600">
              {SKETCH_KINDS.find((k) => k.id === value.vehicle_kind)?.label ?? 'Sedan'}
            </span>
          </div>
          <div className="relative aspect-[16/9] w-full bg-white touch-none overflow-hidden">
            <img
              key={`${value.vehicle_kind}-right`}
              src={rightSrc}
              alt={`Right side 3D ${value.vehicle_kind} inspection view`}
              referrerPolicy="no-referrer"
              decoding="async"
              draggable={false}
              className={`h-full w-full object-contain pointer-events-none select-none ${
                media.flipRight ? '-scale-x-100' : ''
              }`}
            />
            <svg
              ref={(el) => {
                svgRefs.current.right = el;
              }}
              viewBox={`0 0 ${SKETCH_WIDTH} ${SKETCH_HEIGHT}`}
              onPointerDown={(e) => handlePointerDown(e, 'right')}
              onPointerMove={(e) => handlePointerMove(e, 'right')}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerUp}
              className={`absolute inset-0 h-full w-full select-none ${
                readOnly ? 'cursor-default' : 'cursor-crosshair'
              }`}
              role="img"
              aria-label="Right side 3D vehicle condition diagram"
            >
              {renderPanelOverlayMarks('right')}
            </svg>
          </div>
        </div>

        {/* Panel 3: Top-Down 2D Diagram */}
        <div className="w-[82%] max-w-[270px] sm:w-[70%] sm:max-w-[300px] md:w-full md:max-w-none print:w-full print:max-w-none rounded-xl border border-blue-200 bg-white shadow-xs overflow-hidden flex flex-col">
          <div className="flex items-center justify-between border-b border-blue-100 bg-gradient-to-r from-blue-50 to-cyan-50/70 px-2.5 py-1.5 text-[11px] font-bold text-blue-950">
            <span>3. Top View (2D)</span>
            <span className="text-[10px] font-mono text-slate-600">
              {SKETCH_KINDS.find((k) => k.id === value.vehicle_kind)?.label ?? 'Sedan'}
            </span>
          </div>
          <div className="relative aspect-[16/9] w-full bg-slate-50/40 touch-none overflow-hidden">
            <svg
              ref={(el) => {
                svgRefs.current.top = el;
              }}
              viewBox={`0 0 ${SKETCH_WIDTH} ${SKETCH_HEIGHT}`}
              onPointerDown={(e) => handlePointerDown(e, 'top')}
              onPointerMove={(e) => handlePointerMove(e, 'top')}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerUp}
              className={`h-full w-full select-none ${
                readOnly ? 'cursor-default' : 'cursor-crosshair'
              }`}
              role="img"
              aria-label={`Top-down 2D vehicle condition diagram (${value.vehicle_kind})`}
            >
              <text x={SKETCH_WIDTH / 2} y="24" textAnchor="middle" className="fill-slate-500 text-[13px] font-bold tracking-wider">
                LEFT SIDE
              </text>
              <text x={SKETCH_WIDTH / 2} y={SKETCH_HEIGHT - 12} textAnchor="middle" className="fill-slate-500 text-[13px] font-bold tracking-wider">
                RIGHT SIDE
              </text>
              <text
                x="24"
                y={SKETCH_HEIGHT / 2}
                textAnchor="middle"
                transform={`rotate(-90 24 ${SKETCH_HEIGHT / 2})`}
                className="fill-slate-500 text-[13px] font-bold tracking-wider"
              >
                FRONT
              </text>
              <text
                x={SKETCH_WIDTH - 24}
                y={SKETCH_HEIGHT / 2}
                textAnchor="middle"
                transform={`rotate(90 ${SKETCH_WIDTH - 24} ${SKETCH_HEIGHT / 2})`}
                className="fill-slate-500 text-[13px] font-bold tracking-wider"
              >
                REAR
              </text>

              {renderSilhouettePaths(value.vehicle_kind)}
              {renderPanelOverlayMarks('top')}
            </svg>
          </div>
        </div>
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
            const panelLabel = VIEW_PANEL_LABELS[pin.view ?? 'top'];
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
                  {pin.type}
                  {pin.number}
                </span>
                <span className="font-semibold text-blue-950 shrink-0">
                  {pin.layer.toUpperCase()} · {panelLabel} · {PIN_TYPE_LABELS[pin.type]}
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
      className={`rounded-xl border p-2.5 print:p-1.5 space-y-1.5 print:space-y-1 ${
        locked ? 'border-slate-200 bg-slate-50/70' : 'border-blue-200 bg-white'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs sm:text-sm print:text-[10.5px] font-bold text-blue-950 leading-tight">
            {title} {required && !locked ? '*' : ''}
          </div>
          {subtitle && (
            <div className="text-[11px] print:text-[9px] text-slate-500 leading-tight">{subtitle}</div>
          )}
        </div>
        {!locked && sigDataUrl && (
          <button
            type="button"
            onClick={clearPad}
            className="text-xs font-semibold text-red-700 hover:underline shrink-0"
          >
            Clear
          </button>
        )}
      </div>

      {locked ? (
        <div className="space-y-1.5 print:space-y-1">
          {value?.signature_data_url ? (
            <div className="rounded-lg border border-slate-200 bg-white p-1 flex items-center justify-center min-h-[54px] max-h-[58px] print:min-h-[38px] print:max-h-[42px]">
              <img
                src={value.signature_data_url}
                alt={`${title} signature`}
                className="max-h-[48px] print:max-h-[34px] object-contain"
              />
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-slate-300 bg-white/60 px-2 py-2.5 print:py-1.5 text-center text-[11px] print:text-[9.5px] text-slate-500">
              {lockMessage || 'Locked until vehicle return'}
            </div>
          )}
          <div className="grid grid-cols-2 gap-1.5 border-t border-slate-200/80 pt-1 text-[11px] print:text-[9.5px] leading-tight">
            <div className="min-w-0">
              <span className="text-slate-500 block">Name</span>
              <span className="font-semibold text-blue-950 truncate block">{value?.name || '—'}</span>
            </div>
            <div className="min-w-0">
              <span className="text-slate-500 block">ID / Licence No.</span>
              <span className="font-mono font-semibold text-blue-950 truncate block">
                {value?.id_number || '—'}
              </span>
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
              height={96}
              onPointerDown={handleDown}
              onPointerMove={handleMove}
              onPointerUp={handleUp}
              onPointerCancel={handleUp}
              className="w-full h-[80px] cursor-crosshair block"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
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
                className="cyan-glow-input mt-0.5 block w-full min-h-[36px] rounded-lg border border-blue-200 px-2 text-xs text-blue-950"
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
                className="cyan-glow-input mt-0.5 block w-full min-h-[36px] rounded-lg border border-blue-200 px-2 font-mono text-xs text-blue-950"
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
  hirerType?: ChecklistHirerType;
  onChangeOutRenter?: (entry: ChecklistSignatureEntry) => void;
  onChangeOutCompany?: (entry: ChecklistSignatureEntry) => void;
  onChangeInRenter?: (entry: ChecklistSignatureEntry) => void;
  onChangeInCompany?: (entry: ChecklistSignatureEntry) => void;
}

export const ChecklistSectionG: React.FC<ChecklistSectionGProps> = ({
  declarationText,
  signatures,
  mode,
  hirerType = 'renter',
  onChangeOutRenter,
  onChangeOutCompany,
  onChangeInRenter,
  onChangeInCompany,
}) => {
  const isOwner = hirerType === 'owner';

  return (
    <div className="space-y-2.5 print:space-y-1.5 rounded-2xl border border-blue-200 bg-white p-3.5 sm:p-4 print:p-2 print:rounded-lg print:break-inside-avoid">
      <div>
        <h3 className="text-sm sm:text-base print:text-xs font-bold text-blue-950">
          Section G — Declaration &amp; Sign-Off
        </h3>
        <p className="mt-1 rounded-lg border border-blue-100 bg-blue-50/40 p-2 print:p-1.5 text-xs print:text-[9.5px] leading-snug text-slate-700">
          {declarationText}
        </p>
      </div>

      {/* Row 1: Initial Check-Out (Renter) or Check-In (Owner) inline with Company Representative */}
      <div className="space-y-1">
        <div className="text-[10px] font-bold uppercase tracking-wider text-blue-900">
          {isOwner
            ? 'Check-In Signatures (Owner & Company Representative)'
            : 'Check-Out Signatures (Renter / Client & Company Representative)'}
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 print:grid-cols-2 print:gap-2">
          <SignaturePadField
            title={isOwner ? '1. Checked In By (Owner)' : '1. Checked Out By (Renter / Client)'}
            subtitle={isOwner ? 'Condition verified on check-in' : 'Condition accepted on departure'}
            value={signatures.outRenter}
            onChange={onChangeOutRenter}
            locked={mode !== 'create'}
            required={mode === 'create'}
          />
          <SignaturePadField
            title={
              isOwner
                ? '2. Checked In By (Company Representative)'
                : '2. Checked Out By (Company Representative)'
            }
            subtitle={
              isOwner
                ? 'Yard / Security check-in verification'
                : 'Yard / Security dispatch verification'
            }
            value={signatures.outCompany}
            onChange={onChangeOutCompany}
            locked={mode !== 'create'}
            required={mode === 'create'}
          />
        </div>
      </div>

      {/* Row 2: Closing Check-In (Renter) or Check-Out (Owner) inline with Company Representative */}
      <div className="space-y-1">
        <div className="text-[10px] font-bold uppercase tracking-wider text-cyan-900">
          {isOwner
            ? 'Check-Out Signatures (Owner & Company Representative)'
            : 'Check-In / Return Signatures (Renter / Client & Company Representative)'}
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 print:grid-cols-2 print:gap-2">
          <SignaturePadField
            title={isOwner ? '3. Checked Out By (Owner)' : '3. Checked In By (Renter / Client)'}
            subtitle={isOwner ? 'Condition accepted on check-out' : 'Condition accepted on return'}
            value={signatures.inRenter}
            onChange={onChangeInRenter}
            locked={mode !== 'return'}
            lockMessage={
              isOwner
                ? mode === 'create'
                  ? 'Signed upon vehicle check-out'
                  : 'Not yet checked out'
                : mode === 'create'
                  ? 'Signed upon vehicle return'
                  : 'Not yet returned'
            }
            required={mode === 'return'}
          />
          <SignaturePadField
            title={
              isOwner
                ? '4. Checked Out By (Company Representative)'
                : '4. Checked In By (Company Representative)'
            }
            subtitle={
              isOwner
                ? 'Yard / Security check-out sign-off'
                : 'Yard / Security check-in sign-off'
            }
            value={signatures.inCompany}
            onChange={onChangeInCompany}
            locked={mode !== 'return'}
            lockMessage={
              isOwner
                ? mode === 'create'
                  ? 'Signed upon vehicle check-out'
                  : 'Not yet checked out'
                : mode === 'create'
                  ? 'Signed upon vehicle return'
                  : 'Not yet returned'
            }
            required={mode === 'return'}
          />
        </div>
      </div>
    </div>
  );
};
