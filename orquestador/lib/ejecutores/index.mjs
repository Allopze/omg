// Ejecutores: los CLIs que corren los modelos delegados. Cada adaptador expone la misma interfaz:
//   nombre, etiqueta, versionMinima, instalar
//   bin(registro), config(registro)
//   args(res, skillsAbsolutas) y entrada(prompt): cómo se invoca y qué recibe por stdin
//   lector(res): parser de la salida JSON (o null para texto)
//   estado(): { escritura, protegidas } dentro del sandbox
//   acceso(registro): { modo, etiquetaModo, bloqueo }
//   catalogo(bin), idsCatalogo(id, ficha): para la Fase 0

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

/** Modelos (no retirados) de un ejecutor. */
export function modelosDe(registro, ej) {
  return Object.entries(registro.models).filter(([, f]) => f.estado !== 'retirado' && ejecutorDeFicha(f) === ej.nombre);
}

export function versionEjecutor(ej, bin) {
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 20000 });
  if (r.error) return { instalado: false, error: r.error };
  const version = `${r.stdout ?? ''}${r.stderr ?? ''}`.match(/(\d+\.\d+\.\d+)/)?.[1] ?? null;
  return { instalado: true, version, suficiente: Boolean(version) && compararVersiones(version, ej.versionMinima) >= 0 };
}

/** Argumentos del ejecutor para una delegación resuelta. `opciones.sandbox`: si correrá dentro del sandbox. */
export function construirArgs(res, skillsAbsolutas = [], opciones = {}) {
  return ejecutorDe(res.ejecutor).args(res, skillsAbsolutas, opciones);
}
