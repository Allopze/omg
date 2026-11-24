// Constantes sin dependencias externas: también las usa instalar.mjs antes de instalar `yaml`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Carpeta del código (…/.claude/orquestador una vez instalado). */
export const RAIZ_ORQ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Subagentes nativos que instala el orquestador en ~/.claude/agents/. */
export const AGENTES = ['Explore', 'analista-sonnet', 'implementador-sonnet', 'documentador-haiku'];

/** Versión mínima de Command Code: --model en modo headless. */
export const VERSION_MINIMA_CMD = '0.26.21';

/** Versión mínima de Antigravity CLI: la primera con la que se verificaron stream-json, --mode plan y el sandbox. */
export const VERSION_MINIMA_AGY = '1.5.4';

/** CLIs que pueden ejecutar los modelos delegados. Cada modelo del registro declara el suyo. */
export const NOMBRES_EJECUTORES = ['command_code', 'antigravity'];

export const MODOS_SANDBOX = ['auto', 'obligatorio', 'desactivado'];
export const UBICACIONES_WORKTREE = ['repo', 'externa'];

export function leerVersion(raiz = RAIZ_ORQ) {
  return fs.readFileSync(path.join(raiz, 'VERSION'), 'utf8').trim();
}
