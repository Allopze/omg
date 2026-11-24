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

export function leerMeta(logs, tarea) {
  try {
    return JSON.parse(fs.readFileSync(rutaMeta(logs, tarea), 'utf8'));
  } catch {
    return null;
  }
}

export function guardarMeta(logs, tarea, wt, raiz) {
  fs.mkdirSync(logs.worktreesMeta, { recursive: true });
  fs.writeFileSync(rutaMeta(logs, tarea), JSON.stringify({ rama: wt.rama, base: wt.base, raiz, ruta: wt.ruta, excluir: wt.excluir }, null, 2));
}

/** Worktree de una tarea: solo uno registrado en git con la rama delegar/<tarea>. */
export function worktreeDeTarea(raiz, logs, previa) {
  const w = worktreesDelegacion(raiz).find((x) => x.rama === `delegar/${previa.tarea}`);
  if (!w) {
    throw new ErrorOrquestador(
      `El worktree de la tarea ${previa.tarea} ya no existe (¿se limpió o se descartó?). Empieza una tarea nueva sin --continuar.`,
    );
  }
  const meta = leerMeta(logs, previa.tarea) ?? {};
  const base = meta.base ?? previa.primera?.base ?? git(['merge-base', 'HEAD', w.rama], raiz);
  return { ruta: w.ruta, rama: w.rama, base, excluir: meta.excluir ?? [] };
}

export function crearWorktree(registro, raiz, ruta, id) {
  const pendientes = rutasConCambios(raiz);
  if (pendientes.length) {
    process.stderr.write(
      `Aviso: hay ${pendientes.length} cambio(s) sin commit en el repo principal. El worktree parte del último commit y no los incluye.\n`,
    );
  }
  if ((registro.worktrees?.ubicacion ?? 'repo') === 'repo') excluirWorktrees(raiz);
  const base = git(['rev-parse', 'HEAD'], raiz);
  const rama = `delegar/${id}`;
  fs.mkdirSync(path.dirname(ruta), { recursive: true });
  git(['worktree', 'add', '-q', '-b', rama, ruta, base], raiz);
  return { ruta, rama, base, excluir: [] };
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
export async function correrComandos(registro, comandos, { wt, raiz, rutaLog, timeoutMs, confiable = false }) {
  const resultados = [];
  fs.mkdirSync(path.dirname(rutaLog), { recursive: true });
  for (const comando of comandos) {
    let salida = '';
    const capturar = (d) => { salida = (salida + d.toString()).slice(-20000); };
    fs.appendFileSync(rutaLog, `$ ${comando}\n`);
    const tmp = tmpPrivado();
    try {
      const envuelto = envolverEnSandbox(registro, {
        bin: '/bin/sh', args: ['-c', comando], cwd: wt.ruta,
        escribibles: [wt.ruta], protegidas: [path.join(wt.ruta, '.git')], legibles: [raiz],
        credencialesExtra: confiable ? [] : SECRETOS_EXTRA, tmp,
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
      resultados.push({
        comando, codigo: r.codigo, duracion_ms: r.duracion_ms, timeout: r.timeout,
        cola: ultimasLineas(salida, r.codigo === 0 ? 5 : 15), sandbox: envuelto.sandbox,
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  return resultados;
}

/** Deja el worktree como en el último commit, salvo lo que preparar dejó a propósito (wt.excluir). */
export function descartarCambios(wt) {
  const cambios = rutasConCambios(wt.ruta).filter((c) => !wt.excluir.includes(c.ruta));
  const sinSeguimiento = cambios.filter((c) => c.estado === '??').map((c) => c.ruta);
  const versionados = cambios.filter((c) => c.estado !== '??').map((c) => c.ruta);
  for (const r of sinSeguimiento) {
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
