// Ejecutor Antigravity CLI (`agy`), en modo headless con stream-json por stdin y stdout.
//
// Verificado con agy 1.5.4:
// - `--input-format stream-json --output-format stream-json`: el prompt va por stdin como
//   {"event":"user","message":{"content":"..."}} y agy termina al cerrarse stdin. Sin límite de tamaño
//   de argumentos y el prompt no queda visible en `ps`.
// - Roles de escritura: --dangerously-skip-permissions (en headless no hay a quién pedir permiso).
// - Roles de lectura: --mode plan. Sin modo explícito, agy escribe en el workspace. En 1.5.14, plan sin
//   permisos deja la respuesta vacía si quiere correr un comando: dentro del sandbox se aprueban.
// - Con allowNonWorkspaceAccess, agy lee fuera del worktree (sandbox.lectura_denegada lo limita).
// - Escribe su estado en ~/.gemini/antigravity-cli y ~/.gemini/antigravity; funciona dentro del sandbox.
// - El evento final {"event":"result","result":{status, response, error?, usage{...}}} trae los tokens.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { VERSION_MINIMA_AGY } from '../constantes.mjs';
import { expandirHome } from '../config.mjs';
import { extraerUso } from '../registro.mjs';

const MAX_STDOUT_COLA = 10;

/** settings.json de agy (ORQ_AGY_SETTINGS permite aislarlo en tests). */
export const rutaSettingsAgy = () =>
  process.env.ORQ_AGY_SETTINGS || path.join(os.homedir(), '.gemini', 'antigravity-cli', 'settings.json');

function leerSettings() {
  const ruta = rutaSettingsAgy();
  let contenido;
  try {
    contenido = fs.readFileSync(ruta, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { settings: null, avisoSettings: null };
    return { settings: null, avisoSettings: `No se pudo leer ${ruta}: ${e.message}` };
  }
  try {
    const parsed = JSON.parse(contenido);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { settings: null, avisoSettings: `${ruta} no contiene un objeto JSON válido.` };
    }
    return { settings: parsed, avisoSettings: null };
  } catch (e) {
    return { settings: null, avisoSettings: `${ruta} no es JSON válido (${e.message}); se asume cuenta personal.` };
  }
}

/** Cómo se autentica agy: API key de AI Studio, credenciales de Google Cloud (ADC) o el login personal. */
export function autenticacionAgy() {
  if (process.env.AGY_ADC_AUTH === 'true') return 'adc';
  if (leerSettings().settings?.modelProvider === 'gemini') return 'api_key';
  return 'cuenta_personal';
}

const ETIQUETAS_MODO = {
  api_key: 'API key de Gemini (AI Studio)',
  adc: 'credenciales de Google Cloud (ADC)',
  cuenta_personal: 'tu cuenta personal de Google',
};

/** Lector del stream NDJSON de agy. */
export function crearLectorAgy({ alEvento } = {}) {
  const decoder = new StringDecoder('utf8');
  let pendiente = '';
  let resultado = null;
  let errorEvento = null;
  const herramientas = {};
  const stdoutCola = [];

  const procesar = (linea) => {
    const limpia = linea.trim();
    if (!limpia) return;
    let obj;
    try {
      obj = JSON.parse(limpia);
    } catch {
      stdoutCola.push(limpia);
      if (stdoutCola.length > MAX_STDOUT_COLA) stdoutCola.shift();
      return;
    }
    if (obj?.event === 'result') resultado = obj.result ?? null;
    else if (obj?.event === 'step_update') {
      const s = obj.step_update;
      if (s?.tool_name) {
        if (s.state === 'DONE') herramientas[s.tool_name] = (herramientas[s.tool_name] ?? 0) + 1;
        alEvento?.({ tipo: 'herramienta', nombre: s.tool_name });
      }
    } else if (obj?.event === 'error') {
      const msg = obj.error?.message || obj.error || obj.message;
      errorEvento = typeof msg === 'string' ? msg : (msg ? JSON.stringify(msg) : 'error sin detalle');
    }
  };

  return {
    agregar(trozo) {
      if (trozo === undefined || trozo === null) return;
      pendiente += decoder.write(trozo);
      const lineas = pendiente.split('\n');
      pendiente = lineas.pop();
      for (const l of lineas) procesar(l);
    },
    terminar() {
      pendiente += decoder.end();
      const lineas = pendiente.split('\n');
      pendiente = '';
      for (const l of lineas) procesar(l);

      const texto = typeof resultado?.response === 'string'
        ? resultado.response
        : String(resultado?.response ?? '');
      const fallo = resultado && resultado.status !== 'SUCCESS';
      let error = null;
      if (fallo) {
        const detalle = resultado.error
          ? (typeof resultado.error === 'string' ? resultado.error : (resultado.error?.message || JSON.stringify(resultado.error)))
          : '';
        error = `estado ${resultado.status}${detalle ? `: ${detalle}` : ''}`;
      } else if (!resultado && errorEvento) {
        error = errorEvento;
      }

      return {
        resultado,
        texto,
        estado: resultado?.status ?? null,
        error,
        uso: resultado ? extraerUso(resultado.usage) : null,
        usoBruto: resultado?.usage ?? null,
        herramientas: Object.keys(herramientas).length ? herramientas : null,
        stdoutCola,
      };
    },
  };
}

export const antigravity = {
  nombre: 'antigravity',
  etiqueta: 'Antigravity',
  versionMinima: VERSION_MINIMA_AGY,
  instalar: 'https://antigravity.google/docs/install/',

  bin: (registro) => expandirHome(process.env.ORQ_AGY_BIN || registro?.antigravity?.bin || 'agy'),
  config: (registro) => registro?.antigravity ?? {},

  /**
   * Solo lectura: --mode plan. Con agy 1.5.14, en modo plan cualquier comando de shell (incluso `ls`) se
   * deniega en headless y la respuesta queda vacía; por eso, si corre dentro del sandbox (donde el sistema
   * operativo garantiza que no escribe en el repo), también se aprueban los permisos.
   */
  args(res, _skills = [], { sandbox = false } = {}) {
    const args = ['--input-format', 'stream-json', '--output-format', 'stream-json', '--model', res.slug];
    if (res.yolo) args.push('--dangerously-skip-permissions');
    else {
      args.push('--mode', 'plan');
      if (sandbox) args.push('--dangerously-skip-permissions');
    }
    return args;
  },

  entrada: (prompt) => `${JSON.stringify({ event: 'user', message: { content: prompt } })}\n`,
  lector: (_res, opts) => crearLectorAgy(opts),

  estado: () => ({
    escritura: ['~/.gemini/antigravity-cli', '~/.gemini/antigravity'],
    protegidas: [rutaSettingsAgy(), '~/.gemini/antigravity-cli/skills', '~/.gemini/antigravity/bin'],
  }),

  /** Variables que necesita (API key, ADC de Google Cloud y las suyas); el resto de tokens y claves se quitan. */
  entorno: [/^AGY_/, /^GEMINI_/, /^GOOGLE_/],
  credencialesAjenas: ['~/.commandcode/auth.json'],

  /**
   * Con el login personal, el FAQ de Antigravity dice que envolver agy en otras aplicaciones "is not
   * supported under consumer plans". orq lo permite solo si el usuario lo habilitó en el registro.
   */
  acceso(registro) {
    const { settings, avisoSettings } = leerSettings();
    const modo = process.env.AGY_ADC_AUTH === 'true'
      ? 'adc'
      : (settings?.modelProvider === 'gemini' ? 'api_key' : 'cuenta_personal');
    const permitido = modo !== 'cuenta_personal' || registro?.antigravity?.permitir_cuenta_personal === true;
    return {
      modo,
      etiquetaModo: ETIQUETAS_MODO[modo],
      avisoSettings,
      bloqueo: permitido ? null : (
        'agy usa tu cuenta personal de Google y el registro no lo permite (antigravity.permitir_cuenta_personal). ' +
        'El FAQ de Antigravity dice que envolver agy en otras aplicaciones no está soportado en planes de consumo. ' +
        'Usa una API key de AI Studio ("modelProvider": "gemini" en ~/.gemini/antigravity-cli/settings.json más GEMINI_API_KEY), ' +
        'AGY_ADC_AUTH=true con un proyecto de Google Cloud, o pide al usuario que lo habilite.'
      ),
    };
  },

  catalogo(bin) {
    const r = spawnSync(bin, ['models'], { encoding: 'utf8', timeout: 60000 });
    return {
      ok: r.status === 0 && !r.error,
      salida: r.stdout ?? '',
      error: r.error?.message || (r.status !== 0 ? (r.stderr?.trim() || `código ${r.status}`) : null),
    };
  },

  /** Slugs que deben aparecer en `agy models` para un modelo del registro. */
  idsCatalogo: (id, ficha) => [...new Set(Object.values(ficha.efforts ?? {}))],
};
