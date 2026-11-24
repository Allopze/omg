import fs from 'node:fs';
import YAML from 'yaml';
import { MODOS_SANDBOX, UBICACIONES_WORKTREE, NOMBRES_EJECUTORES } from './constantes.mjs';

export const NATIVOS = ['opus', 'fable', 'sonnet', 'haiku'];
const ESTADOS = ['activo', 'en_prueba', 'retirado'];
const PERMISOS = ['lectura', 'escritura'];
const SENSIBLES = ['permitido', 'tras_revisar_zdr', 'prohibido'];

// Códigos de salida compartidos por todos los scripts.
export const SALIDA = {
  OK: 0,
  ERROR_USO: 2,       // registro inválido, rol desconocido, argumentos malos
  BLOQUEADO: 3,       // fuera de whitelist, retirado, repo sensible, orquestador desactivado
  ESCALAR: 4,         // se agotaron los intentos con Command Code
  INTEGRIDAD: 5,      // Command Code tocó algo fuera de su worktree: detenerse y avisar al usuario
  TIMEOUT: 124,
};

export class ErrorOrquestador extends Error {
  constructor(mensaje, codigo = SALIDA.ERROR_USO) {
    super(mensaje);
    this.codigo = codigo;
  }
}

/** Lee un YAML y convierte los errores de sintaxis en un mensaje legible. */
export function leerYaml(ruta) {
  try {
    return YAML.parse(fs.readFileSync(ruta, 'utf8'));
  } catch (e) {
    throw new ErrorOrquestador(`${ruta} no es YAML válido: ${String(e.message).split('\n')[0]}`);
  }
}

export function cargarRegistro(ruta) {
  if (!fs.existsSync(ruta)) {
    throw new ErrorOrquestador(`No existe el registro: ${ruta}`);
  }
  const datos = leerYaml(ruta);
  validarRegistro(datos);
  return datos;
}

export function esNativo(destino) {
  return typeof destino === 'string' && destino.startsWith('nativo:');
}

export const esListaDeTextos = (x) => Array.isArray(x) && x.every((v) => typeof v === 'string' && v.trim() !== '');

const esObjeto = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

/** Ejecutor de un modelo: el CLI que lo corre. Los modelos sin `ejecutor` son de Command Code (compatibilidad con 0.2). */
export const ejecutorDeFicha = (f) => f?.ejecutor ?? 'command_code';

/**
 * Niveles de effort que acepta un modelo. Si declara `efforts` (nivel de orq → nivel/slug del ejecutor),
 * sus claves son los niveles válidos; si no, la lista `efforts_aceptados`.
 */
export function effortsDe(f) {
  return esObjeto(f?.efforts) ? Object.keys(f.efforts) : (f?.efforts_aceptados ?? []);
}

/** Configuración del sandbox: `sandbox` en la raíz del registro (en la 0.3 estaba en command_code.sandbox). */
export const seccionSandbox = (r) => r?.sandbox ?? r?.command_code?.sandbox;

// Claves de primer nivel del registro (`repo` la agrega registroEfectivo). Una desconocida suele ser un
// error de tipeo: `repos_sensible:` desactivaría en silencio la detección de repos sensibles.
const CLAVES_REGISTRO = [
  'repos_sensibles', 'command_code', 'antigravity', 'sandbox', 'worktrees', 'models', 'roles', 'no_delegables', 'umbrales', 'repo',
];
const CLAVES_SENSIBLES = ['rutas', 'remotos'];
const CLAVES_COMMAND_CODE = ['bin', 'timeout_min', 'skills_compatibles', 'salida_json', 'sandbox'];
const CLAVES_ANTIGRAVITY = ['bin', 'timeout_min', 'permitir_cuenta_personal'];
const CLAVES_EJECUTOR = { command_code: CLAVES_COMMAND_CODE, antigravity: CLAVES_ANTIGRAVITY };
const CLAVES_SANDBOX = ['modo', 'escritura_extra', 'lectura_denegada', 'lectura_extra', 'preparar_con_credenciales'];
const CLAVES_WORKTREES = ['ubicacion', 'dir_externo'];
const CLAVES_UMBRALES = ['promocion', 'degradacion', 'segundo_modelo'];
const CLAVES_MODELO = [
  'ejecutor', 'estado', 'permisos', 'repos_sensibles', 'efforts_aceptados', 'efforts', 'fortalezas', 'debilidades',
];
const CLAVES_ROL = [
  'descripcion', 'primario', 'permitidos', 'effort', 'effort_reintento', 'escala_a',
  'max_intentos', 'yolo', 'max_archivos', 'rutas_permitidas', 'skills',
];

const esTasa = (x) => typeof x === 'number' && x >= 0 && x <= 1;

export function validarRegistro(r) {
  const errores = [];
  const verificarClaves = (obj, permitidas, prefijo) => {
    const extra = Object.keys(obj).filter((k) => !permitidas.includes(k));
    if (extra.length) {
      errores.push(`Claves desconocidas en ${prefijo}: ${extra.join(', ')} (válidas: ${permitidas.join(', ')}).`);
    }
  };
  if (!esObjeto(r)) throw new ErrorOrquestador('El registro está vacío o no es un objeto YAML.');
  const desconocidas = Object.keys(r).filter((k) => !CLAVES_REGISTRO.includes(k));
  if (desconocidas.length) {
    errores.push(`Claves desconocidas: ${desconocidas.join(', ')} (válidas: ${CLAVES_REGISTRO.filter((k) => k !== 'repo').join(', ')}).`);
  }

  const models = r.models ?? {};
  if (!esObjeto(models) || Object.keys(models).length === 0) {
    errores.push('`models` debe tener al menos un modelo.');
  }

  if (esObjeto(models)) {
    for (const [id, f] of Object.entries(models)) {
      if (!esObjeto(f)) {
        errores.push(`models.${id} debe ser un objeto.`);
        continue;
      }
      verificarClaves(f, CLAVES_MODELO, `models.${id}`);
      if (!ESTADOS.includes(f.estado)) errores.push(`models.${id}.estado debe ser ${ESTADOS.join(' | ')}.`);
      if (!PERMISOS.includes(f.permisos)) errores.push(`models.${id}.permisos debe ser ${PERMISOS.join(' | ')}.`);
      if (!SENSIBLES.includes(f.repos_sensibles)) {
        errores.push(`models.${id}.repos_sensibles debe ser ${SENSIBLES.join(' | ')}.`);
      }
      const ejecutor = ejecutorDeFicha(f);
      if (!NOMBRES_EJECUTORES.includes(ejecutor)) {
        errores.push(`models.${id}.ejecutor debe ser ${NOMBRES_EJECUTORES.join(' | ')}.`);
      } else if (ejecutor === 'antigravity') {
        if (f.efforts_aceptados !== undefined) {
          errores.push(`models.${id}: los modelos de Antigravity declaran \`efforts\` (nivel → slug de agy), no efforts_aceptados.`);
        }
        if (!esObjeto(f.efforts) || Object.keys(f.efforts).length === 0) {
          errores.push(`models.${id}.efforts debe mapear cada nivel de effort de orq a un slug de \`agy models\`.`);
        } else {
          for (const [nivel, slug] of Object.entries(f.efforts)) {
            if (typeof slug !== 'string' || !slug.trim()) errores.push(`models.${id}.efforts.${nivel} debe ser un slug de agy.`);
          }
        }
      } else if (f.efforts !== undefined && f.efforts_aceptados !== undefined) {
        errores.push(`models.${id}: declara \`efforts\` o \`efforts_aceptados\`, no ambos.`);
      } else if (f.efforts !== undefined) {
        if (!esObjeto(f.efforts) || Object.keys(f.efforts).length === 0) {
          errores.push(`models.${id}.efforts debe mapear cada nivel de effort de orq a un nivel de cmd.`);
        } else {
          for (const [nivel, valor] of Object.entries(f.efforts)) {
            if (typeof valor !== 'string' || !valor.trim()) errores.push(`models.${id}.efforts.${nivel} debe ser un nivel de effort de cmd.`);
          }
        }
      } else if (!Array.isArray(f.efforts_aceptados) || f.efforts_aceptados.length === 0) {
        errores.push(`models.${id}.efforts_aceptados debe ser una lista no vacía.`);
      } else if (f.efforts_aceptados.includes('default')) {
        errores.push(`models.${id}.efforts_aceptados no debe incluir "default": el router siempre pasa un nivel explícito.`);
      }
    }
  }

  const roles = r.roles ?? {};
  if (!esObjeto(roles) || Object.keys(roles).length === 0) {
    errores.push('`roles` debe tener al menos un rol.');
  }

  for (const [nombre, rol] of Object.entries(esObjeto(roles) ? roles : {})) {
    const p = `roles.${nombre}`;
    if (!esObjeto(rol)) {
      errores.push(`${p} debe ser un objeto.`);
      continue;
    }
    verificarClaves(rol, CLAVES_ROL, p);
    if (!Array.isArray(rol.permitidos) || rol.permitidos.length === 0) {
      errores.push(`${p}.permitidos debe ser una lista no vacía.`);
      continue;
    }
    if (!rol.permitidos.includes(rol.primario)) errores.push(`${p}.primario debe estar en ${p}.permitidos.`);
    for (const id of rol.permitidos) {
      if (!esObjeto(models) || !Object.hasOwn(models, id)) {
        errores.push(`${p}.permitidos incluye "${id}", que no está en models.`);
        continue;
      }
      const f = models[id];
      if (!esObjeto(f)) {
        errores.push(`${p}.permitidos incluye "${id}", cuya ficha en models no es un objeto.`);
        continue;
      }
      for (const campo of ['effort', 'effort_reintento']) {
        if (!effortsDe(f).includes(rol[campo])) {
          const donde = ejecutorDeFicha(f) === 'antigravity' || esObjeto(f.efforts) ? 'efforts' : 'efforts_aceptados';
          errores.push(`${p}.${campo} = "${rol[campo]}" no está en models.${id}.${donde}.`);
        }
      }
      if (rol.yolo === true && f.permisos !== 'escritura') {
        errores.push(`${p} tiene yolo: true pero models.${id}.permisos es "${f.permisos}".`);
      }
    }
    if (!Number.isInteger(rol.max_intentos) || rol.max_intentos < 1) {
      errores.push(`${p}.max_intentos debe ser un entero >= 1.`);
    }
    if (typeof rol.yolo !== 'boolean') errores.push(`${p}.yolo debe ser true o false.`);
    if (!Array.isArray(rol.escala_a) || rol.escala_a.length === 0) {
      errores.push(`${p}.escala_a debe ser una lista no vacía.`);
    } else {
      // Solo se escala a subagentes nativos: para usar otro modelo delegado, Opus lo pide con --modelo.
      for (const destino of rol.escala_a) {
        if (!esNativo(destino)) {
          errores.push(`${p}.escala_a: "${destino}" no es nativo:<modelo>; para otro modelo delegado usa permitidos y --modelo.`);
        } else if (!NATIVOS.includes(destino.slice('nativo:'.length))) {
          errores.push(`${p}.escala_a: "${destino}" no es un modelo nativo (${NATIVOS.join(', ')}).`);
        }
      }
    }
    if (rol.skills !== undefined && !esListaDeTextos(rol.skills)) errores.push(`${p}.skills debe ser una lista de rutas.`);
    if (rol.max_archivos !== undefined && (!Number.isInteger(rol.max_archivos) || rol.max_archivos < 1)) {
      errores.push(`${p}.max_archivos debe ser un entero >= 1.`);
    }
    if (rol.rutas_permitidas !== undefined && !esListaDeTextos(rol.rutas_permitidas)) {
      errores.push(`${p}.rutas_permitidas debe ser una lista de rutas (entre comillas si el nombre es un número).`);
    }
  }

  if (r.no_delegables !== undefined && !esListaDeTextos(r.no_delegables)) errores.push('no_delegables debe ser una lista de textos.');
  const u = r.umbrales;
  if (u !== undefined) {
    if (!esObjeto(u)) errores.push('umbrales debe ser un objeto.');
    else {
      verificarClaves(u, CLAVES_UMBRALES, 'umbrales');
      const entero = (x) => Number.isInteger(x) && x >= 1;
      if (u.promocion !== undefined) {
        if (esObjeto(u.promocion)) verificarClaves(u.promocion, ['min_tareas', 'tasa_aprobacion'], 'umbrales.promocion');
        if (!esObjeto(u.promocion) || !(entero(u.promocion.min_tareas) && esTasa(u.promocion.tasa_aprobacion))) {
          errores.push('umbrales.promocion necesita min_tareas (entero >= 1) y tasa_aprobacion (entre 0 y 1).');
        }
      }
      if (u.degradacion !== undefined) {
        if (esObjeto(u.degradacion)) verificarClaves(u.degradacion, ['ultimas_tareas', 'tasa_aprobacion'], 'umbrales.degradacion');
        if (!esObjeto(u.degradacion) || !(entero(u.degradacion.ultimas_tareas) && esTasa(u.degradacion.tasa_aprobacion))) {
          errores.push('umbrales.degradacion necesita ultimas_tareas (entero >= 1) y tasa_aprobacion (entre 0 y 1).');
        }
      }
      if (u.segundo_modelo !== undefined) {
        if (esObjeto(u.segundo_modelo)) verificarClaves(u.segundo_modelo, ['tasa_escalamiento'], 'umbrales.segundo_modelo');
        if (!esObjeto(u.segundo_modelo) || !esTasa(u.segundo_modelo.tasa_escalamiento)) {
          errores.push('umbrales.segundo_modelo.tasa_escalamiento debe estar entre 0 y 1.');
        }
      }
    }
  }

  const sensibles = r.repos_sensibles;
  if (sensibles !== undefined && sensibles !== null) {
    if (!esObjeto(sensibles)) {
      errores.push('repos_sensibles debe ser un objeto.');
    } else {
      verificarClaves(sensibles, CLAVES_SENSIBLES, 'repos_sensibles');
      for (const clave of ['rutas', 'remotos']) {
        if (sensibles[clave] !== undefined && !(Array.isArray(sensibles[clave]) && sensibles[clave].every((x) => typeof x === 'string'))) {
          errores.push(`repos_sensibles.${clave} debe ser una lista de patrones.`);
        }
      }
    }
  }

  for (const nombre of NOMBRES_EJECUTORES) {
    const e = r[nombre];
    if (e === undefined || e === null) continue;
    if (!esObjeto(e)) {
      errores.push(`${nombre} debe ser un objeto.`);
      continue;
    }
    verificarClaves(e, CLAVES_EJECUTOR[nombre], nombre);
    if (e.bin !== undefined && (typeof e.bin !== 'string' || !e.bin.trim())) errores.push(`${nombre}.bin debe ser un comando.`);
    if (e.timeout_min !== undefined && !(typeof e.timeout_min === 'number' && e.timeout_min > 0)) {
      errores.push(`${nombre}.timeout_min debe ser un número mayor que 0.`);
    }
  }
  const cc = esObjeto(r.command_code) ? r.command_code : {};
  for (const clave of ['skills_compatibles', 'salida_json']) {
    if (cc[clave] !== undefined && cc[clave] !== null && typeof cc[clave] !== 'boolean') {
      errores.push(`command_code.${clave} debe ser true, false o null.`);
    }
  }
  const ag = esObjeto(r.antigravity) ? r.antigravity : {};
  if (ag.permitir_cuenta_personal !== undefined && typeof ag.permitir_cuenta_personal !== 'boolean') {
    errores.push('antigravity.permitir_cuenta_personal debe ser true o false.');
  }

  if (r.sandbox !== undefined && r.command_code?.sandbox !== undefined) {
    errores.push('El sandbox se configura en `sandbox` (raíz del registro); quita command_code.sandbox.');
  }
  const sb = seccionSandbox(r);
  const prefijo = r.sandbox !== undefined ? 'sandbox' : 'command_code.sandbox';
  if (sb !== undefined && sb !== null) {
    if (!esObjeto(sb)) {
      errores.push(`${prefijo} debe ser un objeto.`);
    } else {
      verificarClaves(sb, CLAVES_SANDBOX, prefijo);
      if (sb.modo !== undefined && !MODOS_SANDBOX.includes(sb.modo)) {
        errores.push(`${prefijo}.modo debe ser ${MODOS_SANDBOX.join(' | ')}.`);
      }
      for (const clave of ['escritura_extra', 'lectura_denegada', 'lectura_extra']) {
        if (sb[clave] !== undefined && sb[clave] !== null && !esListaDeTextos(sb[clave])) {
          errores.push(`${prefijo}.${clave} debe ser una lista de rutas.`);
        }
      }
      if (sb.preparar_con_credenciales !== undefined && typeof sb.preparar_con_credenciales !== 'boolean') {
        errores.push(`${prefijo}.preparar_con_credenciales debe ser true o false.`);
      }
    }
  }

  const wt = r.worktrees;
  if (wt !== undefined && wt !== null) {
    if (!esObjeto(wt)) {
      errores.push('worktrees debe ser un objeto.');
    } else {
      verificarClaves(wt, CLAVES_WORKTREES, 'worktrees');
      if (wt.ubicacion !== undefined && !UBICACIONES_WORKTREE.includes(wt.ubicacion)) {
        errores.push(`worktrees.ubicacion debe ser ${UBICACIONES_WORKTREE.join(' | ')}.`);
      }
      if (wt.dir_externo !== undefined && (typeof wt.dir_externo !== 'string' || !wt.dir_externo.trim())) {
        errores.push('worktrees.dir_externo debe ser una ruta.');
      }
    }
  }

  if (errores.length) {
    throw new ErrorOrquestador(`Registro inválido:\n- ${errores.join('\n- ')}`);
  }
}

/**
 * Decide qué hacer con una petición de delegación.
 * Devuelve { accion: 'delegar', ... } o { accion: 'escalar', ... }.
 * Lanza ErrorOrquestador si la petición viola la whitelist.
 */
export function resolverDelegacion(registro, { rol, intento = 1, modelo } = {}) {
  const r = registro.roles?.[rol];
  if (!r) {
    throw new ErrorOrquestador(`Rol desconocido: "${rol}". Roles disponibles: ${Object.keys(registro.roles).join(', ')}.`);
  }
  if (!Number.isInteger(intento) || intento < 1) {
    throw new ErrorOrquestador('El intento debe ser un entero >= 1.');
  }
  if (intento > r.max_intentos) {
    return { accion: 'escalar', rol, intento, max_intentos: r.max_intentos, escala_a: r.escala_a, yolo: r.yolo };
  }

  const id = modelo ?? r.primario;
  if (!r.permitidos.includes(id)) {
    throw new ErrorOrquestador(
      `"${id}" no está permitido para el rol "${rol}". Permitidos: ${r.permitidos.join(', ')}.`,
      SALIDA.BLOQUEADO,
    );
  }
  const ficha = registro.models[id];
  if (ficha.estado === 'retirado') {
    throw new ErrorOrquestador(`"${id}" está retirado de la whitelist.`, SALIDA.BLOQUEADO);
  }
  if (registro.repo?.sensible === true && ficha.repos_sensibles !== 'permitido') {
    throw new ErrorOrquestador(
      `Este repo está marcado como sensible y "${id}" tiene repos_sensibles: ${ficha.repos_sensibles}. ` +
        `Haz la tarea con un modelo nativo de Claude (${r.escala_a.join(', ')}).`,
      SALIDA.BLOQUEADO,
    );
  }

  const effort = intento === 1 ? r.effort : r.effort_reintento;
  const ejecutor = ejecutorDeFicha(ficha);
  const skillsDeclaradas = r.skills ?? [];
  // Solo Command Code acepta skills por flag (--skill); agy no tiene un equivalente.
  const usarSkills = ejecutor === 'command_code' && registro.command_code?.skills_compatibles === true;

  return {
    accion: 'delegar',
    rol,
    modelo: id,
    ejecutor,
    slug: ejecutor === 'antigravity' ? ficha.efforts[effort] : null,
    intento,
    max_intentos: r.max_intentos,
    effort,
    effort_cli: ejecutor === 'command_code' && esObjeto(ficha.efforts) ? ficha.efforts[effort] : effort,
    yolo: r.yolo,
    skills: usarSkills ? skillsDeclaradas : [],
    skills_omitidas: usarSkills ? [] : skillsDeclaradas,
    max_archivos: r.max_archivos ?? null,
    rutas_permitidas: r.rutas_permitidas ?? null,
    escala_a: r.escala_a,
    // agy siempre entrega JSON (stream-json); Command Code, solo si la Fase 0 lo verificó.
    salida_json: ejecutor === 'antigravity' || registro.command_code?.salida_json === true,
  };
}

/** Subagente nativo de Claude Code al que corresponde un escalamiento. */
export function subagenteNativo(destino, yolo) {
  const nativo = destino.slice('nativo:'.length);
  const tabla = yolo
    ? { sonnet: 'implementador-sonnet', haiku: 'documentador-haiku', opus: 'sesión principal (Opus)', fable: 'sesión principal (Fable)' }
    : { sonnet: 'analista-sonnet', haiku: 'Explore', opus: 'sesión principal (Opus)', fable: 'sesión principal (Fable)' };
  return tabla[nativo] ?? nativo;
}

/** Preámbulo que se antepone al prompt de Opus. DeepSeek no ve la conversación de Claude Code. */
export function construirPrompt(res, prompt) {
  const reglas = [
    'Trabaja solo dentro del directorio actual. No leas ni explores archivos fuera de él, ni procesos del sistema: '
      + 'lo que necesitas está en este directorio o en la tarea.',
  ];
  if (res.yolo) {
    reglas.push('No hagas git commit, push, merge ni cambies de rama, y no modifiques .git: el orquestador hace el commit.');
    reglas.push('No dejes procesos corriendo en segundo plano (servidores, watchers): el orquestador los termina al final.');
    if (res.max_archivos) reglas.push(`Modifica como máximo ${res.max_archivos} archivos.`);
    if (res.rutas_permitidas?.length) reglas.push(`Solo puedes crear o modificar archivos bajo: ${res.rutas_permitidas.join(', ')}.`);
  } else {
    reglas.push('Solo lectura: no modifiques archivos ni ejecutes comandos que cambien el estado del repo.');
  }
  reglas.push('No amplíes el alcance de la tarea.');
  reglas.push(res.yolo
    ? 'Al terminar, lista los archivos que modificaste y resume lo que hiciste en pocas líneas.'
    : 'Responde de forma breve y concreta: rutas, funciones y hallazgos relevantes.');

  return [
    `[Delegación desde Claude Code · rol: ${res.rol} · intento ${res.intento}/${res.max_intentos}]`,
    'Reglas:',
    ...reglas.map((r) => `- ${r}`),
    '',
    'Tarea:',
    prompt.trim(),
    '',
  ].join('\n');
}

/** Archivos fuera de las rutas permitidas del rol. */
export function archivosFueraDeRutas(archivos, rutas) {
  if (!rutas?.length) return [];
  const prefijos = rutas.map((r) => r.replace(/^\.\//, ''));
  return archivos.filter((a) => !prefijos.some((p) => a === p.replace(/\/$/, '') || a.startsWith(p.endsWith('/') ? p : `${p}/`)));
}

// Archivos que cambian el comportamiento de agentes, CI o git: un diff que los toca merece revisión extra.
const CONFIGURACION_SENSIBLE = [
  /^\.claude\//, /^\.commandcode\//, /^\.gemini\//, /^\.agent\//, /^\.cursor\//, /^\.vscode\//,
  /^\.github\/workflows\//, /^\.husky\//, /^\.githooks\//,
  /(^|\/)\.gitattributes$/, /^\.gitmodules$/, /(^|\/)\.npmrc$/, /(^|\/)\.envrc$/, /(^|\/)\.mcp\.json$/,
  /(^|\/)AGENTS\.md$/, /(^|\/)CLAUDE\.md$/, /(^|\/)GEMINI\.md$/,
  // Quality gates de Command Code: comandos que una sesión interactiva ejecutaría sin sandbox.
  /(^|\/)\.cc-[^/]*\.json$/,
];

export function archivosDeConfiguracion(archivos) {
  return archivos.filter((a) => CONFIGURACION_SENSIBLE.some((re) => re.test(a)));
}

const CLAVES_USO = {
  entrada: ['inputTokens', 'input_tokens', 'promptTokens', 'prompt_tokens'],
  salida: ['outputTokens', 'output_tokens', 'completionTokens', 'completion_tokens'],
  razonamiento: ['thinkingTokens', 'thinking_tokens', 'reasoningTokens', 'reasoning_tokens'],
  cache: ['cacheReadTokens', 'cache_read_tokens', 'cacheReadInputTokens', 'cache_read_input_tokens'],
  total: ['totalTokens', 'total_tokens'],
  costo: ['costUsd', 'cost_usd', 'totalCostUsd', 'totalCost', 'total_cost', 'cost'],
};

/**
 * Normaliza el `usage` de un ejecutor a { entrada, salida, razonamiento, cache, total, costo }
 * (null en lo que no informe); null si no reconoce nada.
 */
export function extraerUso(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const primero = (claves) => claves.map((k) => usage[k]).find((v) => typeof v === 'number') ?? null;
  const uso = Object.fromEntries(Object.entries(CLAVES_USO).map(([k, claves]) => [k, primero(claves)]));
  return Object.values(uso).some((v) => v !== null) ? uso : null;
}

/** Tokens de una delegación: el total que informa el ejecutor o, si no lo da, entrada + salida + razonamiento. */
export function tokensTotales(uso) {
  if (!uso) return null;
  if (typeof uso.total === 'number') return uso.total;
  const partes = [uso.entrada, uso.salida, uso.razonamiento].filter((v) => typeof v === 'number');
  return partes.length ? partes.reduce((a, b) => a + b, 0) : null;
}
