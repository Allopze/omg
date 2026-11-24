// Worktrees de tarea: metadatos, creación, comandos del repo (preparar, validar) dentro del sandbox y limpieza.
// Lo usan `orq delegar` y `orq validar`.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ErrorOrquestador } from './registro.mjs';
import { git, rutasConCambios, excluirWorktrees, ultimasLineas } from './util.mjs';
import { worktreesDelegacion } from './worktrees.mjs';
import { ejecutarProceso } from './proceso.mjs';
import { envolverEnSandbox, entornoSinSecretos, entornoSandbox, SECRETOS_EXTRA } from './sandbox.mjs';

const rutaMeta = (logs, tarea) => path.join(logs.worktreesMeta, `${tarea}.json`);
const rutaLock = (logs, tarea) => path.join(logs.worktreesMeta, `${tarea}.lock`);

function pidVivo(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

export function adquirirLock(logs, tarea) {
  fs.mkdirSync(logs.worktreesMeta, { recursive: true });
  const ruta = rutaLock(logs, tarea);
  const contenido = JSON.stringify({ pid: process.pid, fecha: new Date().toISOString() });
  for (let intento = 0; intento < 3; intento++) {
    try {
      fs.writeFileSync(ruta, contenido, { flag: 'wx' });
      return { ruta, tarea, pid: process.pid };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let existente = null;
      try {
        existente = fs.readFileSync(ruta, 'utf8');
      } catch (err) {
        if (err.code === 'ENOENT') continue;
        throw err;
      }
      let pid = null;
      try {
        pid = JSON.parse(existente).pid;
      } catch {
        const n = Number.parseInt(existente.trim(), 10);
        if (Number.isInteger(n)) pid = n;
      }
      if (pidVivo(pid)) {
        throw new ErrorOrquestador(
          `Ya hay una delegación en curso para la tarea ${tarea} (PID ${pid}). Espera a que termine antes de usar --continuar.`,
        );
      }
      if (!existente) {
        try {
          if (Date.now() - fs.statSync(ruta).mtimeMs < 1000) {
            throw new ErrorOrquestador(
              `Ya hay una delegación en curso para la tarea ${tarea}. Espera a que termine antes de usar --continuar.`,
            );
          }
        } catch (err) {
          if (err instanceof ErrorOrquestador) throw err;
        }
      }
      fs.rmSync(ruta, { force: true });
    }
  }
  throw new ErrorOrquestador(`No se pudo adquirir el lock de la tarea ${tarea} en ${ruta}.`);
}

export function liberarLock(lock) {
  if (!lock) return;
  const ruta = typeof lock === 'string' ? lock : lock.ruta;
  if (!ruta) return;
  try {
    if (typeof lock === 'object' && lock.pid) {
      const actual = JSON.parse(fs.readFileSync(ruta, 'utf8'));
      if (actual.pid !== lock.pid) return;
    }
  } catch { /* si no existe o no es JSON, intentar eliminar igual */ }
  fs.rmSync(ruta, { force: true });
}

export function leerMeta(logs, tarea) {
  try {
    return JSON.parse(fs.readFileSync(rutaMeta(logs, tarea), 'utf8'));
  } catch {
    return null;
  }
}

export function guardarMeta(logs, tarea, wt, raiz) {
  fs.mkdirSync(logs.worktreesMeta, { recursive: true });
  const ruta = rutaMeta(logs, tarea);
  const tmp = `${ruta}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ rama: wt.rama, base: wt.base, raiz, ruta: wt.ruta, excluir: wt.excluir }, null, 2));
    fs.renameSync(tmp, ruta);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

export function borrarMeta(logs, tarea) {
  fs.rmSync(rutaMeta(logs, tarea), { force: true });
}

/** Worktree de una tarea: solo uno registrado en git con la rama delegar/<tarea>. */
export function worktreeDeTarea(raiz, logs, previa) {
  const w = worktreesDelegacion(raiz).find((x) => x.rama === `delegar/${previa.tarea}`);
  if (!w) {
    throw new ErrorOrquestador(
      `El worktree de la tarea ${previa.tarea} ya no existe (¿se limpió o se descartó?). Empieza una tarea nueva sin --continuar.`,
    );
  }
  if (!fs.existsSync(w.ruta)) {
    throw new ErrorOrquestador(
      `La carpeta del worktree de la tarea ${previa.tarea} no existe en ${w.ruta} (¿se borró manualmente?). Límpiala con: orq limpiar --descartar ${previa.tarea}`,
    );
  }
  const meta = leerMeta(logs, previa.tarea) ?? {};
  const base = meta.base ?? previa.primera?.base ?? git(['merge-base', 'HEAD', w.rama], raiz);
  return { ruta: w.ruta, rama: w.rama, base, excluir: meta.excluir ?? [] };
}

export function crearWorktree(registro, raiz, ruta, id) {
  const base = git(['rev-parse', '--verify', 'HEAD'], raiz, { permitirFallo: true });
  if (!base) {
    throw new ErrorOrquestador(
      'El repositorio aún no tiene ningún commit (HEAD no existe). Haz un commit inicial antes de delegar tareas de escritura.',
    );
  }
  const avisos = [];
  const pendientes = rutasConCambios(raiz);
  if (pendientes.length) {
    avisos.push(
      `Hay ${pendientes.length} cambio(s) sin commit en el repo principal. El worktree parte del último commit y no los incluye.`,
    );
  }
  if ((registro.worktrees?.ubicacion ?? 'repo') === 'repo') excluirWorktrees(raiz);
  const rama = `delegar/${id}`;
  fs.mkdirSync(path.dirname(ruta), { recursive: true });
  git(['worktree', 'add', '-q', '-b', rama, ruta, base], raiz);
  return { ruta, rama, base, excluir: [], avisos };
}

/** Temporal propio de una ejecución (va como TMPDIR y es lo único escribible del $TMPDIR del usuario). */
export function tmpPrivado() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orq-sb-'));
}

/**
 * Ejecuta comandos de shell del repo en el worktree, dentro del sandbox y con un temporal propio.
 * - confiable: true (preparar: comandos tuyos sobre el commit base) → entorno completo, p. ej. un NPM_TOKEN
 *   para un registro privado.
 * - confiable: false (validar, o lo que pida Opus con orq validar) → ejecuta código que escribió el agente:
 *   sin secretos en el entorno y sin tokens de registros de paquetes.
 */
export async function correrComandos(registro, comandos, { wt, raiz, rutaLog, timeoutMs, confiable = false, detenerEnFallo = false }) {
  const resultados = [];
  fs.mkdirSync(path.dirname(rutaLog), { recursive: true });
  for (const comando of comandos) {
    let salida = '';
    const capturar = (d) => { salida = (salida + d.toString()).slice(-20000); };
    fs.appendFileSync(rutaLog, `\n=== [${new Date().toISOString()}] $ ${comando} ===\n`);
    const tmp = tmpPrivado();
    try {
      const envuelto = envolverEnSandbox(registro, {
        bin: '/bin/sh', args: ['-c', comando], cwd: wt.ruta,
        escribibles: [wt.ruta], protegidas: [path.join(wt.ruta, '.git')], legibles: [raiz],
        credencialesExtra: confiable ? [] : SECRETOS_EXTRA, tmp, confiable,
      });
      const base = confiable ? process.env : entornoSinSecretos();
      const r = await ejecutarProceso(envuelto.bin, envuelto.args, {
        cwd: wt.ruta,
        env: entornoSandbox({ ...base, TMPDIR: tmp, ORQ_RAIZ: raiz, ORQ_WORKTREE: wt.ruta }, envuelto.sandbox),
        rutaSalida: rutaLog,
        timeoutMs,
        alStdout: capturar,
        alStderr: capturar,
      });
      const interrumpida = r.interrumpida ?? null;
      fs.appendFileSync(
        rutaLog,
        `\n[orq] fin codigo=${r.codigo}${r.timeout ? ' (timeout)' : ''}${interrumpida ? ` (${interrumpida})` : ''} duracion=${(r.duracion_ms / 1000).toFixed(1)}s\n`,
      );
      const resultado = {
        comando, codigo: r.codigo, duracion_ms: r.duracion_ms, timeout: r.timeout, interrumpida,
        cola: ultimasLineas(salida, r.codigo === 0 ? 5 : 15), sandbox: envuelto.sandbox,
      };
      resultados.push(resultado);
      if (interrumpida || (detenerEnFallo && r.codigo !== 0)) break;
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  return resultados;
}

/** Deja el worktree como en el último commit, salvo lo que preparar dejó a propósito (wt.excluir). */
export function descartarCambios(wt) {
  const cambios = rutasConCambios(wt.ruta).filter((c) => !(wt.excluir ?? []).includes(c.ruta));
  const sinSeguimiento = cambios.filter((c) => c.estado === '??').map((c) => c.ruta);
  const agregados = cambios.filter((c) => c.estado[0] === 'A').map((c) => c.ruta);
  const versionados = cambios.filter((c) => c.estado !== '??' && c.estado[0] !== 'A').map((c) => c.ruta);
  if (agregados.length) {
    git(['reset', '-q', 'HEAD', '--', ...agregados.map((r) => `:(literal)${r}`)], wt.ruta, { permitirFallo: true });
  }
  for (const r of [...sinSeguimiento, ...agregados]) {
    fs.rmSync(path.join(wt.ruta, r), { force: true, recursive: true });
    // y las carpetas que quedaron vacías (git no las versiona)
    for (let dir = path.dirname(r.replace(/\/$/, '')); dir !== '.'; dir = path.dirname(dir)) {
      const abs = path.join(wt.ruta, dir);
      if (!fs.existsSync(abs) || fs.readdirSync(abs).length) break;
      fs.rmdirSync(abs);
    }
  }
  if (versionados.length) git(['checkout', 'HEAD', '--', ...versionados.map((r) => `:(literal)${r}`)], wt.ruta, { permitirFallo: true });
  return cambios.map((c) => c.ruta);
}

/** Repos git anidados sin seguimiento en el worktree (git status los muestra como una carpeta "x/"). */
export function reposAnidados(cwd) {
  return rutasConCambios(cwd).filter((c) => c.estado === '??' && c.ruta.endsWith('/')).map((c) => c.ruta);
}

/** Gitlinks (modo 160000) que hay en `hasta` y no en `desde`: submódulos que agregó el agente. */
export function gitlinksNuevos(cwd, desde, hasta) {
  const gitlinks = (ref) => new Set(
    git(['ls-tree', '-r', '-z', ref], cwd, { crudo: true }).split('\0').filter((l) => l.startsWith('160000 ')),
  );
  const antes = gitlinks(desde);
  return [...gitlinks(hasta)].filter((l) => !antes.has(l)).map((l) => l.split('\t')[1]);
}
