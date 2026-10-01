// Generador de códigos de barras en SVG, sin dependencias.
// EAN-13 para códigos numéricos de 13 dígitos con dígito verificador válido; Code 128 (set B) para cualquier otro.
(() => {
  const L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
  const G = ['0100111', '0110011', '0011011', '0100001', '0011101', '0111001', '0000101', '0010001', '0001001', '0010111'];
  const R = ['1110010', '1100110', '1101100', '1000010', '1011100', '1001110', '1010000', '1000100', '1001000', '1110100'];
  const PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];

  const C128 = ('212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 221312 231212 112232 122132 122231 113222 ' +
    '123122 123221 223211 221132 221231 213212 223112 312131 311222 321122 321221 312212 322112 322211 212123 212321 232121 111323 ' +
    '131123 131321 112313 132113 132311 211313 231113 231311 112133 112331 132131 113123 113321 133121 313121 211331 231131 213113 ' +
    '213311 213131 311123 311321 331121 312113 312311 332111 314111 221411 431111 111224 111422 121124 121421 141122 141221 112214 ' +
    '112412 122114 122411 142112 142211 241211 221114 413111 241112 134111 111242 121142 121241 114212 124112 124211 411212 421112 ' +
    '421211 212141 214121 412121 111143 111341 131141 114113 114311 411113 411311 113141 114131 311141 411131 211412 211214 211232 2331112').split(' ');

  const ean13Valid = (c) => /^\d{13}$/.test(c) &&
    (10 - ([...c.slice(0, 12)].reduce((s, d, i) => s + Number(d) * (i % 2 ? 3 : 1), 0) % 10)) % 10 === Number(c[12]);

  // Devuelve la secuencia de módulos ('1' barra, '0' espacio).
  function modules(code) {
    if (ean13Valid(code)) {
      const p = PARITY[Number(code[0])];
      let m = '101';
      for (let i = 0; i < 6; i++) m += (p[i] === 'L' ? L : G)[Number(code[i + 1])];
      m += '01010';
      for (let i = 7; i < 13; i++) m += R[Number(code[i])];
      return m + '101';
    }
    const vals = [104]; // Start B
    for (const ch of code) {
      const v = ch.charCodeAt(0) - 32;
      if (v < 0 || v > 94) throw new Error(`Carácter no soportado en el código: "${ch}"`);
      vals.push(v);
    }
    vals.push(vals.reduce((s, v, i) => s + (i ? v * i : v), 0) % 103, 106);
    return vals.map((v) => [...C128[v]].map((w, i) => (i % 2 ? '0' : '1').repeat(Number(w))).join('')).join('');
  }

  // SVG que se estira al ancho del contenedor; `height` en CSS (ej. "10mm").
  function svg(code, { height = '10mm' } = {}) {
    const m = modules(String(code));
    const quiet = 10;
    let bars = '';
    for (let i = 0; i < m.length;) {
      if (m[i] === '1') { let j = i; while (m[j] === '1') j++; bars += `<rect x="${i + quiet}" y="0" width="${j - i}" height="1"/>`; i = j; } else i++;
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${m.length + quiet * 2} 1" preserveAspectRatio="none" style="width:100%;height:${height};display:block" shape-rendering="crispEdges"><rect width="100%" height="1" fill="#fff"/>${bars}</svg>`;
  }

  globalThis.Barcode = { svg, modules, ean13Valid };
})();
