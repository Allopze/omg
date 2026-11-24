import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { ErrorOrquestador } from './registro.mjs';

// orq corre git fuera del sandbox, sobre archivos que escribió un agente. Nada de eso puede ejecutar código:
// - hooks y fsmonitor: un agente podría haberlos plantado (git worktree add y commit los dispararían);
// - submódulos: git status entraría en un repo anidado creado por el agente y ejecutaría los filtros de su
//   .git/config (filter.<x>.clean) con tus permisos;
// - firma: con commit.gpgsign, los commits de orq fallarían o firmarían con tu llave el código del agente.
const GIT_SEGURO = [
  '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false',
  '-c', 'diff.ignoreSubmodules=all', '-c', 'status.submoduleSummary=false', '-c', 'submodule.recurse=false',
  '-c', 'commit.gpgsign=false',
];

export function git(args, cwd, { permitirFallo = false, crudo = false } = {}) {
  try {
    const salida = execFileSync('git', [...GIT_SEGURO, ...args], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024,
    });
    return crudo ? salida : salida.trim();
  } catch (e) {
    if (permitirFallo) return null;
    const detalle = (e.stderr || e.message || '').toString().trim();
    throw new ErrorOrquestador(`git ${args.join(' ')} falló: ${detalle}`);
  }
}

/**
 * Raíz del repo. Si estás dentro de un worktree de delegación (rama delegar/*), devuelve el
 * checkout principal, para que una delegación nunca cree worktrees dentro de otro.
 */
export function raizRepo(cwd = process.cwd()) {
  const raiz = git(['rev-parse', '--show-toplevel'], cwd, { permitirFallo: true });
  if (!raiz) throw new ErrorOrquestador('Ejecuta el orquestador dentro de un repositorio git.');
  const rama = git(['symbolic-ref', '-q', '--short', 'HEAD'], raiz, { permitirFallo: true });
  if (!rama?.startsWith('delegar/')) return raiz;
  const lista = git(['worktree', 'list', '--porcelain'], raiz, { permitirFallo: true }) ?? '';
  return lista.match(/^worktree (.+)$/m)?.[1] ?? raiz;
}

/** Agrega .claude/worktrees/ a .git/info/exclude para no tocar el .gitignore del repo. */
export function excluirWorktrees(raiz) {
  const comun = git(['rev-parse', '--git-common-dir'], raiz);
  const exclude = path.join(path.resolve(raiz, comun), 'info', 'exclude');
  const linea = '.claude/worktrees/';
  const actual = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
  if (actual.split('\n').includes(linea)) return false;
  fs.mkdirSync(path.dirname(exclude), { recursive: true });
  fs.appendFileSync(exclude, `${actual && !actual.endsWith('\n') ? '\n' : ''}# orquestador\n${linea}\n`);
  return true;
}

/**
 * Archivos de un `git diff --name-only`, sin detección de renombres (un `git mv` aparece como borrado y
 * alta, así que las alertas ven el origen) y separados por NUL (nombres con tabs o comillas no se citan).
 */
export function archivosDelDiff(args, cwd) {
  const salida = git(['diff', '--name-only', '--no-renames', '--no-ext-diff', '-z', ...args], cwd, { crudo: true });
  return salida.split('\0').filter(Boolean);
}

/**
 * Rutas con cambios (modificadas o sin seguimiento) según git status, sin .claude/worktrees/.
 * Un repo anidado sin seguimiento aparece como una carpeta terminada en "/" (git no entra en él).
 */
export function rutasConCambios(cwd) {
  const salida = git(['status', '--porcelain', '-z', '--untracked-files=all'], cwd, { permitirFallo: true, crudo: true }) ?? '';
  const partes = salida.split('\0');
  const rutas = [];
  for (let i = 0; i < partes.length; i++) {
    const entrada = partes[i];
    if (entrada.length < 4) continue;
    const estado = entrada.slice(0, 2);
    rutas.push({ estado, ruta: entrada.slice(3) });
    if (estado[0] === 'R' || estado[0] === 'C') i++; // el campo siguiente es la ruta de origen
  }
  return rutas.filter((r) => !r.ruta.startsWith('.claude/worktrees/'));
}

export function nuevoId(rol, fecha = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const sello = `${fecha.getFullYear()}${p(fecha.getMonth() + 1)}${p(fecha.getDate())}-${p(fecha.getHours())}${p(fecha.getMinutes())}${p(fecha.getSeconds())}`;
  return `${sello}-${rol}-${crypto.randomBytes(2).toString('hex')}`;
}

export function agregarLinea(rutaJsonl, objeto) {
  fs.mkdirSync(path.dirname(rutaJsonl), { recursive: true });
  fs.appendFileSync(rutaJsonl, `${JSON.stringify(objeto)}\n`);
}

export function leerJsonl(rutaJsonl) {
  if (!fs.existsSync(rutaJsonl)) return [];
  return fs
    .readFileSync(rutaJsonl, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .flatMap((l, i) => {
      try {
        return [JSON.parse(l)];
      } catch {
        process.stderr.write(`Aviso: línea ${i + 1} de ${rutaJsonl} no es JSON válido; se ignora.\n`);
        return [];
      }
    });
}

export function leerStdin() {
  if (process.stdin.isTTY) return '';
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

const LIMITE_HASH = 10 * 1024 * 1024;

/** sha256 de un archivo; null si no existe. Archivos enormes: tamaño y fecha en vez del contenido. */
export function hashArchivo(ruta) {
  let info;
  try {
    info = fs.lstatSync(ruta);
  } catch {
    return null;
  }
  const h = crypto.createHash('sha256');
  if (info.isSymbolicLink()) h.update(`enlace:${fs.readlinkSync(ruta)}`);
  else if (info.isDirectory()) h.update('directorio');
  else if (info.size > LIMITE_HASH) h.update(`grande:${info.size}:${info.mtimeMs}`);
  else h.update(fs.readFileSync(ruta));
  return h.digest('hex');
}

/** Hash del contenido de una carpeta (nombres y archivos, sin recursión); null si no existe. */
export function hashDirectorio(dir) {
  if (!fs.existsSync(dir)) return null;
  const h = crypto.createHash('sha256');
  for (const nombre of fs.readdirSync(dir).sort()) h.update(`${nombre}\0${hashArchivo(path.join(dir, nombre))}\0`);
  return h.digest('hex');
}

/**
 * Hash recursivo de una carpeta; null si no existe. Sin límite de archivos (un archivo plantado no puede
 * esconderse "después" del corte).
 * - contenido: true → sha256 de cada archivo (carpetas chicas);
 * - contenido: false → tamaño y fecha de modificación (carpetas grandes: ~12 mil archivos en ~80 ms).
 * - excluir: nombres de primer nivel que no se recorren (p. ej. logs que escribe el propio orq).
 */
export function hashArbol(dir, { contenido = true, excluir = [] } = {}) {
  if (!fs.existsSync(dir)) return null;
  const h = crypto.createHash('sha256');
  const recorrer = (rel) => {
    let nombres;
    try {
      nombres = fs.readdirSync(path.join(dir, rel)).sort();
    } catch {
      h.update(`?\0${rel}\0`);
      return;
    }
    for (const nombre of nombres) {
      if (!rel && excluir.includes(nombre)) continue;
      const r = path.join(rel, nombre);
      const abs = path.join(dir, r);
      const info = fs.lstatSync(abs);
      if (info.isDirectory()) {
        h.update(`d\0${r}\0`);
        recorrer(r);
      } else if (contenido) h.update(`f\0${r}\0${hashArchivo(abs)}\0`);
      else h.update(`f\0${r}\0${info.size}\0${info.mtimeMs}\0${info.isSymbolicLink() ? fs.readlinkSync(abs) : ''}\0`);
    }
  };
  recorrer('');
  return h.digest('hex');
}

/** true si `bin` es una ruta existente o un comando que está en el PATH. */
export function binDisponible(bin) {
  if (bin.includes(path.sep)) return fs.existsSync(bin);
  return (process.env.PATH ?? '').split(path.delimiter).some((d) => d && fs.existsSync(path.join(d, bin)));
}

/** Compara versiones tipo "1.2.3"; devuelve -1, 0 o 1. */
export function compararVersiones(a, b) {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** Últimas `n` líneas no vacías de un texto. */
export function ultimasLineas(texto, n = 15) {
  return texto.split('\n').map((l) => l.trimEnd()).filter(Boolean).slice(-n);
}
