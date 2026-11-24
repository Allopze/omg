// Ejecutores: los CLIs que corren los modelos delegados. Cada adaptador expone la misma interfaz:
//   nombre, etiqueta, versionMinima, instalar
//   bin(registro), config(registro)
//   args(res, skillsAbsolutas, opciones) y entrada(prompt): cómo se invoca y qué recibe por stdin
//   lector(res, opts): parser de la salida JSON (o null para texto)
//   estado(): { escritura, protegidas } dentro del sandbox
//   acceso(registro): { modo, etiquetaModo, avisoSettings?, bloqueo }
//   catalogo(bin): { ok, salida, error } y idsCatalogo(id, ficha): para la Fase 0

import { spawnSync } from 'node:child_process';
import { ejecutorDeFicha } from '../registro.mjs';
import { compararVersiones } from '../util.mjs';
import { commandCode } from './command-code.mjs';
import { antigravity } from './antigravity.mjs';

export const EJECUTORES = { command_code: commandCode, antigravity };

export const ejecutorDe = (nombre) => EJECUTORES[nombre ?? 'command_code'];
export const ejecutorDeModelo = (registro, id) => ejecutorDe(ejecutorDeFicha(registro.models[id]));

/** Ejecutores de los modelos que no están retirados. */
export function ejecutoresEnUso(registro) {
  const nombres = Object.values(registro.models).filter((f) => f.estado !== 'retirado').map(ejecutorDeFicha);
  return [...new Set(nombres)].map(ejecutorDe);
}

/** true si algún rol tiene su modelo primario en `ej`. */
export function ejecutorRequerido(registro, ej) {
  return Object.values(registro?.roles ?? {}).some(
    (r) => ejecutorDeFicha(registro?.models?.[r?.primario]) === ej.nombre,
  );
}

/** Modelos (no retirados) de un ejecutor. */
export function modelosDe(registro, ej) {
  return Object.entries(registro.models).filter(([, f]) => f.estado !== 'retirado' && ejecutorDeFicha(f) === ej.nombre);
}

/** true si `clave` aparece como token completo en la salida de catálogo. */
export function catalogoContiene(salida, clave) {
  if (typeof salida !== 'string' || !salida || typeof clave !== 'string' || !clave) return false;
  const esc = clave.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[\\s,;:\\t])${esc}(?:$|[\\s,;:\\t])`, 'm').test(salida);
}

const cacheVersion = new Map();

export function versionEjecutor(ej, bin) {
  const clave = `${ej.nombre}:${bin}`;
  if (cacheVersion.has(clave)) return cacheVersion.get(clave);
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 20000 });
  let res;
  if (r.error) {
    res = { instalado: false, error: r.error };
  } else if (r.status !== 0) {
    res = { instalado: false, error: new Error(r.stderr?.trim() || `${bin} salió con código ${r.status}`) };
  } else {
    const version = `${r.stdout ?? ''}${r.stderr ?? ''}`.match(/(\d+\.\d+\.\d+)/)?.[1] ?? null;
    res = { instalado: true, version, suficiente: Boolean(version) && compararVersiones(version, ej.versionMinima) >= 0 };
  }
  cacheVersion.set(clave, res);
  return res;
}

/** Determina si la salida JSON está activa (explícita o detectada automáticamente en cmd >= 1.0.0). */
export function salidaJsonEfectiva(registro, ej, bin = ej.bin(registro)) {
  if (ej.nombre === 'antigravity' || registro?.command_code?.salida_json === true) {
    return { activo: true, automatico: false, version: null };
  }
  if (registro?.command_code?.salida_json === false) {
    return { activo: false, automatico: false, version: null };
  }
  const v = versionEjecutor(ej, bin);
  if (v.instalado && v.version && compararVersiones(v.version, '1.0.0') >= 0) {
    return { activo: true, automatico: true, version: v.version };
  }
  return { activo: false, automatico: false, version: v.version ?? null };
}

/** Argumentos del ejecutor para una delegación resuelta. `opciones.sandbox`: si correrá dentro del sandbox. */
export function construirArgs(res, skillsAbsolutas = [], opciones = {}) {
  return ejecutorDe(res.ejecutor).args(res, skillsAbsolutas, opciones);
}
