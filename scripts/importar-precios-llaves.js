#!/usr/bin/env node
/**
 * scripts/importar-precios-llaves.js — Importa el Excel de precios de llaves
 * de vehículo del cliente (exportado a CSV) a server/data/precios-llaves.json.
 *
 * Uso:
 *   node scripts/importar-precios-llaves.js "/ruta/PRECIOS - TU CERRAJERO PR.xlsx - Pricing Data.csv"
 *
 * Columnas esperadas: make, model, year, key_type, service_type, PRECIO A,
 * PRECIO B, PRECIO C, (nota), (nota).
 *
 *  - Filas "de tabla" (service_type Spare / Programming / Replacement y un
 *    key_type estándar): solo traen PRECIO A con decimales → se redondea a
 *    dólares enteros. Precio fijo, sin rebaja.
 *  - Filas "manuales" (las que el cliente escribió a mano al principio del
 *    Excel, con rangos de años y PRECIO B/C): tienen prioridad sobre la tabla.
 *    A = precio que se dice, B = intermedio, C = lo más bajo que se puede dejar.
 *  - Todo lo demás (filas sueltas con otro formato) se excluye y se lista en
 *    el JSON para confirmarlo con el cliente.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const SALIDA = path.join(__dirname, '../server/data/precios-llaves.json');

// ── CSV mínimo (soporta comillas) ────────────────────────────────────────────
function parseCSV(texto) {
  const filas = [];
  let fila = [], campo = '', comillas = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (comillas) {
      if (c === '"' && texto[i + 1] === '"') { campo += '"'; i++; }
      else if (c === '"') comillas = false;
      else campo += c;
    } else if (c === '"') comillas = true;
    else if (c === ',') { fila.push(campo); campo = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && texto[i + 1] === '\n') i++;
      fila.push(campo); filas.push(fila); fila = []; campo = '';
    } else campo += c;
  }
  if (campo || fila.length) { fila.push(campo); filas.push(fila); }
  return filas;
}

const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]/g, '');

// ── Tipos de llave canónicos ─────────────────────────────────────────────────
const TIPOS_TABLA = {
  'smart key':        'smart',
  'proximity key':    'proximity',
  'advanced key':     'advanced',
  'transponder key':  'transponder',
  'remote key':       'remote',
  'fobik key':        'fobik',
  'key card':         'tesla_tarjeta',
  'phone key':        'tesla_telefono',
  'mobile connector': 'tesla_conector',
  'key fob':          'tesla_control',
};

function tipoManual(keyType) {
  const k = keyType.toLowerCase();
  if (k.includes('flip'))        return 'flip';
  if (k.includes('proximity'))   return 'proximity';
  if (k.includes('smart'))       return 'smart';
  if (k.includes('transponder') || k.includes('blade key con chip')) return 'transponder';
  if (k.includes('remote'))      return 'remote';
  return null;
}

/** Servicio manual → { servicio, etiqueta } (null si no se reconoce). */
function servicioManual(serviceType, keyType) {
  const s = serviceType.trim();
  const etiquetas = [];
  const b = s.match(/(\d)\s*B\b/i);
  if (b) etiquetas.push(b[1] === '4' ? 'de 4 botones con arranque remoto' : `de ${b[1]} botones`);
  if (/aftermarket/i.test(s)) etiquetas.push('aftermarket (no original)');
  if (/OEM/.test(s) && !/aftermarket/i.test(s)) etiquetas.push('original');
  if (/blade key con chip/i.test(keyType)) etiquetas.push('y el control aparte');
  const etiqueta = etiquetas.join(', ');

  if (/AKL|ALL KEYS LOST|aftermarket|solo se menciona/i.test(s)) return { servicio: 'todas_perdidas', etiqueta };
  if (/^REMOTE\s*4B$/i.test(s))                                  return { servicio: 'todas_perdidas', etiqueta };
  if (/spare|cut/i.test(s))                                      return { servicio: 'copia', etiqueta };
  if (/programming/i.test(s))                                    return { servicio: 'programar', etiqueta };
  return null;
}

const SERVICIOS_TABLA = { Replacement: 0, Spare: 1, Programming: 2 }; // → [todas_perdidas, copia, programar]

/** "98-2004" / "2005-14" / "14-20" / "2021" → [desde, hasta] */
function rangoAnios(txt) {
  const a4 = n => (n.length <= 2 ? (Number(n) < 50 ? 2000 : 1900) + Number(n) : Number(n));
  const m = String(txt).trim().match(/^(\d{2,4})\s*-\s*(\d{2,4})$/);
  if (m) return [a4(m[1]), a4(m[2])];
  const u = String(txt).trim().match(/^(\d{2,4})$/);
  return u ? [a4(u[1]), a4(u[1])] : null;
}

/** "395---CASOS ***" → { valor: 395, nota: 'solo casos puntuales' } */
function precio(txt) {
  const t = String(txt || '').trim();
  const m = t.match(/^\$?\s*(\d+(?:\.\d+)?)/);
  if (!m) return { valor: null, nota: '' };
  return { valor: Math.round(Number(m[1])), nota: /\*|casos/i.test(t) ? 'el precio mínimo es solo para casos puntuales' : '' };
}

// ── Main ─────────────────────────────────────────────────────────────────────
function main() {
  const archivo = process.argv[2];
  if (!archivo) {
    console.error('Uso: node scripts/importar-precios-llaves.js "<ruta del CSV>"');
    process.exit(1);
  }
  const filas = parseCSV(fs.readFileSync(archivo, 'utf8').replace(/^﻿/, ''));
  const [, ...datos] = filas;

  const tabla     = {};   // marca → modelo → año → tipo → [todas_perdidas, copia, programar]
  const nombres   = {};   // claves normalizadas → nombre legible
  const manuales  = [];
  const excluidas = [];

  datos.forEach((f, i) => {
    const fila = i + 2;
    const [make = '', model = '', year = '', keyType = '', serviceType = '', pa = '', pb = '', pc = '', n1 = '', n2 = ''] = f;
    if (!make.trim() && !model.trim()) return;

    const tipoTabla = TIPOS_TABLA[keyType.trim().toLowerCase()];
    const idxServ   = SERVICIOS_TABLA[serviceType.trim()];
    const esTabla   = tipoTabla && idxServ !== undefined && /^\d{4}$/.test(year.trim())
      && !pb.trim() && !pc.trim() && make.trim() === make.trim().replace(/^[a-z]/, c => c.toUpperCase());

    if (esTabla) {
      const a = precio(pa).valor;
      if (a == null) { excluidas.push({ fila, motivo: 'sin PRECIO A', datos: f.slice(0, 6).join(' | ') }); return; }
      const mk = norm(make), md = norm(model);
      nombres[mk] = make.trim();
      nombres[`${mk}|${md}`] = model.trim();
      const porAnio = ((tabla[mk] ??= {})[md] ??= {})[year.trim()] ??= {};
      (porAnio[tipoTabla] ??= [null, null, null])[idxServ] = a;
      return;
    }

    // ¿Fila manual del cliente? (rango de años o precios B/C, service/key reconocibles)
    const tipo  = tipoManual(keyType);
    const serv  = servicioManual(serviceType, keyType);
    const anios = rangoAnios(year);
    const A = precio(pa), B = precio(pb), C = precio(pc);
    const esManual = tipo && serv && anios && A.valor != null
      && (B.valor != null || /-/.test(year) || /aftermarket|OEM|solo se menciona|CUT|4B|3B/i.test(serviceType));

    if (esManual) {
      const modelos = /^all$/i.test(model.trim()) ? null : model.split('/').map(norm).filter(Boolean);
      const notas = [A.nota, B.nota, C.nota].filter(Boolean);
      if (/angel/i.test(n1 + n2)) notas.push('el cerrajero confirma el precio final');
      manuales.push({
        fila,
        marca: norm(make),
        modelos,
        desde: anios[0],
        hasta: anios[1],
        tipo,
        servicio: serv.servicio,
        etiqueta: serv.etiqueta,
        a: A.valor,
        b: B.valor,
        c: C.valor,
        nota: [...new Set(notas)].join('; '),
        original: f.slice(0, 10).filter(Boolean).join(' | '),
      });
      return;
    }

    excluidas.push({
      fila,
      motivo: A.valor == null ? 'sin precio' : 'formato distinto a la tabla y a las filas manuales — confirmar con el cliente',
      datos: f.slice(0, 10).filter(Boolean).join(' | '),
    });
  });

  const salida = {
    fuente: path.basename(archivo),
    generado: new Date().toISOString(),
    servicios: ['todas_perdidas', 'copia', 'programar'],
    nombres,
    tabla,
    manuales,
    excluidas,
  };
  fs.writeFileSync(SALIDA, JSON.stringify(salida));

  const vehiculos = Object.values(tabla).reduce((n, mods) => n + Object.values(mods).reduce((m, a) => m + Object.keys(a).length, 0), 0);
  console.log(`✅ ${path.relative(process.cwd(), SALIDA)}`);
  console.log(`   Marcas: ${Object.keys(tabla).length} | vehículos (marca+modelo+año): ${vehiculos}`);
  console.log(`   Filas manuales (A/B/C del cliente): ${manuales.length}`);
  console.log(`   Filas excluidas: ${excluidas.length}`);
}

main();
