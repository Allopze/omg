// Una tarea agrupa los intentos de una misma subtarea: el intento 1 y sus reintentos con --continuar.
// El id de la tarea es el id de su primera delegación, y su rama es delegar/<tarea>.

import path from 'node:path';
import { tokensTotales } from './registro.mjs';

/**
 * Tarea de un evento. Los logs de la 0.2 no tienen `tarea`: ahí los reintentos compartían
 * worktree, cuyo nombre es el id de la primera delegación.
 */
export function tareaDe(e) {
  if (e.tarea) return e.tarea;
  if (e.worktree) return path.basename(e.worktree);
  return e.id;
}

const esAprobado = (r) => r === 'aprobado' || r === 'ajustado';

const esObjeto = (e) => e !== null && typeof e === 'object' && !Array.isArray(e);
const esDelegacion = (e) => esObjeto(e) && e.tipo === 'delegacion' && typeof e.fecha === 'string';

export function mapaRevisiones(eventos) {
  const revision = new Map();
  if (!Array.isArray(eventos)) return revision;
  for (const e of eventos) {
    if (esObjeto(e) && e.tipo === 'revision' && typeof e.id === 'string') revision.set(e.id, e.resultado);
  }
  return revision;
}

/** Busca una tarea del repo por id de tarea, id de delegación o ruta de su worktree. */
export function buscarTarea(eventos, raiz, valor) {
  if (!Array.isArray(eventos) || typeof valor !== 'string' || !valor) return null;
  const delegaciones = eventos.filter((e) => esDelegacion(e) && e.raiz === raiz);
  let d = delegaciones.find((e) => e.id === valor || tareaDe(e) === valor);
  if (!d) {
    const porBase = (base) => {
      const abs = path.resolve(base, valor);
      return delegaciones.find((e) => e.worktree && path.resolve(raiz, e.worktree) === abs);
    };
    d = porBase(process.cwd()) ?? porBase(raiz);
  }
  if (!d) return null;
  const tarea = tareaDe(d);
  const intentos = delegaciones.filter((e) => tareaDe(e) === tarea).sort((a, b) => a.fecha.localeCompare(b.fecha));
  return { tarea, rol: d.rol, intentos, primera: intentos[0], ultima: intentos.at(-1) };
}

/**
 * Resume las tareas a partir de los eventos: intentos, si se resolvió (y en qué intento),
 * si se escaló y cuánto costó en tiempo y tokens de Command Code.
 */
export function resumirTareas(eventos) {
  if (!Array.isArray(eventos)) return [];
  const revision = mapaRevisiones(eventos);
  const delegaciones = eventos.filter(esDelegacion).sort((a, b) => a.fecha.localeCompare(b.fecha));
  const tareas = new Map();
  for (const d of delegaciones) {
    const id = tareaDe(d);
    if (!tareas.has(id)) {
      tareas.set(id, {
        tarea: id, rol: d.rol, repo: d.repo, raiz: d.raiz, fase: d.fase ?? null, inicio: d.fecha,
        intentos: 0, resuelta_en: null, escalada: false, ultima: null, ultima_revision: null,
        duracion_ms: 0, tokens: 0, con_tokens: false,
      });
    }
    const t = tareas.get(id);
    t.intentos++;
    t.ultima = d;
    const rev = revision.get(d.id) ?? null;
    t.ultima_revision = rev;
    t.duracion_ms += d.duracion_ms ?? 0;
    const tokens = tokensTotales(d.uso);
    if (tokens !== null) {
      t.tokens += tokens;
      t.con_tokens = true;
    }
    t.resuelta_en = esAprobado(rev) ? (d.intento ?? t.intentos) : null;
  }
  for (const e of eventos) {
    if (!esObjeto(e)) continue;
    if (e.tipo === 'escalamiento') {
      // Los escalamientos de la 0.2 no tienen `tarea`: se asignan a la última delegación del mismo rol y repo.
      const id = e.tarea ?? (typeof e.fecha === 'string'
        ? delegaciones.filter((d) => d.rol === e.rol && d.raiz === e.raiz && d.fecha <= e.fecha).map(tareaDe).at(-1)
        : undefined);
      const t = tareas.get(id);
      if (t) t.escalada = true;
    } else if (e.tipo === 'descarte') {
      const t = tareas.get(e.tarea);
      if (t) t.descartada = true;
    }
  }
  for (const t of tareas.values()) {
    if (t.resuelta_en !== null) t.estado = 'resuelta';
    else if (t.escalada) t.estado = 'escalada';
    else if (t.descartada) t.estado = 'descartada';
    else t.estado = 'abierta';
  }
  return [...tareas.values()];
}

export { esAprobado };
