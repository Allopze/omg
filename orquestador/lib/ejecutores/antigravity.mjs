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
import { VERSION_MINIMA_AGY } from '../constantes.mjs';
import { extraerUso } from '../registro.mjs';

/** settings.json de agy (ORQ_AGY_SETTINGS permite aislarlo en tests). */
export const rutaSettingsAgy = () =>
  process.env.ORQ_AGY_SETTINGS || path.join(os.homedir(), '.gemini', 'antigravity-cli', 'settings.json');

function leerSettings() {
  try {
    return JSON.parse(fs.readFileSync(rutaSettingsAgy(), 'utf8'));
  } catch {
    return null;
  }
}

/** Cómo se autentica agy: API key de AI Studio, credenciales de Google Cloud (ADC) o el login personal. */
export function autenticacionAgy() {
  if (process.env.AGY_ADC_AUTH === 'true') return 'adc';
  if (leerSettings()?.modelProvider === 'gemini') return 'api_key';
  return 'cuenta_personal';
}

const ETIQUETAS_MODO = {
  api_key: 'API key de Gemini (AI Studio)',
  adc: 'credenciales de Google Cloud (ADC)',
  cuenta_personal: 'tu cuenta personal de Google',
};

/** Lector del stream NDJSON de agy. */
export function crearLectorAgy() {
  let pendiente = '';
  let resultado = null;
  const herramientas = {};

  const procesar = (linea) => {
    if (!linea.trim()) return;
    let obj;
    try {
      obj = JSON.parse(linea);
    } catch {
      return;
    }
    if (obj?.event === 'result') resultado = obj.result ?? null;
    else if (obj?.event === 'step_update') {
      const s = obj.step_update;
      if (s?.tool_name && s.state === 'DONE') herramientas[s.tool_name] = (herramientas[s.tool_name] ?? 0) + 1;
    }
  };

  return {
    agregar(trozo) {
      pendiente += trozo.toString();
      const lineas = pendiente.split('\n');
      pendiente = lineas.pop();
      for (const l of lineas) procesar(l);
    },
    terminar() {
      procesar(pendiente);
      pendiente = '';
      const fallo = resultado && resultado.status !== 'SUCCESS';
      return {
        resultado,
        texto: resultado?.response ?? '',
        estado: resultado?.status ?? null,
        error: fallo ? `estado ${resultado.status}${resultado.error ? `: ${resultado.error}` : ''}` : null,
        uso: resultado ? extraerUso(resultado.usage) : null,
        usoBruto: resultado?.usage ?? null,
        herramientas: Object.keys(herramientas).length ? herramientas : null,
      };
    },
  };
}

export const antigravity = {
  nombre: 'antigravity',
  etiqueta: 'Antigravity',
  versionMinima: VERSION_MINIMA_AGY,
  instalar: 'https://antigravity.google/docs/install/',

  bin: (registro) => process.env.ORQ_AGY_BIN || registro?.antigravity?.bin || 'agy',
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
  lector: () => crearLectorAgy(),

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
    const modo = autenticacionAgy();
    const permitido = modo !== 'cuenta_personal' || registro?.antigravity?.permitir_cuenta_personal === true;
    return {
      modo,
      etiquetaModo: ETIQUETAS_MODO[modo],
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
    return r.status === 0 ? `${r.stdout ?? ''}` : null;
  },

  /** Slugs que deben aparecer en `agy models` para un modelo del registro. */
  idsCatalogo: (id, ficha) => [...new Set(Object.values(ficha.efforts ?? {}))],
};
