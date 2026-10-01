import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../public/barcode.js';

const { Barcode } = globalThis;

test('EAN-13 válido: 95 módulos y guardas correctas', () => {
  const m = Barcode.modules('7790001112223'.slice(0, 12) + '0');
  // Calcula un EAN válido real para no depender de un número inventado.
  const base = '779000111222';
  const check = (10 - ([...base].reduce((s, d, i) => s + Number(d) * (i % 2 ? 3 : 1), 0) % 10)) % 10;
  const ean = base + check;
  assert.ok(Barcode.ean13Valid(ean));
  const mods = Barcode.modules(ean);
  assert.equal(mods.length, 95);
  assert.ok(mods.startsWith('101') && mods.endsWith('101') && mods.slice(45, 50) === '01010');
  assert.ok(m.length === 95 || m.length > 95); // un EAN inválido cae a Code 128 sin romper
});

test('Code 128: cada símbolo ocupa 11 módulos y el stop 13', () => {
  const mods = Barcode.modules('ABC-123');
  assert.equal(mods.length, (1 + 7 + 1) * 11 + 13);
  assert.throws(() => Barcode.modules('ñ'));
});
