// orq doctor
// Diagnostica la instalación global y, si estás dentro de un repo, su configuración.

import fs from 'node:fs';
import path from 'node:path';
import { cargarRegistro, SALIDA } from '../lib/registro.mjs';
import {
  RUTA_REGISTRO, RAIZ_ORQ, dirConfigClaude, rutaSkillGlobal, registroEfectivo, ARCHIVO_REPO,
} from '../lib/config.mjs';
import { git, compararVersiones } from '../lib/util.mjs';
import { AGENTES, leerVersion } from '../lib/constantes.mjs';
import { configSandbox, sandboxDisponible } from '../lib/sandbox.mjs';
import { EJECUTORES, ejecutoresEnUso, versionEjecutor } from '../lib/ejecutores/index.mjs';
import { rutaSettingsAgy } from '../lib/ejecutores/antigravity.mjs';

function enPath(nombre) {
  return (process.env.PATH ?? '').split(path.delimiter).some((d) => d && fs.existsSync(path.join(d, nombre)));
}

export async function ejecutar() {
  let fallas = 0;
  const ok = (m) => process.stdout.write(`✔ ${m}\n`);
  const mal = (m, sugerencia) => { fallas++; process.stdout.write(`✘ ${m}${sugerencia ? `\n    → ${sugerencia}` : ''}\n`); };
  const aviso = (m, sugerencia) => process.stdout.write(`! ${m}${sugerencia ? `\n    → ${sugerencia}` : ''}\n`);

  process.stdout.write(`orq ${leerVersion()} en ${RAIZ_ORQ}\n\n`);

  const node = process.versions.node;
  if (compararVersiones(node, '20.0.0') >= 0) ok(`Node ${node}`); else mal(`Node ${node} (se necesita 20 o superior)`);

  if (git(['--version'], process.cwd(), { permitirFallo: true })) ok('git disponible'); else mal('git no está disponible');

  let registro = null;
  try {
    registro = cargarRegistro(RUTA_REGISTRO);
    ok(`Registro válido (${Object.keys(registro.models).length} modelo(s), ${Object.keys(registro.roles).length} roles)`);
  } catch (e) {
    mal(`Registro inválido: ${e.message}`, `Corrige ${RUTA_REGISTRO}`);
  }

  if (fs.existsSync(`${RUTA_REGISTRO}.nuevo`)) {
    aviso('Hay una versión nueva del registro sin revisar', `Compara: diff ${RUTA_REGISTRO} ${RUTA_REGISTRO}.nuevo`);
  }

  // Ejecutores de los modelos del registro (sin registro válido, al menos Command Code).
  const ejecutores = registro ? ejecutoresEnUso(registro) : [EJECUTORES.command_code];
  for (const ej of ejecutores) {
    const bin = ej.bin(registro);
    const v = versionEjecutor(ej, bin);
    if (!v.instalado) mal(`${ej.etiqueta} no encontrado (${bin})`, ej.instalar);
    else if (!v.suficiente) mal(`${ej.etiqueta} ${v.version ?? '?'} (se necesita >= ${ej.versionMinima})`, ej.instalar);
    else ok(`${ej.etiqueta} ${v.version}`);
    if (registro && ej.nombre !== 'command_code') {
      const acceso = ej.acceso(registro);
      if (acceso.bloqueo) {
        aviso(`${ej.etiqueta} usa ${acceso.etiquetaModo} y el registro no lo permite: orq bloqueará sus modelos`,
          `${ej.nombre}.permitir_cuenta_personal en ${RUTA_REGISTRO}, o una API key`);
      } else ok(`${ej.etiqueta}: ${acceso.etiquetaModo}${acceso.modo === 'cuenta_personal' ? ' (permitida en el registro)' : ''}`);
    }
    if (registro && ej.nombre === 'antigravity') {
      let ajustesAgy = null;
      try {
        ajustesAgy = JSON.parse(fs.readFileSync(rutaSettingsAgy(), 'utf8'));
      } catch { /* sin settings de agy */ }
      if (ajustesAgy?.allowNonWorkspaceAccess === true && !configSandbox(registro).lectura_denegada.length) {
        aviso(
          'agy tiene allowNonWorkspaceAccess: true y sandbox.lectura_denegada está vacío: puede leer otros repos y carpetas',
          'agrega la carpeta de tus repos a sandbox.lectura_denegada (p. ej. ["~/dev"]); el repo de la tarea sigue legible',
        );
      }
    }
  }

  if (registro) {
    const cc = registro.command_code ?? {};
    const pendientes = ['skills_compatibles', 'salida_json'].filter((k) => cc[k] === null || cc[k] === undefined);
    if (ejecutores.some((e) => e.nombre === 'command_code')) {
      if (pendientes.length) aviso(`Fase 0 pendiente: falta verificar ${pendientes.join(' y ')}`, 'orq verificar --guardar');
      else ok(`Skills a Command Code: ${cc.skills_compatibles ? 'sí' : 'no'} · salida JSON con tokens: ${cc.salida_json ? 'sí' : 'no'}`);
    }

    const { modo } = configSandbox(registro);
    if (modo === 'desactivado') aviso('Sandbox desactivado: los modelos delegados corren con todos tus permisos', 'sandbox.modo: auto');
    else {
      const d = sandboxDisponible();
      if (d.tipo) ok(`Sandbox ${d.tipo} (modo ${modo})`);
      else if (modo === 'obligatorio') mal(`Sandbox obligatorio pero no disponible: ${d.motivo}`);
      else aviso(`Sandbox no disponible: ${d.motivo}`, process.platform === 'linux' ? 'Instala bubblewrap (bwrap)' : undefined);
    }
  }

  const skill = rutaSkillGlobal();
  if (!fs.existsSync(skill)) mal(`Falta la skill global en ${skill}`, 'Reinstala con node instalar.mjs');
  else if (fs.readFileSync(skill, 'utf8').includes('ENRUTAMIENTO:INICIO')) aviso('La skill orquestar es de una versión anterior', 'Reinstala con node instalar.mjs');
  else ok('Skill orquestar instalada');

  const dirAgentes = path.join(dirConfigClaude(), 'agents');
  const faltan = AGENTES.filter((a) => !fs.existsSync(path.join(dirAgentes, `${a}.md`)));
  if (faltan.length) mal(`Faltan subagentes: ${faltan.join(', ')}`, 'Reinstala con node instalar.mjs');
  else ok('Subagentes nativos instalados');

  if (enPath('orq')) ok('orq está en el PATH');
  else aviso('orq no está en el PATH de esta terminal', 'Abre una terminal nueva o ejecuta: source ~/.zshrc');

  const rutaSettings = path.join(dirConfigClaude(), 'settings.json');
  try {
    const permisos = JSON.parse(fs.readFileSync(rutaSettings, 'utf8')).permissions ?? {};
    const tieneAllow = permisos.allow?.includes('Bash(orq delegar *)');
    const tieneDeny = permisos.deny?.includes('Bash(cmd *)');
    if (tieneAllow && tieneDeny) ok('Permisos de Claude Code configurados');
    else mal('Faltan reglas del orquestador en settings.json', 'Reinstala con node instalar.mjs');
  } catch {
    mal(`No se pudo leer ${rutaSettings}`, 'Reinstala con node instalar.mjs');
  }

  const raiz = git(['rev-parse', '--show-toplevel'], process.cwd(), { permitirFallo: true });
  if (raiz && registro) {
    process.stdout.write(`\nRepo actual: ${raiz}\n`);
    if (fs.existsSync(path.join(raiz, '.claude', 'orquestador', 'bin'))) {
      aviso(
        'Este repo tiene una instalación por repo de la versión 0.1',
        'Ya no hace falta: borra .claude/orquestador/, .claude/skills/orquestar/ y los agentes copiados, y quita sus reglas de .claude/settings.json',
      );
    }
    try {
      const { sensibilidad, ajustes, repo } = registroEfectivo(raiz);
      ok(`Ajustes del repo: ${ajustes ? ARCHIVO_REPO : 'ninguno (valores globales)'}`);
      if (repo.desactivado) aviso('El orquestador está desactivado en este repo');
      if (sensibilidad.sensible) ok(`Repo sensible: ${sensibilidad.motivos.join('; ')}`);
      else ok('Repo no sensible');
      if (sensibilidad.intentoDesmarcar) aviso(`${ARCHIVO_REPO} intenta desmarcar un repo que el patrón global marca como sensible`);
    } catch (e) {
      mal(e.message);
    }
  }

  process.stdout.write(fallas ? `\n${fallas} problema(s).\n` : '\nTodo en orden.\n');
  return fallas ? 1 : SALIDA.OK;
}
