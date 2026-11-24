// Comprobaciones antes y después de cada delegación: lo que Command Code no debería haber tocado.
//
// Fase 1, solo sistema de archivos: configuración de git, hooks, permisos de Claude Code, registro,
// configuración de Command Code y de Antigravity/Gemini, skills globales y archivos de shell. Si cambió
// la configuración de git, no se vuelve a ejecutar git (un filtro o textconv plantado se ejecutaría
// fuera del sandbox).
// Fase 2, con git: el checkout principal y la rama del worktree.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { git, hashArchivo, hashDirectorio, hashArbol, rutasConCambios } from './util.mjs';
import { dirConfigClaude, RUTA_REGISTRO, ARCHIVO_REPO, RAIZ_ORQ } from './config.mjs';
import { rutaSettingsAgy } from './ejecutores/antigravity.mjs';

const corto = (p) => (p.startsWith(os.homedir()) ? `~${p.slice(os.homedir().length)}` : p);

/** Ruta del comando en el PATH (el shim de orq), o null. */
function enPath(nombre) {
  for (const d of (process.env.PATH ?? '').split(path.delimiter)) {
    if (d && fs.existsSync(path.join(d, nombre))) return path.join(d, nombre);
  }
  return null;
}

/**
 * Lo que un modelo delegado nunca debería cambiar. Con sandbox casi nada de esto es escribible; la huella
 * es la red de seguridad cuando no hay sandbox (o para rutas que bwrap no puede proteger si no existen).
 * Tipos: archivo, dir (sin recursión), arbol (contenido) y meta (árbol por tamaño y fecha, para carpetas grandes).
 */
function rutasProtegidas(raiz, wt) {
  const home = os.homedir();
  const gemini = path.join(home, '.gemini');
  const cc = path.join(home, '.commandcode');
  const comun = path.resolve(raiz, git(['rev-parse', '--git-common-dir'], raiz));
  const claude = dirConfigClaude();
  const shim = enPath('orq');
  return [
    // Configuración de git: si cambia, orq no vuelve a ejecutar git.
    ...[path.join(comun, 'config'), path.join(home, '.gitconfig'), path.join(home, '.config', 'git', 'config'),
      ...(wt ? [path.join(wt, '.git')] : [])].map((ruta) => ({ ruta, git: true, tipo: 'archivo' })),
    { ruta: path.join(comun, 'hooks'), git: true, tipo: 'dir' },
    ...[
      // Claude Code: permisos e instrucciones globales; permisos y ajustes del repo; el registro de orq.
      path.join(claude, 'settings.json'), path.join(claude, 'settings.local.json'), path.join(claude, 'CLAUDE.md'), RUTA_REGISTRO,
      path.join(raiz, '.claude', 'settings.json'), path.join(raiz, '.claude', 'settings.local.json'), path.join(raiz, ARCHIVO_REPO),
      // Command Code: configuración, instrucciones y confianza en hooks de proyecto.
      ...['settings.json', 'settings.local.json', 'AGENTS.md', 'mcp.json', 'trusted-hooks.json'].map((n) => path.join(cc, n)),
      // Antigravity y Gemini: permisos y proveedor de agy, instrucciones globales, hooks y MCP.
      rutaSettingsAgy(), path.join(gemini, 'settings.json'), path.join(gemini, 'GEMINI.md'),
      ...['config.json', 'hooks.json', 'mcp_config.json'].map((n) => path.join(gemini, 'config', n)),
      // Archivos de shell y el comando orq.
      ...['.zshrc', '.zprofile', '.bashrc', '.bash_profile', '.profile', '.config/fish/config.fish'].map((n) => path.join(home, n)),
      ...(shim ? [shim] : []),
    ].map((ruta) => ({ ruta, git: false, tipo: 'archivo' })),
    // Instrucciones, scripts y binarios que otra sesión ejecutaría o leería después.
    ...[
      path.join(gemini, 'skills'), path.join(gemini, 'config', 'skills'), path.join(gemini, 'antigravity-cli', 'skills'),
      path.join(gemini, 'antigravity-cli', 'bin'), path.join(gemini, 'antigravity', 'bin'),
      ...['taste', 'scripts', '.cc-global-pack'].map((n) => path.join(cc, n)),
    ].map((ruta) => ({ ruta, git: false, tipo: 'arbol' })),
    // Carpetas grandes (las skills de Claude Code pueden ser miles de archivos) y el código del orquestador.
    ...[
      ...['skills', 'agents', 'commands', 'plugins'].map((n) => path.join(claude, n)),
      ...['hooks', 'agents', 'commands', 'skills'].map((n) => path.join(cc, n)),
    ].map((ruta) => ({ ruta, git: false, tipo: 'meta' })),
    { ruta: RAIZ_ORQ, git: false, tipo: 'meta', excluir: ['logs', 'models.yaml', 'models.yaml.nuevo', 'models.yaml.anterior'] },
  ];
}

function hashDe(e) {
  if (e.tipo === 'arbol') return hashArbol(e.ruta);
  if (e.tipo === 'meta') return hashArbol(e.ruta, { contenido: false, excluir: e.excluir ?? [] });
  if (e.tipo === 'dir') return hashDirectorio(e.ruta);
  return hashArchivo(e.ruta);
}

/** Huella del sistema de archivos protegido. Se toma antes de ejecutar el modelo delegado. */
export function huellaArchivos(raiz, wt) {
  return releerHuellaArchivos({ entradas: rutasProtegidas(raiz, wt) });
}

export function releerHuellaArchivos(antes) {
  return { entradas: antes.entradas.map((e) => ({ ...e, hash: hashDe(e) })) };
}

/** Huella con git del checkout principal y de la rama del worktree. */
export function huellaGit(raiz, wt) {
  const cambios = rutasConCambios(raiz);
  const h = crypto.createHash('sha256');
  h.update(git(['diff', 'HEAD', '--no-ext-diff', '--no-textconv', '--binary'], raiz, { permitirFallo: true }) ?? '');
  for (const c of cambios) if (c.estado === '??') h.update(`${c.ruta}\0${hashArchivo(path.join(raiz, c.ruta))}\0`);
  return {
    principal: {
      head: git(['rev-parse', 'HEAD'], raiz, { permitirFallo: true }),
      rama: git(['symbolic-ref', '-q', '--short', 'HEAD'], raiz, { permitirFallo: true }),
      rutas: cambios.map((c) => c.ruta),
      contenido: h.digest('hex'),
    },
    worktree: wt ? {
      head: git(['rev-parse', 'HEAD'], wt, { permitirFallo: true }),
      rama: git(['symbolic-ref', '-q', '--short', 'HEAD'], wt, { permitirFallo: true }),
    } : null,
  };
}

/** Compara la fase de archivos. `gitComprometido` indica que no se debe volver a ejecutar git. */
export function compararArchivos(antes, despues) {
  const criticas = [];
  let gitComprometido = false;
  despues.entradas.forEach((e, i) => {
    if (e.hash === antes.entradas[i].hash) return;
    criticas.push(`Se modificó ${corto(e.ruta)}${e.git ? ' (configuración de git: no se ejecutó git add ni commit)' : ''}.`);
    if (e.git) gitComprometido = true;
  });
  return { criticas, gitComprometido };
}

/**
 * Compara la fase de git. Cambios en el checkout principal son alerta (podrías estar editando tú);
 * mover el HEAD principal o cambiar la rama del worktree es crítico.
 */
export function compararGit(antes, despues, { ramaEsperada, soloLectura }) {
  const criticas = [];
  const alertas = [];
  const p0 = antes.principal;
  const p1 = despues.principal;
  if (p0.head !== p1.head || p0.rama !== p1.rama) {
    criticas.push(`El checkout principal cambió de commit o de rama (${p0.rama ?? p0.head?.slice(0, 12)} → ${p1.rama ?? p1.head?.slice(0, 12)}).`);
  } else if (p0.contenido !== p1.contenido) {
    const nuevas = p1.rutas.filter((r) => !p0.rutas.includes(r));
    const detalle = nuevas.length ? nuevas.join(', ') : 'archivos que ya tenían cambios sin commit';
    alertas.push(soloLectura
      ? `Rol de solo lectura pero cambió el repo: ${detalle}.`
      : `Cambió el checkout principal mientras corría la delegación: ${detalle}. Si no fuiste tú, Command Code escribió fuera de su worktree.`);
  }
  let ramaCambiada = false;
  if (antes.worktree) {
    if (despues.worktree.rama !== ramaEsperada) {
      ramaCambiada = true;
      criticas.push(`La rama del worktree cambió a "${despues.worktree.rama ?? 'HEAD separado'}" (se esperaba ${ramaEsperada}): no se hizo commit.`);
    } else if (despues.worktree.head !== antes.worktree.head) {
      alertas.push('Command Code hizo commits propios en la rama del worktree (se incluyen en el diff).');
    }
  }
  return { criticas, alertas, ramaCambiada };
}
