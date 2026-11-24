// Sandbox del sistema operativo para Command Code y para los comandos preparar/validar.
//
// macOS: sandbox-exec con un perfil SBPL. Linux: bubblewrap (bwrap). Otros: sin sandbox.
// Política: escritura solo en el worktree, en temporales, en cachés de paquetes y en la carpeta de estado
// del ejecutor (~/.commandcode o ~/.gemini/antigravity-cli, que aporta cada adaptador en lib/ejecutores/);
// sin lectura de credenciales; .git del worktree y la configuración del ejecutor protegidos.
// La red queda abierta: el ejecutor la necesita para hablar con el modelo.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ErrorOrquestador, SALIDA, seccionSandbox } from './registro.mjs';
import { expandirHome, dirConfigClaude, DIR_DATOS, RAIZ_ORQ } from './config.mjs';

/** Shims de macOS que desactivan el sandbox-exec anidado de xcodebuild y swift dentro del sandbox de orq. */
export const DIR_SHIMS_MACOS = path.join(RAIZ_ORQ, 'lib', 'shims-macos');

/** Rutas con escritura además del worktree, los temporales y el estado del ejecutor. */
export const ESCRITURA_BASE = [
  '~/.npm', '~/.pnpm-store', '~/Library/pnpm/store', '~/.local/share/pnpm/store',
  '~/.yarn/berry/cache', '~/.bun/install/cache',
  '~/.cache', '~/Library/Caches', '~/Library/Developer/Xcode/DerivedData',
  '~/Library/Developer/CoreSimulator', '~/Library/Logs/CoreSimulator',
  '~/.cargo/registry', '~/.cargo/git', '~/.cargo/.package-cache',
  '~/go/pkg/mod', '~/.gradle/caches', '~/.gradle/daemon', '~/.gradle/wrapper',
  '~/.m2/repository', '~/.swiftpm',
];

/** Credenciales que nunca se pueden leer desde el sandbox. */
export const LECTURA_DENEGADA_BASE = [
  '~/.ssh', '~/.aws', '~/.gnupg', '~/.azure', '~/.kube', '~/.config/gh', '~/.config/gcloud',
  '~/.docker/config.json', '~/.netrc', '~/.git-credentials', '~/.config/git/credentials',
];

/**
 * Tokens de registros de paquetes y gestores de secretos: se ocultan al modelo delegado y a `validar`
 * (que ejecuta su código), no a `preparar` (comandos tuyos, como un npm ci contra un registro privado).
 */
export const SECRETOS_EXTRA = [
  '~/.npmrc', '~/.yarnrc.yml', '~/.pypirc', '~/.cargo/credentials', '~/.cargo/credentials.toml', '~/.config/hub',
  '~/.terraform.d/credentials.tfrc.json', '~/.vault-token', '~/.config/op', '~/.password-store', '~/.local/share/keyrings',
];

const VARIABLES_FIJAS = ['SSH_AUTH_SOCK', 'SSH_AGENT_PID', 'GPG_AGENT_INFO', 'GIT_ASKPASS', 'SSH_ASKPASS', 'SUDO_ASKPASS'];
const VARIABLE_SECRETA = /(TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|API_?KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL|_AUTH)/i;

/**
 * Entorno para el modelo delegado y `validar`: sin agentes de SSH/GPG ni variables con pinta de secreto
 * (GH_TOKEN, AWS_*, ANTHROPIC_API_KEY, NPM_TOKEN…), salvo las que el ejecutor necesita (`conservar`).
 */
export function entornoSinSecretos(conservar = [], base = process.env) {
  const env = { ...base };
  for (const k of Object.keys(env)) {
    if (conservar.some((re) => re.test(k))) continue;
    if (VARIABLES_FIJAS.includes(k) || k.startsWith('AWS_') || VARIABLE_SECRETA.test(k)) delete env[k];
  }
  return env;
}

export function configSandbox(registro) {
  const sb = seccionSandbox(registro) ?? {};
  return {
    modo: sb.modo ?? 'auto',
    escritura_extra: sb.escritura_extra ?? [],
    lectura_denegada: sb.lectura_denegada ?? [],
    lectura_extra: sb.lectura_extra ?? [],
    preparar_con_credenciales: sb.preparar_con_credenciales === true,
  };
}

let cacheDarwinDirs = null;

/**
 * Carpetas per-usuario de Darwin (DARWIN_USER_TEMP_DIR y DARWIN_USER_CACHE_DIR, /var/folders/.../T y .../C).
 * En macOS, Apple Foundation (NSItemReplacementDirectory), CoreData, actool, ibtoold, xcrun y xcodebuild
 * ignoran $TMPDIR y escriben directo ahí.
 */
export function darwinDirs(plataforma = process.platform) {
  if (plataforma !== 'darwin') return { tmp: null, cache: null };
  if (cacheDarwinDirs) return cacheDarwinDirs;
  const leer = (clave) => {
    const r = spawnSync('getconf', [clave], { encoding: 'utf8', timeout: 5000 });
    const v = r.status === 0 ? r.stdout.trim() : '';
    return v ? rutaReal(v) : null;
  };
  cacheDarwinDirs = { tmp: leer('DARWIN_USER_TEMP_DIR'), cache: leer('DARWIN_USER_CACHE_DIR') };
  return cacheDarwinDirs;
}

/** Ruta absoluta con los enlaces simbólicos resueltos (sandbox-exec compara rutas reales). */
export function rutaReal(p) {
  let actual = path.resolve(expandirHome(p));
  const resto = [];
  while (!fs.existsSync(actual)) {
    const padre = path.dirname(actual);
    if (padre === actual) break;
    resto.unshift(path.basename(actual));
    actual = padre;
  }
  try {
    actual = fs.realpathSync(actual);
  } catch { /* se usa tal cual */ }
  return path.join(actual, ...resto);
}

const unicas = (lista) => [...new Set(lista)];

/**
 * Política efectiva:
 * - temporalesSistema: /tmp, /var/tmp y, en macOS, DARWIN_USER_TEMP_DIR y DARWIN_USER_CACHE_DIR (que
 *   Foundation/Xcode usan ignorando $TMPDIR). Van antes de `noEscribible` para no reabrir repos ni datos de orq.
 * - noEscribible: raíces que siguen protegidas contra escritura aunque vivan dentro de /tmp o DARWIN_USER_TEMP_DIR
 *   (el repo principal, datos de orq, config de Claude, HOME y un $TMPDIR aislado distinto al de Darwin).
 * - escritura: el worktree (`escribibles`), el temporal propio (`tmp`), cachés y extras; todo esto también se lee.
 * - protegida: rutas dentro de lo escribible que no se pueden modificar (el .git del worktree, configs del ejecutor).
 * - lecturaDenegada: carpetas que el usuario no quiere que se lean (sandbox.lectura_denegada), por ejemplo ~/dev.
 * - lecturaExtra: carpetas de solo lectura que se reabren dentro de lecturaDenegada (p. ej. referencias externas).
 * - legibles: lo que se vuelve a abrir para lectura aunque esté dentro de una carpeta denegada
 *   (el repo actual y el estado del ejecutor).
 * - credenciales: nunca se leen ni escriben, aunque estén dentro de algo legible (más `credencialesExtra`,
 *   que el llamador agrega según quién corre: p. ej. ~/.npmrc o la autenticación del otro ejecutor).
 * - tmp: temporal propio de la ejecución (va como TMPDIR). Otros directorios `orq-sb-*` quedan cerrados.
 * - sockets: agentes de SSH y GPG, a los que no se puede conectar (con ellos se firmaría o se haría push).
 */
export function politicaSandbox(registro, {
  escribibles = [], protegidas = [], legibles = [], credencialesExtra = [], tmp = null, confiable = false, plataforma = process.platform,
} = {}) {
  const cfg = configSandbox(registro);
  const darwin = darwinDirs(plataforma);
  const temporalesSistema = ['/tmp', '/var/tmp', darwin.tmp, darwin.cache].filter(Boolean).map(rutaReal);
  const temporalPropio = tmp ?? os.tmpdir();
  const tmpSistema = rutaReal(os.tmpdir());
  const legiblesEfectivos = [
    ...legibles,
    ...(plataforma === 'darwin' && fs.existsSync(DIR_SHIMS_MACOS) ? [DIR_SHIMS_MACOS] : []),
  ];
  const noEscribible = [
    ...legiblesEfectivos,
    ...cfg.lectura_denegada,
    ...cfg.lectura_extra,
    DIR_DATOS,
    dirConfigClaude(),
    RAIZ_ORQ,
    os.homedir(),
    // Si $TMPDIR es distinto a DARWIN_USER_TEMP_DIR (p. ej. un entorno aislado), se mantiene cerrado salvo `tmp`.
    ...(tmp && tmpSistema !== darwin.tmp ? [tmpSistema] : []),
  ];
  const omitirCredenciales = confiable && cfg.preparar_con_credenciales === true;
  const sockets = omitirCredenciales ? [] : [process.env.SSH_AUTH_SOCK, '~/.gnupg'].filter(Boolean);
  const propiasEscribibles = unicas([...escribibles, ...(tmp ? [tmp] : [])].map(rutaReal));
  return {
    temporalesSistema: unicas(temporalesSistema),
    darwinTmp: darwin.tmp,
    noEscribible: unicas(noEscribible.map(rutaReal)),
    escritura: unicas([...escribibles, temporalPropio, ...ESCRITURA_BASE, ...cfg.escritura_extra].map(rutaReal)),
    protegida: unicas(protegidas.map(rutaReal)),
    lecturaDenegada: unicas(cfg.lectura_denegada.map(rutaReal)),
    lecturaExtra: unicas(cfg.lectura_extra.map(rutaReal)),
    legibles: unicas(legiblesEfectivos.map(rutaReal)),
    // Las rutas de la tarea (repo, worktree, estado del ejecutor, temporal propio) se reabren aunque caigan
    // dentro de /tmp/claude-* (p. ej. un proyecto de prueba en el scratchpad de Claude Code).
    propias: {
      escribibles: propiasEscribibles,
      legibles: unicas([...propiasEscribibles, ...legiblesEfectivos.map(rutaReal)]),
    },
    credenciales: unicas([
      ...(omitirCredenciales ? [] : LECTURA_DENEGADA_BASE),
      path.join(dirConfigClaude(), '.credentials.json'),
      ...credencialesExtra,
    ].map(rutaReal)),
    sockets: unicas(sockets.map(rutaReal)),
    bloquearAgenteSsh: !omitirCredenciales,
  };
}

/** Carpetas de Claude Code en /tmp (scratchpads de sesiones y salidas de tareas que Opus lee). */
const TMP_CLAUDE = '^/private/tmp/claude-[0-9]+(/|$)';
const AGENTE_SSH_LAUNCHD = '^/private/var/run/com\\.apple\\.launchd\\.[^/]+/Listeners$';

const cadenaSbpl = (p) => `"${p.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const escaparRegex = (p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const regla = (accion, operaciones, rutas) => rutas.map((p) => `(${accion} ${operaciones} (subpath ${cadenaSbpl(p)}))`);

/**
 * Perfil SBPL para sandbox-exec. Verificado en macOS:
 * - entre reglas de la misma operación gana la última;
 * - una regla de operación específica (file-read-data) gana a una con comodín (file-read*) sin importar el orden,
 *   por eso las lecturas se deniegan y reabren con file-read-data, y las credenciales niegan ambas;
 * - denegar solo file-read-data (contenido y listados) deja los metadatos, que realpath y git necesitan
 *   para recorrer carpetas padre denegadas.
 * Orden: temporales del sistema/Darwin → aislamiento de otros orq-sb-* y raíces no escribibles → escritura y
 * cachés → .git y configs protegidos → lecturas denegadas y reapertura (incluyendo lecturaExtra) → temporales de
 * Claude Code cerrados y rutas de la tarea reabiertas → credenciales y sockets, que nada reabre.
 */
export function perfilMacos(pol) {
  const propias = pol.propias ?? { escribibles: [], legibles: [] };
  const temporalesSistema = pol.temporalesSistema ?? [];
  const noEscribible = pol.noEscribible ?? [];
  const lecturaExtra = pol.lecturaExtra ?? [];
  return [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    '(allow file-write* (subpath "/dev"))',
    ...regla('allow', 'file-write*', temporalesSistema),
    ...(pol.darwinTmp ? [`(deny file-write* (regex #"^${escaparRegex(pol.darwinTmp)}/orq-sb-[^/]+(/|$)"))`] : []),
    ...regla('deny', 'file-write*', noEscribible),
    ...regla('allow', 'file-write*', pol.escritura),
    ...regla('deny', 'file-write*', pol.protegida),
    ...regla('deny', 'file-read-data', pol.lecturaDenegada),
    ...regla('allow', 'file-read-data', [...pol.legibles, ...lecturaExtra, ...pol.escritura]),
    `(deny file-read-data (regex #"${TMP_CLAUDE}"))`,
    `(deny file-write* (regex #"${TMP_CLAUDE}"))`,
    ...regla('allow', 'file-read-data', propias.legibles),
    ...regla('allow', 'file-write*', propias.escribibles),
    ...regla('deny', 'file-write*', pol.protegida),
    ...regla('deny', 'file-read-data', pol.credenciales),
    ...regla('deny', 'file-read* file-write*', pol.credenciales),
    ...(pol.bloquearAgenteSsh !== false ? [`(deny network-outbound (remote unix-socket (path-regex #"${AGENTE_SSH_LAUNCHD}")))`] : []),
    ...(pol.sockets ?? []).map((p) => `(deny network-outbound (remote unix-socket (subpath ${cadenaSbpl(p)})))`),
    '',
  ].join('\n');
}

/** Carpetas /tmp/claude-* que existen ahora (bwrap no admite patrones: se ocultan una por una). */
function carpetasTmpClaude() {
  try {
    return fs.readdirSync('/tmp').filter((n) => /^claude-[0-9]+$/.test(n)).map((n) => path.join('/tmp', n));
  } catch {
    return [];
  }
}

/**
 * Argumentos de bwrap (sin el comando). Los montajes posteriores pisan a los anteriores; bwrap exige
 * que el origen exista. Las carpetas denegadas quedan vacías (tmpfs) y lo legible se vuelve a montar encima.
 */
export function argsBwrap(pol, cwd, existe = fs.existsSync, esDirectorio = (p) => fs.statSync(p).isDirectory()) {
  const a = ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--unshare-pid', '--die-with-parent'];
  const ocultar = (p) => (esDirectorio(p) ? ['--tmpfs', p] : ['--ro-bind', '/dev/null', p]);
  const propias = pol.propias ?? { escribibles: [], legibles: [] };
  const lecturaExtra = pol.lecturaExtra ?? [];
  const escribiblesBwrap = unicas([...(pol.temporalesSistema ?? []), ...pol.escritura]);
  for (const p of escribiblesBwrap) if (existe(p)) a.push('--bind', p, p);
  for (const p of pol.lecturaDenegada) if (existe(p)) a.push(...ocultar(p));
  if (pol.lecturaDenegada.length) {
    for (const p of [...pol.legibles, ...lecturaExtra]) if (existe(p) && !pol.escritura.includes(p)) a.push('--ro-bind', p, p);
    for (const p of pol.escritura) if (existe(p)) a.push('--bind', p, p);
  }
  // Temporales de Claude Code ocultos; las rutas de la tarea que caigan dentro se vuelven a montar.
  for (const p of pol.tmpClaude ?? carpetasTmpClaude()) if (existe(p)) a.push(...ocultar(p));
  for (const p of propias.legibles) if (existe(p) && !propias.escribibles.includes(p)) a.push('--ro-bind', p, p);
  for (const p of propias.escribibles) if (existe(p)) a.push('--bind', p, p);
  for (const p of pol.protegida) if (existe(p)) a.push('--ro-bind', p, p);
  for (const p of [...pol.credenciales, ...(pol.sockets ?? [])]) if (existe(p)) a.push(...ocultar(p));
  a.push('--chdir', cwd);
  return a;
}

/** Ajusta el entorno del proceso cuando corre dentro del sandbox (ORQ_SANDBOX=1 y shims de macOS en PATH). */
export function entornoSandbox(env, sandbox, dirShims = DIR_SHIMS_MACOS) {
  if (!sandbox) return env;
  const salida = { ...env, ORQ_SANDBOX: '1' };
  if (sandbox === 'sandbox-exec' && dirShims && fs.existsSync(dirShims)) {
    const partes = (salida.PATH ?? '').split(path.delimiter).filter((d) => d && d !== dirShims);
    salida.PATH = [dirShims, ...partes].join(path.delimiter);
  }
  return salida;
}

let cacheDisponible = null;

/** Detecta el sandbox de la plataforma probándolo de verdad (puede fallar si ya corres dentro de otro). */
export function sandboxDisponible(plataforma = process.platform) {
  if (cacheDisponible && plataforma === process.platform) return cacheDisponible;
  let r;
  if (plataforma === 'darwin') {
    const p = spawnSync('sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true'], { stdio: 'ignore', timeout: 10000 });
    r = p.status === 0
      ? { tipo: 'sandbox-exec' }
      : { tipo: null, motivo: 'sandbox-exec no funciona aquí (¿orq ya corre dentro de otro sandbox?)' };
  } else if (plataforma === 'linux') {
    const p = spawnSync('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--unshare-pid', '--die-with-parent', 'true'], {
      stdio: 'ignore', timeout: 10000,
    });
    if (p.status === 0) r = { tipo: 'bwrap' };
    else if (p.error?.code === 'ENOENT') r = { tipo: null, motivo: 'bubblewrap (bwrap) no está instalado' };
    else r = { tipo: null, motivo: 'bwrap no funciona aquí (¿user namespaces desactivados?)' };
  } else {
    r = { tipo: null, motivo: `no hay sandbox para ${plataforma}` };
  }
  if (plataforma === process.platform) cacheDisponible = r;
  return r;
}

/**
 * Envuelve un comando en el sandbox según command_code.sandbox.modo.
 * Devuelve { bin, args, sandbox: 'sandbox-exec' | 'bwrap' | null, aviso }.
 * Con modo obligatorio y sin sandbox disponible, lanza (código 3).
 */
/** true si los comandos van a correr dentro del sandbox (según el modo y lo disponible). */
export function sandboxActivo(registro, disponible) {
  return configSandbox(registro).modo !== 'desactivado' && Boolean((disponible ?? sandboxDisponible()).tipo);
}

export function envolverEnSandbox(registro, {
  bin, args, cwd, escribibles = [], protegidas = [], legibles = [], credencialesExtra = [], tmp = null, confiable = false, disponible,
} = {}) {
  const { modo } = configSandbox(registro);
  if (modo === 'desactivado') return { bin, args, sandbox: null, aviso: null };
  const d = disponible ?? sandboxDisponible();
  if (!d.tipo) {
    if (modo === 'obligatorio') {
      throw new ErrorOrquestador(`sandbox.modo es obligatorio pero no hay sandbox: ${d.motivo}.`, SALIDA.BLOQUEADO);
    }
    return { bin, args, sandbox: null, aviso: `Sin sandbox (${d.motivo}): el modelo delegado corre con todos tus permisos.` };
  }
  if (d.tipo === 'bwrap') {
    const homeReal = rutaReal(os.homedir());
    const dentroDeHome = (p) => p.startsWith(`${homeReal}${path.sep}`);
    for (const p of escribibles.map(rutaReal)) {
      if (!fs.existsSync(p) && dentroDeHome(p)) {
        try { fs.mkdirSync(p, { recursive: true }); } catch { /* ignorar */ }
      }
    }
    for (const p of ESCRITURA_BASE.map(rutaReal)) {
      if (!fs.existsSync(p) && dentroDeHome(p) && fs.existsSync(path.dirname(p))) {
        try {
          if (path.basename(p) === '.package-cache') fs.writeFileSync(p, '', { flag: 'wx' });
          else fs.mkdirSync(p, { recursive: true });
        } catch { /* ignorar */ }
      }
    }
  }
  const pol = politicaSandbox(registro, { escribibles, protegidas, legibles, credencialesExtra, tmp, confiable });
  if (d.tipo === 'sandbox-exec') return { bin: 'sandbox-exec', args: ['-p', perfilMacos(pol), bin, ...args], sandbox: d.tipo, aviso: null };
  return { bin: 'bwrap', args: [...argsBwrap(pol, cwd), '--', bin, ...args], sandbox: d.tipo, aviso: null };
}
