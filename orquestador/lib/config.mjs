import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { cargarRegistro, validarRegistro, leerYaml, esListaDeTextos, ErrorOrquestador } from './registro.mjs';
import { git } from './util.mjs';
import { RAIZ_ORQ } from './constantes.mjs';

export { RAIZ_ORQ };

/** Carpeta de datos: models.yaml y logs. ORQ_HOME permite aislarla en tests. */
export const DIR_DATOS = process.env.ORQ_HOME ? path.resolve(expandirHome(process.env.ORQ_HOME)) : RAIZ_ORQ;
export const RUTA_REGISTRO = path.join(DIR_DATOS, 'models.yaml');
export const ARCHIVO_REPO = path.join('.claude', 'orquestador.yaml');

export function expandirHome(p) {
  if (p === '~') return os.homedir();
  if (typeof p === 'string' && p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Carpeta de configuración de Claude Code del usuario (respeta CLAUDE_CONFIG_DIR). */
export function dirConfigClaude() {
  return process.env.CLAUDE_CONFIG_DIR ? path.resolve(expandirHome(process.env.CLAUDE_CONFIG_DIR)) : path.join(os.homedir(), '.claude');
}

export function rutaSkillGlobal() {
  return process.env.ORQ_SKILL
    ? path.resolve(expandirHome(process.env.ORQ_SKILL))
    : path.join(dirConfigClaude(), 'skills', 'orquestar', 'SKILL.md');
}

export function rutasLogs() {
  const dir = path.join(DIR_DATOS, 'logs');
  return {
    dir,
    jsonl: path.join(dir, 'delegaciones.jsonl'),
    salidas: path.join(dir, 'salidas'),
    worktreesMeta: path.join(dir, 'worktrees'),
  };
}

/** Carpeta donde se crean los worktrees de delegación de un repo. */
export function dirWorktrees(registro, raiz) {
  const w = registro.worktrees ?? {};
  if ((w.ubicacion ?? 'repo') === 'repo') return path.join(raiz, '.claude', 'worktrees');
  const base = path.resolve(expandirHome(w.dir_externo ?? '~/.orquestador/worktrees'));
  const huella = crypto.createHash('sha256').update(raiz).digest('hex').slice(0, 8);
  return path.join(base, `${path.basename(raiz)}-${huella}`);
}

const sinBarraFinal = (p) => (p.length > 1 ? p.replace(/\/+$/, '') || '/' : p);

/** Glob simple (* y ?) a expresión regular, sin distinguir mayúsculas. */
export function globARegex(glob) {
  const norm = sinBarraFinal(expandirHome(glob));
  const esc = norm.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${esc}$`, 'i');
}

const CAMPOS_ROL_AJUSTABLES = ['effort', 'effort_reintento', 'skills', 'max_archivos', 'rutas_permitidas'];
const CLAVES_REPO = ['sensible', 'desactivado', 'preparar', 'validar', 'roles'];

/**
 * Lee .claude/orquestador.yaml del repo. Puede marcar el repo como sensible o desactivar el orquestador,
 * declarar comandos para preparar y validar worktrees, y ajustar campos de roles existentes.
 */
export function cargarAjustesRepo(raiz, registro) {
  const ruta = path.join(raiz, ARCHIVO_REPO);
  if (!fs.existsSync(ruta)) return null;
  const datos = leerYaml(ruta) ?? {};
  if (typeof datos !== 'object' || Array.isArray(datos)) throw new ErrorOrquestador(`${ARCHIVO_REPO} inválido: debe ser un objeto YAML.`);
  const errores = [];
  for (const clave of Object.keys(datos)) {
    if (!CLAVES_REPO.includes(clave)) {
      errores.push(`"${clave}" no se puede ajustar por repo (la whitelist, el sandbox y los umbrales son globales).`);
    }
  }
  for (const clave of ['sensible', 'desactivado']) {
    if (datos[clave] !== undefined && typeof datos[clave] !== 'boolean') errores.push(`"${clave}" debe ser true o false.`);
  }
  for (const clave of ['preparar', 'validar']) {
    if (datos[clave] !== undefined && datos[clave] !== null && !esListaDeTextos(datos[clave])) {
      errores.push(`"${clave}" debe ser una lista de comandos.`);
    }
  }
  if (datos.roles !== undefined && datos.roles !== null) {
    if (typeof datos.roles !== 'object' || Array.isArray(datos.roles)) {
      errores.push('"roles" debe ser un mapa de rol a ajustes.');
    } else {
      for (const [rol, campos] of Object.entries(datos.roles)) {
        // Object.hasOwn: "__proto__", "constructor" o "toString" no son roles (y __proto__ contaminaría Object.prototype).
        if (!Object.hasOwn(registro.roles, rol)) {
          errores.push(`El rol "${rol}" no existe en el registro global.`);
          continue;
        }
        if (campos !== null && (typeof campos !== 'object' || Array.isArray(campos))) {
          errores.push(`roles.${rol} debe ser un mapa de campo a valor.`);
          continue;
        }
        for (const campo of Object.keys(campos ?? {})) {
          if (!CAMPOS_ROL_AJUSTABLES.includes(campo)) {
            errores.push(`roles.${rol}.${campo} no se puede ajustar por repo (permitidos: ${CAMPOS_ROL_AJUSTABLES.join(', ')}).`);
          }
        }
      }
    }
  }
  if (errores.length) throw new ErrorOrquestador(`${ARCHIVO_REPO} inválido:\n- ${errores.join('\n- ')}`);
  return { ruta, datos };
}

export function remotosGit(raiz) {
  const salida = git(['remote', '-v'], raiz, { permitirFallo: true }) ?? '';
  return [...new Set(salida.split('\n').map((l) => l.split(/\s+/)[1]).filter(Boolean))];
}

/**
 * Variantes de un patrón de ruta: tal cual y con su prefijo literal (antes del primer comodín) resuelto
 * a la ruta real. git entrega la raíz del repo con los enlaces simbólicos resueltos, así que
 * "~/dev/privado*" tiene que coincidir aunque ~/dev sea un enlace a otro disco.
 */
export function variantesPatronRuta(patron) {
  const expandido = sinBarraFinal(expandirHome(patron));
  const comodin = expandido.search(/[*?]/);
  const variantes = [expandido];
  const agregarReal = (prefijo) => {
    if (!prefijo) return false;
    try {
      const real = fs.realpathSync(prefijo);
      if (real !== prefijo) variantes.push(sinBarraFinal(real + expandido.slice(prefijo.length)));
      return true;
    } catch {
      return false; /* el prefijo no existe: solo el patrón tal cual */
    }
  };
  if (comodin === -1 && agregarReal(expandido)) return variantes;
  const literal = comodin === -1 ? expandido : expandido.slice(0, comodin);
  const corte = literal.endsWith(path.sep) ? literal.length - 1 : literal.lastIndexOf(path.sep);
  const prefijo = expandido.slice(0, Math.max(corte, 0));
  agregarReal(prefijo);
  return variantes;
}

/**
 * Un repo es sensible si su ruta o un remoto coincide con los patrones globales,
 * o si su archivo de ajustes dice sensible: true. Un repo nunca puede desmarcarse a sí mismo.
 */
export function detectarSensible(registro, raiz, ajustes, remotos = remotosGit(raiz)) {
  const motivos = [];
  const patrones = registro.repos_sensibles ?? {};
  for (const p of patrones.rutas ?? []) {
    if (variantesPatronRuta(p).some((v) => globARegex(v).test(raiz))) motivos.push(`la ruta coincide con "${p}"`);
  }
  for (const p of patrones.remotos ?? []) {
    const r = remotos.find((url) => globARegex(p).test(url));
    if (r) motivos.push(`el remoto ${r} coincide con "${p}"`);
  }
  if (ajustes?.datos?.sensible === true) motivos.push(`${ARCHIVO_REPO} dice sensible: true`);
  const intentoDesmarcar = ajustes?.datos?.sensible === false && motivos.length > 0;
  return { sensible: motivos.length > 0, motivos, intentoDesmarcar };
}

/** Registro global con los ajustes del repo aplicados y el estado de sensibilidad resuelto. */
export function registroEfectivo(raiz, { rutaRegistro = RUTA_REGISTRO, remotos } = {}) {
  const global = cargarRegistro(rutaRegistro);
  const ajustes = cargarAjustesRepo(raiz, global);
  const efectivo = structuredClone(global);
  for (const [rol, campos] of Object.entries(ajustes?.datos?.roles ?? {})) {
    for (const [campo, valor] of Object.entries(campos ?? {})) {
      if (valor !== null && valor !== undefined) efectivo.roles[rol][campo] = valor;
    }
  }
  const sensibilidad = detectarSensible(global, raiz, ajustes, remotos);
  efectivo.repo = { sensible: sensibilidad.sensible };
  try {
    validarRegistro(efectivo);
  } catch (e) {
    throw new ErrorOrquestador(`Los ajustes de ${ARCHIVO_REPO} dejan el registro inválido:\n${e.message}`);
  }
  const repo = {
    desactivado: ajustes?.datos?.desactivado === true,
    preparar: ajustes?.datos?.preparar ?? [],
    validar: ajustes?.datos?.validar ?? [],
  };
  return { registro: efectivo, global, ajustes, sensibilidad, repo };
}

export const PLANTILLA_AJUSTES_REPO = `# Ajustes del orquestador para este repo.
# La whitelist, los modelos, el sandbox y los umbrales son globales: ~/.claude/orquestador/models.yaml
# Un repo que coincide con repos_sensibles del registro global sigue siendo sensible aunque aquí diga false.

sensible: __SENSIBLE__

# true: Opus trabaja sin delegar en este repo (orq delegar queda bloqueado).
desactivado: false

# Comandos que se ejecutan en cada worktree nuevo antes de delegar (dentro del sandbox).
# ORQ_RAIZ apunta al checkout principal. Lo que dejen sin ignorar en git no se commitea.
preparar: []
#   - npm ci
#   - cp "$ORQ_RAIZ/.env" .env

# Comandos que se ejecutan en el worktree después de cada delegación de escritura (dentro del sandbox).
# El resultado queda en el resumen, en el log y en el scorecard.
validar: []
#   - npm test --silent

roles: {}
#   implementar:
#     skills: [.claude/skills/convenciones-codigo]   # rutas relativas a la raíz del repo, o con ~/
#     max_archivos: 20
#   documentar:
#     rutas_permitidas: [docs/, README.md]
`;
