// Lectura de planillas (.xlsx y .csv) y escritura de .xlsx, sin dependencias.
// Un .xlsx es un ZIP con archivos XML; acá se lee y se escribe lo mínimo necesario para cargar artículos.
import { inflateRawSync, deflateRawSync, crc32 } from 'node:zlib';

const MAX_ENTRY_BYTES = 64 * 1024 * 1024; // tope por archivo descomprimido (protege de «bombas» ZIP)

// Error con un mensaje pensado para mostrarse tal cual al usuario.
export class SheetFormatError extends Error {}

// ---------- ZIP ----------
function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new SheetFormatError('El archivo no es una planilla de Excel válida (.xlsx).');
  const total = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (total === 0xffff || cdOffset === 0xffffffff) throw new SheetFormatError('La planilla es demasiado grande o usa un formato ZIP no soportado.');
  const entries = new Map();
  let p = cdOffset;
  for (let n = 0; n < total; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new SheetFormatError('El archivo está dañado (no se pudo leer el índice).');
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    entries.set(buf.toString('utf8', p + 46, p + 46 + nameLen), { method, csize, usize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return {
    has: (name) => entries.has(name),
    names: () => [...entries.keys()],
    read(name) {
      const e = entries.get(name);
      if (!e) return null;
      if (e.usize > MAX_ENTRY_BYTES) throw new SheetFormatError('La planilla es demasiado grande.');
      const lo = e.localOffset;
      if (lo + 30 > buf.length || buf.readUInt32LE(lo) !== 0x04034b50) throw new SheetFormatError('El archivo está dañado.');
      const start = lo + 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28);
      const data = buf.subarray(start, start + e.csize);
      if (e.method === 0) return data;
      if (e.method !== 8) throw new SheetFormatError('La planilla usa una compresión no soportada.');
      try { return inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES }); }
      catch { throw new SheetFormatError('El archivo está dañado o es demasiado grande.'); }
    },
  };
}

function writeZip(files) {
  const parts = [], central = [];
  let offset = 0;
  const d = new Date();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8'), raw = Buffer.from(f.data, 'utf8'), comp = deflateRawSync(raw), crc = crc32(raw) >>> 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt16LE(time, 10); lh.writeUInt16LE(date, 12); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(name.length, 26);
    parts.push(lh, name, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(time, 12); ch.writeUInt16LE(date, 14); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

// ---------- XML (lo justo, con expresiones regulares: las planillas son XML simple y sin entidades externas) ----------
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unesc = (s) => s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (m, e) => {
  if (e[0] !== '#') return ENT[e];
  const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
  return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
});
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
const attrsOf = (tag) => {
  const o = {};
  for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) o[m[1]] = unesc(m[2] ?? m[3]);
  return o;
};
// Junta los <t> de una celda de texto (plana o con formato por tramos), sin la fonética japonesa (<rPh>).
const textOf = (inner) => {
  const clean = inner.replace(/<(?:\w+:)?rPh\b[\s\S]*?<\/(?:\w+:)?rPh>/g, '');
  let t = '';
  for (const m of clean.matchAll(/<(?:\w+:)?t\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?t>)/g)) t += unesc(m[1] ?? '');
  return t;
};
const colIndex = (ref) => {
  let n = 0;
  for (const ch of ref.match(/^[A-Za-z]+/)?.[0] ?? '') n = n * 26 + (ch.toUpperCase().charCodeAt(0) - 64);
  return n - 1;
};

function sharedStrings(zip) {
  const raw = zip.read('xl/sharedStrings.xml');
  if (!raw) return [];
  const out = [];
  for (const m of raw.toString('utf8').matchAll(/<(?:\w+:)?si(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?si>)/g)) out.push(textOf(m[1] ?? ''));
  return out;
}

function parseSheetXml(xml, shared) {
  const rows = [];
  let last = 0;
  for (const rm of xml.matchAll(/<(?:\w+:)?row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?row>)/g)) {
    const ra = attrsOf(rm[1]);
    const n = ra.r ? Number(ra.r) : last + 1;
    last = n;
    const cells = [];
    for (const cm of (rm[2] ?? '').matchAll(/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
      const ca = attrsOf(cm[1]);
      const col = ca.r ? colIndex(ca.r) : cells.length;
      const inner = cm[2] ?? '';
      let v = null;
      if (ca.t === 'inlineStr') v = textOf(inner);
      else {
        const vm = inner.match(/<(?:\w+:)?v\b[^>]*>([\s\S]*?)<\/(?:\w+:)?v>/);
        if (vm) {
          const raw = unesc(vm[1]);
          if (ca.t === 's') v = shared[Number(raw)] ?? '';
          else if (ca.t === 'str' || ca.t === 'd') v = raw;
          else if (ca.t === 'b') v = raw === '1';
          else if (ca.t === 'e') v = null; // celda con error (#N/A, #REF!…): se trata como vacía
          else { const num = Number(raw); v = raw !== '' && Number.isFinite(num) ? num : raw; }
        }
      }
      cells[col] = v;
    }
    rows.push({ n, cells });
  }
  return rows;
}

function readXlsx(buf) {
  const zip = readZip(buf);
  if (!zip.has('xl/workbook.xml')) throw new SheetFormatError('El archivo no parece una planilla de Excel (.xlsx).');
  const wb = zip.read('xl/workbook.xml').toString('utf8');
  const relsRaw = zip.read('xl/_rels/workbook.xml.rels')?.toString('utf8') ?? '';
  const rels = {};
  for (const m of relsRaw.matchAll(/<(?:\w+:)?Relationship\b([^>]*?)\/?>/g)) { const a = attrsOf(m[1]); rels[a.Id] = a.Target; }
  const sheets = [...wb.matchAll(/<(?:\w+:)?sheet\b([^>]*?)\/?>/g)].map((m) => attrsOf(m[1])).filter((s) => !/hidden/i.test(s.state ?? ''));
  if (!sheets.length) throw new SheetFormatError('La planilla no tiene hojas visibles.');
  // Se prefiere la hoja «Artículos»; si no existe, la primera visible.
  const plain = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
  const chosen = sheets.find((s) => plain(s.name ?? '') === 'articulos') ?? sheets[0];
  let target = rels[chosen['r:id']] ?? '';
  target = target.startsWith('/') ? target.slice(1) : 'xl/' + target.replace(/^\.\//, '');
  const sheetXml = zip.read(target);
  if (!sheetXml) throw new SheetFormatError(`No se encontró la hoja «${chosen.name}» dentro del archivo.`);
  return { sheetName: chosen.name, rows: parseSheetXml(sheetXml.toString('utf8'), sharedStrings(zip)) };
}

// ---------- CSV ----------
export function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const first = text.split(/\r\n|\n|\r/).find((l) => l.trim()) ?? '';
  const count = (ch) => first.split(ch).length - 1;
  const delim = [';', ',', '\t'].map((d) => [d, count(d)]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [], field = '', quoted = false, n = 1, any = false;
  const endRow = () => { row.push(field); field = ''; if (row.some((c) => c !== '')) rows.push({ n, cells: row }); row = []; n++; any = false; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; } else field += c;
    } else if (c === '"' && field === '') { quoted = true; any = true; }
    else if (c === delim) { row.push(field); field = ''; any = true; }
    else if (c === '\r' || c === '\n') { if (c === '\r' && text[i + 1] === '\n') i++; endRow(); }
    else { field += c; any = true; }
  }
  if (any || field !== '' || row.length) endRow();
  return rows;
}

// ---------- Entrada común: archivo (Buffer) -> filas ----------
// Devuelve { sheetName, rows: [{ n: número de fila, cells: [valores por columna] }] }.
export function readSheet(buf, filename = '') {
  if (!buf?.length) throw new SheetFormatError('El archivo está vacío.');
  if (buf.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) return readXlsx(buf);
  if (buf.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) {
    throw new SheetFormatError('Este archivo es de un Excel antiguo (.xls) o está protegido con contraseña. Abrilo en Excel y guardalo como «Libro de Excel (.xlsx)» sin contraseña.');
  }
  if (buf.subarray(0, 4096).includes(0)) throw new SheetFormatError('Formato no soportado. Usá un archivo Excel (.xlsx) o CSV.');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch { text = new TextDecoder('windows-1252').decode(buf); } // CSV «ANSI» de Excel en Windows
  if (!/\.(csv|txt)$/i.test(filename) && !/[;,\t]/.test(text.slice(0, 2000))) throw new SheetFormatError('Formato no soportado. Usá un archivo Excel (.xlsx) o CSV.');
  return { sheetName: 'CSV', rows: parseCsv(text) };
}

// ---------- Escritura de .xlsx ----------
// sheet: { name, widths: [ancho por columna], colStyles: [estilo por columna], freezeHeader, rows: [[celda]] }
// celda: valor (texto o número) o { v, s } con s = estilo.  Estilos: 0 normal, 1 encabezado, 2 texto, 3 párrafo, 4 título, 5 negrita, 6 importe (#,##0.00), 7 importe en negrita.
export function buildXlsx(sheets) {
  const cellXml = (cell, r, c) => {
    const { v, s = 0 } = cell !== null && typeof cell === 'object' ? cell : { v: cell };
    if (v === null || v === undefined || v === '') return '';
    const ref = (c < 26 ? String.fromCharCode(65 + c) : String.fromCharCode(64 + Math.floor(c / 26)) + String.fromCharCode(65 + (c % 26))) + (r + 1);
    if (typeof v === 'number') return `<c r="${ref}" s="${s}"><v>${v}</v></c>`;
    const text = String(v);
    return `<c r="${ref}" s="${s}" t="inlineStr"><is><t xml:space="preserve">${esc(text)}</t></is></c>`;
  };
  const sheetXml = (sh, i) => {
    const cols = (sh.widths ?? []).map((w, k) => `<col min="${k + 1}" max="${k + 1}" width="${w}" style="${sh.colStyles?.[k] ?? 0}" customWidth="1"/>`).join('');
    const rows = sh.rows.map((row, r) => {
      const ht = r === 0 && sh.freezeHeader ? ' ht="26" customHeight="1"' : '';
      return `<row r="${r + 1}"${ht}>${row.map((cell, c) => cellXml(cell, r, c)).join('')}</row>`;
    }).join('');
    const pane = sh.freezeHeader ? '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' : '';
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"${i === 0 ? ' tabSelected="1"' : ''}>${pane}</sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/>${cols ? `<cols>${cols}</cols>` : ''}<sheetData>${rows}</sheetData></worksheet>`;
  };
  const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const files = [
    { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>` },
    { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
    { name: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="${NS}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: 'xl/styles.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="${NS}"><fonts count="4"><font><sz val="10"/><name val="Arial"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Arial"/></font><font><b/><sz val="10"/><name val="Arial"/></font><font><b/><sz val="13"/><name val="Arial"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF0F766E"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="8"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf><xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf><xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/><xf numFmtId="4" fontId="2" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>` },
    ...sheets.map((sh, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(sh, i) })),
  ];
  return writeZip(files);
}
