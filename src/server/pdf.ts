/**
 * Minimal, zero-dependency, Cloudflare-Workers-compatible PDF 1.4 generator
 * producing multi-page Landscape A4 reports with Helvetica fonts, company header,
 * summary line, and clean aligned tables.
 */

function toPdfAscii(value: string): string {
  return value
    .replace(/[\u2014\u2013]/g, '-')
    .replace(/\u00b7/g, '|')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[^\x20-\x7E]/g, ' ');
}

function pdfEscape(value: string): string {
  return toPdfAscii(value)
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

function truncateText(text: string, maxChars: number): string {
  const clean = toPdfAscii(text).trim();
  if (clean.length <= maxChars) return clean;
  if (maxChars <= 3) return clean.slice(0, maxChars);
  return `${clean.slice(0, maxChars - 2)}..`;
}

export interface PdfReportInput {
  companyName: string;
  companyContact: string;
  companyAddress: string;
  reportTitle: string;
  generatedAt: string;
  dateRangeLabel: string;
  summaryItems: Array<{ label: string; value: string }>;
  columns: Array<{ key: string; label: string; width: number }>;
  rows: Array<Record<string, string | number | null>>;
}

export function buildReportPdf(input: PdfReportInput): Uint8Array {
  // Landscape A4: 842 x 595 points
  const pageWidth = 842;
  const pageHeight = 595;
  const marginX = 36;
  const topY = pageHeight - 36;
  const bottomY = 36;

  // Normalize column widths so they fit within printable width (842 - 72 = 770 pt)
  const printableWidth = pageWidth - marginX * 2;
  const totalWeight = input.columns.reduce((acc, col) => acc + col.width, 0) || 1;
  const cols = input.columns.map((col) => ({
    ...col,
    ptWidth: (col.width / totalWeight) * printableWidth,
  }));

  const rowsPerPageFirst = 21;
  const rowsPerPageNext = 26;

  const pagesRows: Array<Array<Record<string, string | number | null>>> = [];
  if (input.rows.length === 0) {
    pagesRows.push([]);
  } else {
    pagesRows.push(input.rows.slice(0, rowsPerPageFirst));
    let cursor = rowsPerPageFirst;
    while (cursor < input.rows.length) {
      pagesRows.push(input.rows.slice(cursor, cursor + rowsPerPageNext));
      cursor += rowsPerPageNext;
    }
  }

  const totalPages = pagesRows.length;
  const pageStreams: string[] = [];

  for (let p = 0; p < totalPages; p++) {
    const cmds: string[] = [];
    let y = topY;

    // Header band
    cmds.push('0.06 0.09 0.16 rg'); // slate-900 text
    cmds.push(`BT /F2 14 Tf ${marginX} ${y} Td (${pdfEscape(input.companyName)}) Tj ET`);

    const pageLabel = `Page ${p + 1} of ${totalPages}`;
    cmds.push('0.39 0.45 0.55 rg');
    cmds.push(`BT /F1 9 Tf ${pageWidth - marginX - 64} ${y} Td (${pdfEscape(pageLabel)}) Tj ET`);
    y -= 15;

    const contactLine = [input.companyAddress, input.companyContact].filter(Boolean).join('  |  ');
    if (contactLine) {
      cmds.push(`BT /F1 9 Tf ${marginX} ${y} Td (${pdfEscape(contactLine)}) Tj ET`);
      y -= 14;
    }

    // Divider line
    cmds.push('0.80 0.84 0.88 RG 0.7 w');
    cmds.push(`${marginX} ${y + 4} m ${pageWidth - marginX} ${y + 4} l S`);
    y -= 14;

    // Report title & metadata
    cmds.push('0.06 0.09 0.16 rg');
    cmds.push(`BT /F2 12 Tf ${marginX} ${y} Td (${pdfEscape(input.reportTitle)}) Tj ET`);
    y -= 14;

    cmds.push('0.28 0.33 0.41 rg');
    cmds.push(
      `BT /F1 8.5 Tf ${marginX} ${y} Td (${pdfEscape(
        `Date Range: ${input.dateRangeLabel}   |   Generated (Africa/Harare): ${input.generatedAt}`
      )}) Tj ET`
    );
    y -= 16;

    // Summary block on first page
    if (p === 0 && input.summaryItems.length > 0) {
      const summaryText = input.summaryItems.map((s) => `${s.label}: ${s.value}`).join('   |   ');
      cmds.push('0.95 0.96 0.98 rg');
      cmds.push(`${marginX} ${y - 6} ${printableWidth} 20 re f`);
      cmds.push('0.06 0.09 0.16 rg');
      cmds.push(`BT /F2 8.5 Tf ${marginX + 8} ${y} Td (${pdfEscape(truncateText(summaryText, 130))}) Tj ET`);
      y -= 28;
    } else {
      y -= 6;
    }

    // Table header bar
    cmds.push('0.06 0.09 0.16 rg');
    cmds.push(`${marginX} ${y - 6} ${printableWidth} 18 re f`);
    cmds.push('1 1 1 rg');

    let colX = marginX + 4;
    for (const col of cols) {
      const maxChars = Math.max(4, Math.floor((col.ptWidth - 6) / 4.8));
      cmds.push(`BT /F2 8 Tf ${colX.toFixed(1)} ${y} Td (${pdfEscape(truncateText(col.label, maxChars))}) Tj ET`);
      colX += col.ptWidth;
    }
    y -= 20;

    // Table rows
    const pageData = pagesRows[p];
    if (pageData.length === 0) {
      cmds.push('0.39 0.45 0.55 rg');
      cmds.push(`BT /F1 10 Tf ${marginX + 6} ${y - 10} Td (No records match the selected filters.) Tj ET`);
    } else {
      for (let r = 0; r < pageData.length; r++) {
        const row = pageData[r];
        if (r % 2 === 1) {
          cmds.push('0.97 0.98 0.99 rg');
          cmds.push(`${marginX} ${y - 5} ${printableWidth} 17 re f`);
        }

        cmds.push('0.12 0.16 0.23 rg');
        let cellX = marginX + 4;
        for (const col of cols) {
          const raw = row[col.key];
          const text = raw === null || raw === undefined || raw === '' ? '-' : String(raw);
          const maxChars = Math.max(4, Math.floor((col.ptWidth - 6) / 4.4));
          cmds.push(
            `BT /F1 8 Tf ${cellX.toFixed(1)} ${y} Td (${pdfEscape(truncateText(text, maxChars))}) Tj ET`
          );
          cellX += col.ptWidth;
        }

        cmds.push('0.90 0.92 0.95 RG 0.4 w');
        cmds.push(`${marginX} ${y - 5} m ${pageWidth - marginX} ${y - 5} l S`);
        y -= 17;
      }
    }

    // Footer
    cmds.push('0.45 0.50 0.58 rg');
    cmds.push(
      `BT /F1 8 Tf ${marginX} ${bottomY - 12} Td (${pdfEscape(
        `${input.companyName} — Fleet Secure Auditable Record Book`
      )}) Tj ET`
    );

    pageStreams.push(cmds.join('\n'));
  }

  // Assemble PDF object table:
  // 1: Catalog, 2: Pages, 3: Helvetica (/F1), 4: Helvetica-Bold (/F2), then per page [PageObj, StreamObj]
  const objects: string[] = [];
  const pageObjNums: number[] = [];

  for (let i = 0; i < pageStreams.length; i++) {
    pageObjNums.push(5 + i * 2);
  }

  objects.push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  objects.push(
    `2 0 obj\n<< /Type /Pages /Kids [${pageObjNums.map((n) => `${n} 0 R`).join(' ')}] /Count ${totalPages} >>\nendobj\n`
  );
  objects.push('3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n');
  objects.push('4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>\nendobj\n');

  for (let i = 0; i < pageStreams.length; i++) {
    const pageObjId = 5 + i * 2;
    const streamObjId = pageObjId + 1;
    const streamContent = pageStreams[i];
    const streamBytes = new TextEncoder().encode(streamContent).length;

    objects.push(
      `${pageObjId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${streamObjId} 0 R >>\nendobj\n`
    );
    objects.push(
      `${streamObjId} 0 obj\n<< /Length ${streamBytes} >>\nstream\n${streamContent}\nendstream\nendobj\n`
    );
  }

  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [0]; // object 0 unused
  let currentOffset = 0;

  const pushStr = (s: string) => {
    const bytes = encoder.encode(s);
    chunks.push(bytes);
    currentOffset += bytes.length;
  };

  pushStr('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  for (const obj of objects) {
    offsets.push(currentOffset);
    pushStr(obj);
  }

  const xrefStart = currentOffset;
  pushStr(`xref\n0 ${objects.length + 1}\n`);
  pushStr('0000000000 65535 f \n');
  for (let i = 1; i < offsets.length; i++) {
    pushStr(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`);
  }
  pushStr(
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`
  );

  const totalLen = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(totalLen);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}

export interface PdfChecklistInput {
  companyName: string;
  companyContact: string;
  companyAddress: string;
  checklistId: number;
  statusLabel: string;
  hirerLabel: string;
  hirerName: string;
  representative: string;
  cell: string;
  carModel: string;
  vehicleType: string;
  colour: string;
  regNumber: string;
  hireDate: string;
  days: number | null;
  returnDate: string | null;
  mileageOut: number;
  mileageIn: number | null;
  nextServiceMileage: number | null;
  datetimeIn: string;
  fuelType: string;
  fuelOut: string;
  fuelIn: string;
  items: Array<{
    idx: number;
    label: string;
    outText: string;
    inText: string;
    note: string;
  }>;
  differences: Array<{ label: string; outText: string; inText: string }>;
  sketchSummary: string[];
  declarationText: string;
  signatureGroupHeaders?: [string, string];
  signaturesSummary: Array<{ roleLabel: string; name: string; idNumber: string; signedAt: string }>;
  generatedAt: string;
}

function wrapPdfLine(text: string, maxChars: number): string[] {
  const clean = toPdfAscii(text).replace(/\s+/g, ' ').trim();
  if (!clean) return [''];
  const words = clean.split(' ');
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if (!cur) {
      cur = w.slice(0, maxChars);
    } else if (cur.length + 1 + w.length <= maxChars) {
      cur = `${cur} ${w}`;
    } else {
      lines.push(cur);
      cur = w.slice(0, maxChars);
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

export function buildChecklistPdf(input: PdfChecklistInput): Uint8Array {
  // Portrait A4: 595 x 842 pt
  const pageWidth = 595;
  const pageHeight = 842;
  const marginX = 36;
  const topY = pageHeight - 36;
  const bottomY = 40;
  const printableWidth = pageWidth - marginX * 2;

  const pageStreams: string[] = [];
  let cmds: string[] = [];
  let y = topY;

  const startNewPage = () => {
    if (cmds.length > 0) {
      pageStreams.push(cmds.join('\n'));
    }
    cmds = [];
    y = topY;
    cmds.push('0.06 0.09 0.16 rg');
    cmds.push(`BT /F2 11 Tf ${marginX} ${y} Td (${pdfEscape(`${input.companyName} - Digital Vehicle Checklist #${input.checklistId}`)}) Tj ET`);
    y -= 14;
    cmds.push('0.80 0.84 0.88 RG 0.6 w');
    cmds.push(`${marginX} ${y + 3} m ${pageWidth - marginX} ${y + 3} l S`);
    y -= 14;
  };

  const ensureSpace = (needed: number) => {
    if (y - needed < bottomY) {
      startNewPage();
    }
  };

  // First page header
  cmds.push('0.06 0.09 0.16 rg');
  cmds.push(`BT /F2 14 Tf ${marginX} ${y} Td (${pdfEscape(input.companyName)}) Tj ET`);
  cmds.push('0.06 0.56 0.68 rg');
  cmds.push(`BT /F2 10 Tf ${pageWidth - marginX - 110} ${y} Td (${pdfEscape(input.statusLabel)}) Tj ET`);
  y -= 14;

  const contactLine = [input.companyAddress, input.companyContact].filter(Boolean).join('  |  ');
  if (contactLine) {
    cmds.push('0.39 0.45 0.55 rg');
    cmds.push(`BT /F1 8.5 Tf ${marginX} ${y} Td (${pdfEscape(contactLine)}) Tj ET`);
    y -= 13;
  }

  cmds.push('0.06 0.09 0.16 rg');
  cmds.push(`BT /F2 13 Tf ${marginX} ${y} Td (${pdfEscape(`Digital Vehicle Checklist #${input.checklistId}`)}) Tj ET`);
  y -= 12;
  cmds.push('0.39 0.45 0.55 rg');
  cmds.push(`BT /F1 8 Tf ${marginX} ${y} Td (${pdfEscape(`Generated (Africa/Harare): ${input.generatedAt}`)}) Tj ET`);
  y -= 12;

  cmds.push('0.80 0.84 0.88 RG 0.7 w');
  cmds.push(`${marginX} ${y + 3} m ${pageWidth - marginX} ${y + 3} l S`);
  y -= 14;

  // Sections A-E Metadata Grid
  const metaRows: [string, string][] = [
    [`${input.hirerLabel}: ${input.hirerName}`, `Representative: ${input.representative || '-'}   |   Cell: ${input.cell || '-'}`],
    [`Vehicle: ${input.carModel} (${input.vehicleType})`, `Reg: ${input.regNumber}   |   Colour: ${input.colour || '-'}`],
    [`Hire Date: ${input.hireDate}${input.days !== null ? ` (${input.days} day${input.days === 1 ? '' : 's'})` : ' (Open-ended)'}`, `Expected Return: ${input.returnDate || 'Optional / Not set'}`],
    [`Mileage OUT: ${input.mileageOut.toLocaleString()} km`, `Mileage IN: ${input.mileageIn !== null ? `${input.mileageIn.toLocaleString()} km` : 'Open'}`],
    [
      `Fuel (${input.fuelType.toUpperCase()}): OUT ${input.fuelOut || 'N/A'} | IN ${input.fuelIn || '-'}`,
      `Next Service: ${input.nextServiceMileage !== null ? `${input.nextServiceMileage.toLocaleString()} km` : '-'} | Date IN: ${input.datetimeIn || 'Open'}`,
    ],
  ];

  for (const [left, right] of metaRows) {
    ensureSpace(16);
    cmds.push('0.96 0.98 1.00 rg');
    cmds.push(`${marginX} ${y - 4} ${printableWidth} 15 re f`);
    cmds.push('0.09 0.13 0.22 rg');
    cmds.push(`BT /F1 8.5 Tf ${marginX + 4} ${y} Td (${pdfEscape(truncateText(left, 56))}) Tj ET`);
    cmds.push(`BT /F1 8.5 Tf ${marginX + 265} ${y} Td (${pdfEscape(truncateText(right, 58))}) Tj ET`);
    y -= 17;
  }
  y -= 6;

  // Section F Inspection Table
  ensureSpace(30);
  cmds.push('0.06 0.09 0.16 rg');
  cmds.push(`${marginX} ${y - 4} ${printableWidth} 16 re f`);
  cmds.push('1 1 1 rg');
  cmds.push(`BT /F2 8 Tf ${marginX + 4} ${y} Td (#) Tj ET`);
  cmds.push(`BT /F2 8 Tf ${marginX + 24} ${y} Td (Checklist Item) Tj ET`);
  cmds.push(`BT /F2 8 Tf ${marginX + 215} ${y} Td (OUT) Tj ET`);
  cmds.push(`BT /F2 8 Tf ${marginX + 355} ${y} Td (IN) Tj ET`);
  cmds.push(`BT /F2 8 Tf ${marginX + 455} ${y} Td (Note) Tj ET`);
  y -= 16;

  for (let i = 0; i < input.items.length; i++) {
    const it = input.items[i];
    ensureSpace(16);
    if (i % 2 === 1) {
      cmds.push('0.97 0.98 0.99 rg');
      cmds.push(`${marginX} ${y - 4} ${printableWidth} 14 re f`);
    }
    cmds.push('0.12 0.16 0.23 rg');
    cmds.push(`BT /F1 7.5 Tf ${marginX + 4} ${y} Td (${it.idx}) Tj ET`);
    cmds.push(`BT /F1 7.5 Tf ${marginX + 24} ${y} Td (${pdfEscape(truncateText(it.label, 38))}) Tj ET`);
    cmds.push(`BT /F1 7.5 Tf ${marginX + 215} ${y} Td (${pdfEscape(truncateText(it.outText || '-', 28))}) Tj ET`);
    cmds.push(`BT /F1 7.5 Tf ${marginX + 355} ${y} Td (${pdfEscape(truncateText(it.inText || '-', 20))}) Tj ET`);
    cmds.push(`BT /F1 7.5 Tf ${marginX + 455} ${y} Td (${pdfEscape(truncateText(it.note || '-', 14))}) Tj ET`);
    cmds.push('0.90 0.92 0.95 RG 0.35 w');
    cmds.push(`${marginX} ${y - 4} m ${pageWidth - marginX} ${y - 4} l S`);
    y -= 14;
  }

  // Differences summary (on return)
  if (input.differences.length > 0) {
    y -= 8;
    ensureSpace(32);
    cmds.push('0.75 0.15 0.15 rg');
    cmds.push(`BT /F2 10 Tf ${marginX} ${y} Td (Return Inspection Differences (${input.differences.length})) Tj ET`);
    y -= 14;
    for (const diff of input.differences) {
      ensureSpace(14);
      cmds.push('0.12 0.16 0.23 rg');
      const line = `- ${diff.label}: OUT "${diff.outText}" -> IN "${diff.inText}"`;
      cmds.push(`BT /F1 8 Tf ${marginX + 6} ${y} Td (${pdfEscape(truncateText(line, 110))}) Tj ET`);
      y -= 12;
    }
  }

  // Sketch Summary
  y -= 8;
  ensureSpace(32);
  cmds.push('0.06 0.09 0.16 rg');
  cmds.push(`BT /F2 10 Tf ${marginX} ${y} Td (Vehicle Condition Sketch Notes) Tj ET`);
  y -= 13;
  for (const sLine of input.sketchSummary) {
    for (const wrapped of wrapPdfLine(sLine, 105)) {
      ensureSpace(12);
      cmds.push('0.18 0.23 0.32 rg');
      cmds.push(`BT /F1 8 Tf ${marginX + 6} ${y} Td (${pdfEscape(wrapped)}) Tj ET`);
      y -= 11;
    }
  }

  // Section G Declaration & Signatures
  y -= 8;
  ensureSpace(40);
  cmds.push('0.06 0.09 0.16 rg');
  cmds.push(`BT /F2 10 Tf ${marginX} ${y} Td (Section G: Declaration & Sign-Off) Tj ET`);
  y -= 13;
  for (const line of wrapPdfLine(input.declarationText, 105)) {
    ensureSpace(12);
    cmds.push('0.20 0.25 0.34 rg');
    cmds.push(`BT /F1 8 Tf ${marginX} ${y} Td (${pdfEscape(line)}) Tj ET`);
    y -= 11;
  }

  y -= 6;
  const groupHeaders = input.signatureGroupHeaders ?? [
    'CHECK-OUT SIGNATURES',
    'CHECK-IN / RETURN SIGNATURES',
  ];
  const sigPairs: Array<[string, number, number]> = [
    [groupHeaders[0], 0, 1],
    [groupHeaders[1], 2, 3],
  ];
  const halfW = (printableWidth - 10) / 2;
  for (const [groupTitle, leftIdx, rightIdx] of sigPairs) {
    ensureSpace(46);
    cmds.push('0.94 0.97 1.00 rg');
    cmds.push(`${marginX} ${y - 36} ${printableWidth} 40 re f`);
    cmds.push('0.80 0.87 0.95 RG 0.5 w');
    cmds.push(`${marginX} ${y - 36} ${printableWidth} 40 re S`);
    cmds.push('0.07 0.25 0.52 rg');
    cmds.push(`BT /F2 7.5 Tf ${marginX + 6} ${y - 6} Td (${pdfEscape(groupTitle)}) Tj ET`);

    const cols: Array<[number, number]> = [
      [leftIdx, marginX + 6],
      [rightIdx, marginX + halfW + 14],
    ];
    for (const [sigIdx, colX] of cols) {
      const sig = input.signaturesSummary[sigIdx];
      if (!sig) continue;
      cmds.push('0.09 0.13 0.22 rg');
      cmds.push(
        `BT /F2 8 Tf ${colX.toFixed(1)} ${y - 17} Td (${pdfEscape(truncateText(sig.roleLabel, 40))}) Tj ET`
      );
      const detailLine = `${sig.name || 'Pending'} | ID: ${sig.idNumber || '-'}`;
      cmds.push('0.20 0.25 0.34 rg');
      cmds.push(
        `BT /F1 7.5 Tf ${colX.toFixed(1)} ${y - 27} Td (${pdfEscape(truncateText(detailLine, 46))}) Tj ET`
      );
      cmds.push('0.40 0.46 0.55 rg');
      cmds.push(
        `BT /F1 7 Tf ${colX.toFixed(1)} ${y - 34} Td (${pdfEscape(
          truncateText(`Signed: ${sig.signedAt || 'Pending'}`, 46)
        )}) Tj ET`
      );
    }
    y -= 44;
  }

  if (cmds.length > 0) {
    pageStreams.push(cmds.join('\n'));
  }

  // Footer on every page
  const totalPages = pageStreams.length;
  for (let p = 0; p < totalPages; p++) {
    pageStreams[p] += `\n0.45 0.50 0.58 rg\nBT /F1 8 Tf ${marginX} 20 Td (${pdfEscape(
      `${input.companyName} - Checklist #${input.checklistId}  |  Page ${p + 1} of ${totalPages}`
    )}) Tj ET`;
  }

  const objects: string[] = [];
  const pageObjNums = pageStreams.map((_, i) => 5 + i * 2);

  objects.push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  objects.push(
    `2 0 obj\n<< /Type /Pages /Kids [${pageObjNums.map((n) => `${n} 0 R`).join(' ')}] /Count ${totalPages} >>\nendobj\n`
  );
  objects.push('3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n');
  objects.push('4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>\nendobj\n');

  for (let i = 0; i < pageStreams.length; i++) {
    const pageObjId = 5 + i * 2;
    const streamObjId = pageObjId + 1;
    const streamContent = pageStreams[i];
    const streamBytes = new TextEncoder().encode(streamContent).length;

    objects.push(
      `${pageObjId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${streamObjId} 0 R >>\nendobj\n`
    );
    objects.push(
      `${streamObjId} 0 obj\n<< /Length ${streamBytes} >>\nstream\n${streamContent}\nendstream\nendobj\n`
    );
  }

  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [0];
  let currentOffset = 0;

  const pushStr = (s: string) => {
    const bytes = encoder.encode(s);
    chunks.push(bytes);
    currentOffset += bytes.length;
  };

  pushStr('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  for (const obj of objects) {
    offsets.push(currentOffset);
    pushStr(obj);
  }

  const xrefStart = currentOffset;
  pushStr(`xref\n0 ${objects.length + 1}\n`);
  pushStr('0000000000 65535 f \n');
  for (let i = 1; i < offsets.length; i++) {
    pushStr(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`);
  }
  pushStr(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`);

  const totalLen = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(totalLen);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}

