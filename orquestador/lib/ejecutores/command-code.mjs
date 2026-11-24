// Ejecutor Command Code (`cmd -p`). El prompt va por stdin; con salida_json, la salida es NDJSON.

import { spawnSync } from 'node:child_process';
import { VERSION_MINIMA_CMD } from '../constantes.mjs';
import { crearLectorJson } from '../salida-cmd.mjs';

export const commandCode = {
  nombre: 'command_code',
  etiqueta: 'Command Code',
  versionMinima: VERSION_MINIMA_CMD,
  instalar: 'npm i -g command-code@latest',

  bin: (registro) => process.env.ORQ_CMD_BIN || registro?.command_code?.bin || 'cmd',
  config: (registro) => registro?.command_code ?? {},

  /** Argumentos de `cmd` para una delegación resuelta. Las skills deben venir como rutas absolutas. */
  args(res, skillsAbsolutas = []) {
    const args = ['-p', '--model', res.modelo, '--effort', res.effort];
    if (res.yolo) args.push('--yolo');
    for (const s of skillsAbsolutas) args.push('--skill', s);
    if (res.salida_json) args.push('--output-format', 'json');
    args.push('--skip-onboarding');
    return args;
  },

  entrada: (prompt) => prompt,
  lector: (res) => (res.salida_json ? crearLectorJson() : null),

  /** Carpetas de estado que necesita escribir dentro del sandbox, y la configuración que no puede tocar. */
  /**
   * Carpetas de estado que necesita escribir dentro del sandbox, y lo que no puede tocar: configuración,
   * instrucciones (AGENTS.md, taste), confianza en hooks de proyecto, scripts y aprobaciones de quality gates.
   * Si una versión de Command Code necesitara escribir alguno de estos en cada corrida, la Fase 0 lo muestra.
   */
  estado: () => ({
    escritura: ['~/.commandcode'],
    protegidas: [
      'settings.json', 'settings.local.json', 'AGENTS.md', 'mcp.json', 'hooks', 'agents', 'commands', 'skills',
      'trusted-hooks.json', 'taste', 'scripts', '.cc-global-pack',
    ].map((n) => `~/.commandcode/${n}`),
  }),

  /** Variables de entorno que necesita aunque parezcan secretos (el resto de tokens y claves se quitan). */
  entorno: [/^CMD_/, /^COMMANDCODE_/, /^COMMAND_CODE_/],
  /** Credenciales de otros ejecutores, que no tiene por qué leer. */
  credencialesAjenas: ['~/.gemini/oauth_creds.json', '~/.gemini/google_accounts.json'],

  acceso: () => ({ modo: 'cuenta', etiquetaModo: 'tu cuenta de Command Code', bloqueo: null }),

  /** Catálogo de modelos (texto), o null si falla. */
  catalogo(bin) {
    const r = spawnSync(bin, ['--list-models'], { encoding: 'utf8', timeout: 60000 });
    return r.status === 0 ? `${r.stdout ?? ''}${r.stderr ?? ''}` : null;
  },

  /** Ids que deben aparecer en el catálogo para un modelo del registro. */
  idsCatalogo: (id) => [id],
};
