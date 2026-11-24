import fs from 'node:fs';
import path from 'node:path';
import { git } from './util.mjs';
import { rutasLogs } from './config.mjs';

/** Commit base de un worktree de delegación (lo guarda delegar en logs/worktrees/<id>.json). */
function baseDe(id) {
  try {
    return JSON.parse(fs.readFileSync(path.join(rutasLogs().worktreesMeta, `${id}.json`), 'utf8')).base ?? null;
  } catch {
    return null;
  }
}

/**
 * Worktrees de delegaciones (ramas delegar/*) del repo, con su estado:
 * - sinCommits: la rama no tiene commits propios (un intento sin cambios). Para git es "ancestro" de HEAD,
 *   pero no hay nada integrado: la tarea sigue abierta y `orq limpiar` no la toca.
 * - integrada: tiene commits propios y ya están en HEAD.
 */
export function worktreesDelegacion(raiz) {
  const salida = git(['worktree', 'list', '--porcelain'], raiz, { permitirFallo: true }) ?? '';
  const lista = [];
  for (const bloque of salida.split('\n\n')) {
    const ruta = bloque.match(/^worktree (.+)$/m)?.[1];
    const rama = bloque.match(/^branch refs\/heads\/(.+)$/m)?.[1];
    if (!ruta || !rama?.startsWith('delegar/')) continue;
    const id = rama.slice('delegar/'.length);
    const base = baseDe(id);
    const punta = git(['rev-parse', rama], raiz, { permitirFallo: true });
    // Sin el archivo de la base (worktrees muy antiguos), se reconoce por el commit que hace orq.
    const sinCommits = base
      ? punta === base
      : !(git(['log', '-1', '--format=%s', rama], raiz, { permitirFallo: true }) ?? '').startsWith('delegar(');
    const integrada = !sinCommits && git(['merge-base', '--is-ancestor', rama, 'HEAD'], raiz, { permitirFallo: true }) !== null;
    const ultimo = git(['log', '-1', '--format=%cr', rama], raiz, { permitirFallo: true }) ?? '';
    lista.push({ ruta, rama, id, integrada, sinCommits, ultimo, relativa: path.relative(raiz, ruta) });
  }
  return lista;
}
