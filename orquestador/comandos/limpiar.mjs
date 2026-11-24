// orq limpiar [--descartar <id|ruta|rama>...] [--resueltas] [--logs] [--simular]
// Elimina worktrees y ramas de delegaciones ya integradas en HEAD (las que no tienen commits no cuentan).
// Con --descartar, elimina una o más delegaciones sin integrar (pierde sus cambios) y marca su tarea como descartada.

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { ErrorOrquestador, SALIDA } from '../lib/registro.mjs';
import { rutasLogs } from '../lib/config.mjs';
import { git, raizRepo, agregarLinea, leerJsonl, rutasConCambios } from '../lib/util.mjs';
import { worktreesDelegacion, ramasDelegacionHuerfanas } from '../lib/worktrees.mjs';
import { leerMeta, borrarMeta } from '../lib/worktree-tarea.mjs';
import { buscarTarea, resumirTareas, tareaDe } from '../lib/tareas.mjs';

export const AYUDA = [
  'Uso: orq limpiar [opciones]',
  '',
  'Elimina worktrees y ramas de delegaciones ya integradas en HEAD.',
  '',
  'Opciones:',
  '  --descartar <id|ruta|rama>  Elimina una o más delegaciones sin integrar (admite repetir o separar por comas)',
  '  --resueltas                 Incluye tareas aprobadas/ajustadas aunque se integraran con squash o rebase',
  '  --logs                      Elimina archivos en logs/salidas/ y logs/worktrees/ de tareas no abiertas',
  '  --simular                   Muestra qué se eliminaría sin aplicar cambios',
  '  -h, --help                  Muestra esta ayuda',
  '',
].join('\n');

const esRutaExcluida = (ruta, excluir) => excluir.some((ex) => {
  const norm = ex.replace(/\/$/, '');
  return ruta === ex || ruta === norm || ruta.startsWith(`${norm}/`);
});

function ramaExiste(raiz, rama) {
  return git(['rev-parse', '--verify', '--quiet', `refs/heads/${rama}`], raiz, { permitirFallo: true }) !== null;
}

function coincideRuta(rutaObjetivo, valor, raiz) {
  if (!rutaObjetivo || !valor) return false;
  const absObj = path.resolve(raiz, rutaObjetivo);
  return absObj === path.resolve(process.cwd(), valor) || absObj === path.resolve(raiz, valor);
}

function resolverObjetivoDescartar(objetivo, { wts, huerfanas, tareasRepo, eventos, raiz, logs }) {
  const wt = wts.find(
    (w) => [w.id, w.rama, w.ruta, w.relativa, w.rutaCorta].includes(objetivo) || coincideRuta(w.ruta, objetivo, raiz),
  );
  if (wt) return { id: wt.id, wt, rama: wt.rama, etiqueta: `${wt.rutaCorta} (${wt.rama})` };

  const huerfana = huerfanas.find((h) => {
    if (h.id === objetivo || h.rama === objetivo) return true;
    const meta = leerMeta(logs, h.id);
    return meta?.ruta ? coincideRuta(meta.ruta, objetivo, raiz) : false;
  });
  if (huerfana) return { id: huerfana.id, wt: null, rama: huerfana.rama, etiqueta: `rama ${huerfana.rama}` };

  const encontrada = buscarTarea(eventos, raiz, objetivo);
  const tareaId = encontrada?.tarea ?? tareasRepo.find((t) => `delegar/${t.tarea}` === objetivo)?.tarea ?? null;
  if (tareaId) {
    const wtPorTarea = wts.find((w) => w.id === tareaId);
    if (wtPorTarea) {
      return { id: wtPorTarea.id, wt: wtPorTarea, rama: wtPorTarea.rama, etiqueta: `${wtPorTarea.rutaCorta} (${wtPorTarea.rama})` };
    }
    const hPorTarea = huerfanas.find((h) => h.id === tareaId);
    if (hPorTarea) return { id: hPorTarea.id, wt: null, rama: hPorTarea.rama, etiqueta: `rama ${hPorTarea.rama}` };
    const t = tareasRepo.find((x) => x.tarea === tareaId);
    if (t && t.estado === 'abierta') {
      const rama = ramaExiste(raiz, `delegar/${t.tarea}`) ? `delegar/${t.tarea}` : null;
      const detalle = rama ? `rama ${rama}` : `tarea ${t.tarea}${!t.ultima?.worktree ? ' (solo lectura)' : ' (sin worktree)'}`;
      return { id: t.tarea, wt: null, rama, etiqueta: detalle };
    }
  }
  return null;
}

function podarLogs(logs, eventos, simular) {
  const tareas = resumirTareas(eventos);
  const abiertas = new Set(tareas.filter((t) => t.estado === 'abierta').map((t) => t.tarea));
  const idsActivos = new Set(abiertas);
  for (const e of eventos) {
    if (e?.tipo === 'delegacion' && typeof e.id === 'string' && abiertas.has(tareaDe(e))) {
      idsActivos.add(e.id);
    }
  }
  if (fs.existsSync(logs.worktreesMeta)) {
    for (const nombre of fs.readdirSync(logs.worktreesMeta)) {
      if (nombre.endsWith('.lock')) idsActivos.add(nombre.slice(0, -'.lock'.length));
    }
  }

  let eliminados = 0;
  if (fs.existsSync(logs.salidas)) {
    for (const nombre of fs.readdirSync(logs.salidas)) {
      const m = nombre.match(/^(.+?)(?:\.(?:preparar|validar))?\.(?:log|prompt\.md)$/);
      if (!m || idsActivos.has(m[1])) continue;
      if (!simular) fs.rmSync(path.join(logs.salidas, nombre), { force: true });
      eliminados++;
    }
  }
  if (fs.existsSync(logs.worktreesMeta)) {
    for (const nombre of fs.readdirSync(logs.worktreesMeta)) {
      if (!nombre.endsWith('.json')) continue;
      const id = nombre.slice(0, -'.json'.length);
      if (idsActivos.has(id)) continue;
      if (!simular) fs.rmSync(path.join(logs.worktreesMeta, nombre), { force: true });
      eliminados++;
    }
  }
  return eliminados;
}

export async function ejecutar(argv = []) {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      descartar: { type: 'string', multiple: true },
      resueltas: { type: 'boolean', default: false },
      logs: { type: 'boolean', default: false },
      simular: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    process.stdout.write(AYUDA);
    return SALIDA.OK;
  }

  const raiz = raizRepo();
  const logs = rutasLogs();
  const accion = values.simular ? 'Se eliminaría' : 'Eliminado';
  if (!values.simular) git(['worktree', 'prune'], raiz, { permitirFallo: true });

  const wts = worktreesDelegacion(raiz);
  const huerfanas = ramasDelegacionHuerfanas(raiz);
  let eventos = leerJsonl(logs.jsonl);
  const tareasRepo = resumirTareas(eventos).filter((t) => t.raiz === raiz);
  const tareaPorId = new Map(tareasRepo.map((t) => [t.tarea, t]));

  if (values.descartar?.length) {
    const objetivosRaw = values.descartar.flatMap((v) => v.split(',')).map((s) => s.trim()).filter(Boolean);
    if (!objetivosRaw.length) {
      throw new ErrorOrquestador('Indica al menos un id, ruta o rama en --descartar.', SALIDA.ERROR_USO);
    }

    const resueltos = [];
    const vistos = new Set();
    for (const obj of objetivosRaw) {
      const r = resolverObjetivoDescartar(obj, { wts, huerfanas, tareasRepo, eventos, raiz, logs });
      if (!r) {
        throw new ErrorOrquestador(
          `No hay un worktree, rama ni tarea abierta "${obj}". Mira la lista con orq estado.`,
          SALIDA.ERROR_USO,
        );
      }
      if (!vistos.has(r.id)) {
        vistos.add(r.id);
        resueltos.push(r);
      }
    }

    for (const r of resueltos) {
      if (!values.simular) {
        if (r.wt) {
          if (fs.existsSync(r.wt.ruta)) git(['worktree', 'remove', '--force', r.wt.ruta], raiz);
          else git(['worktree', 'prune'], raiz, { permitirFallo: true });
        }
        const rama = r.rama ?? (ramaExiste(raiz, `delegar/${r.id}`) ? `delegar/${r.id}` : null);
        if (rama && ramaExiste(raiz, rama)) git(['branch', '-D', rama], raiz);
        borrarMeta(logs, r.id);
        // La tarea deja de figurar como abierta en orq estado y en el scorecard.
        agregarLinea(logs.jsonl, {
          tipo: 'descarte', tarea: r.id, repo: path.basename(raiz), raiz, fecha: new Date().toISOString(),
        });
      }
      process.stdout.write(`${accion} sin integrar: ${r.etiqueta}.\n`);
    }

    if (values.logs) {
      if (!values.simular) eventos = leerJsonl(logs.jsonl);
      const podados = podarLogs(logs, eventos, values.simular);
      process.stdout.write(`${values.simular ? 'Se eliminarían' : 'Logs podados'}: ${podados} archivo(s) en salidas/ y worktrees/.\n`);
    }
    return SALIDA.OK;
  }

  const esObjetivo = (w) => w.integrada || (values.resueltas && tareaPorId.get(w.id)?.estado === 'resuelta');
  const objetivosWt = wts.filter(esObjetivo);
  const errores = [];
  for (const w of objetivosWt) {
    if (values.simular) {
      process.stdout.write(`${accion}: ${w.rutaCorta} (${w.rama})\n`);
      continue;
    }
    if (!fs.existsSync(w.ruta)) {
      git(['worktree', 'remove', '--force', w.ruta], raiz, { permitirFallo: true });
      git(['worktree', 'prune'], raiz, { permitirFallo: true });
    } else if (git(['worktree', 'remove', w.ruta], raiz, { permitirFallo: true }) === null) {
      const excluir = leerMeta(logs, w.id)?.excluir ?? [];
      const cambios = rutasConCambios(w.ruta);
      const soloExcluidos = cambios.length > 0 && cambios.every((c) => esRutaExcluida(c.ruta, excluir));
      if (!soloExcluidos || git(['worktree', 'remove', '--force', w.ruta], raiz, { permitirFallo: true }) === null) {
        errores.push(`${w.rutaCorta}: tiene cambios sin commit; revísalo o usa --descartar ${w.id}`);
        continue;
      }
    }
    if (git(['branch', '-d', w.rama], raiz, { permitirFallo: true }) === null) {
      git(['branch', '-D', w.rama], raiz, { permitirFallo: true });
    }
    borrarMeta(logs, w.id);
    process.stdout.write(`${accion}: ${w.rutaCorta} (${w.rama})\n`);
  }

  const huerfanasActuales = values.simular ? huerfanas : ramasDelegacionHuerfanas(raiz);
  const esHuerfanaObjetivo = (h) => h.integrada || (values.resueltas && tareaPorId.get(h.id)?.estado === 'resuelta');
  let huerfanasLimpiadas = 0;
  let huerfanasPendientes = 0;
  for (const h of huerfanasActuales) {
    if (!esHuerfanaObjetivo(h)) {
      huerfanasPendientes++;
      continue;
    }
    if (!values.simular) {
      if (git(['branch', '-d', h.rama], raiz, { permitirFallo: true }) === null) {
        git(['branch', '-D', h.rama], raiz, { permitirFallo: true });
      }
      borrarMeta(logs, h.id);
    }
    huerfanasLimpiadas++;
    process.stdout.write(`${accion} rama huérfana: ${h.rama}\n`);
  }

  const pendientes = wts.length - objetivosWt.length;
  const extras = [
    huerfanasLimpiadas ? `${huerfanasLimpiadas} rama(s) huérfana(s) ${values.simular ? 'por eliminar' : 'eliminada(s)'}` : null,
    huerfanasPendientes ? `${huerfanasPendientes} rama(s) huérfana(s) sin integrar` : null,
  ].filter(Boolean);
  process.stdout.write(
    `${objetivosWt.length - errores.length} limpiado(s); ${pendientes} sin integrar se mantienen` +
      `${extras.length ? `; ${extras.join('; ')}` : ''}.\n`,
  );

  if (values.logs) {
    const podados = podarLogs(logs, eventos, values.simular);
    process.stdout.write(`${values.simular ? 'Se eliminarían' : 'Logs podados'}: ${podados} archivo(s) en salidas/ y worktrees/.\n`);
  }
  if (errores.length) process.stderr.write(`No se pudo limpiar:\n- ${errores.join('\n- ')}\n`);
  return errores.length ? 1 : SALIDA.OK;
}
