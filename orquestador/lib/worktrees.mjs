import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { git } from './util.mjs';
import { rutasLogs } from './config.mjs';

function corto(p) {
  for (const base of [os.homedir(), (() => { try { return fs.realpathSync(os.homedir()); } catch { return null; } })()]) {
    if (!base) continue;
    if (p === base) return '~';
    if (base !== path.sep && p.startsWith(`${base}${path.sep}`)) return `~${p.slice(base.length)}`;
  }
  return p;
}

/** Commit base de un worktree de delegación (lo guarda delegar en logs/worktrees/<id>.json). */
function baseDe(id) {
  try {
    return JSON.parse(fs.readFileSync(path.join(rutasLogs().worktreesMeta, `${id}.json`), 'utf8')).base ?? null;
  } catch {
    return null;
  }
}

function estaIntegrada(raiz, rama, sinCommits) {
  if (sinCommits) return false;
  if (git(['merge-base', '--is-ancestor', rama, 'HEAD'], raiz, { permitirFallo: true }) !== null) return true;
  const cherry = git(['cherry', 'HEAD', rama], raiz, { permitirFallo: true });
  if (cherry) {
    const lineas = cherry.split('\n').filter((l) => l.trim());
    if (lineas.length && lineas.every((l) => l.startsWith('- '))) return true;
  }
  const treeHead = git(['rev-parse', 'HEAD^{tree}'], raiz, { permitirFallo: true });
  const merged = treeHead ? git(['merge-tree', '--write-tree', 'HEAD', rama], raiz, { permitirFallo: true }) : null;
  if (treeHead && merged && merged.split('\n')[0].trim() === treeHead) return true;
  return false;
}

function estadoRama(raiz, rama, id) {
  const base = baseDe(id);
  const punta = git(['rev-parse', rama], raiz, { permitirFallo: true });
  // Sin el archivo de la base (worktrees muy antiguos), se reconoce por el commit que hace orq.
  const sinCommits = base
    ? punta === base
    : !(git(['log', '-1', '--format=%s', rama], raiz, { permitirFallo: true }) ?? '').startsWith('delegar(');
  return { integrada: estaIntegrada(raiz, rama, sinCommits), sinCommits };
}

/**
 * Worktrees de delegaciones (ramas delegar/*) del repo, con su estado:
 * - sinCommits: la rama no tiene commits propios (un intento sin cambios). Para git es "ancestro" de HEAD,
 *   pero no hay nada integrado: la tarea sigue abierta y `orq limpiar` no la toca.
 * - integrada: tiene commits propios y ya están en HEAD (por merge, cherry-pick/rebase o squash merge).
 */
export function worktreesDelegacion(raiz) {
  const salida = git(['worktree', 'list', '--porcelain'], raiz, { permitirFallo: true }) ?? '';
  const lista = [];
  for (const bloque of salida.split('\n\n')) {
    const ruta = bloque.match(/^worktree (.+)$/m)?.[1];
    const rama = bloque.match(/^branch refs\/heads\/(.+)$/m)?.[1];
    if (!ruta || !rama?.startsWith('delegar/')) continue;
    const id = rama.slice('delegar/'.length);
    const { integrada, sinCommits } = estadoRama(raiz, rama, id);
    const ultimo = git(['log', '-1', '--format=%cr', rama], raiz, { permitirFallo: true }) ?? '';
    const relativa = path.relative(raiz, ruta);
    const rutaCorta = relativa.startsWith('..') ? corto(ruta) : relativa;
    lista.push({ ruta, rama, id, integrada, sinCommits, ultimo, relativa, rutaCorta });
  }
  return lista;
}

/** Ramas `delegar/*` que ya no tienen un worktree activo en `git worktree list`. */
export function ramasDelegacionHuerfanas(raiz) {
  const salida = git(['worktree', 'list', '--porcelain'], raiz, { permitirFallo: true }) ?? '';
  const activas = new Set();
  for (const bloque of salida.split('\n\n')) {
    const rama = bloque.match(/^branch refs\/heads\/(.+)$/m)?.[1];
    if (rama?.startsWith('delegar/')) activas.add(rama);
  }
  const ramas = (git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/delegar/'], raiz, { permitirFallo: true }) ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return ramas
    .filter((rama) => !activas.has(rama))
    .map((rama) => {
      const id = rama.slice('delegar/'.length);
      const { integrada, sinCommits } = estadoRama(raiz, rama, id);
      return { rama, id, integrada, sinCommits };
    });
}
