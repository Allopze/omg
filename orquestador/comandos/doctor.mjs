// orq doctor
// Diagnostica la instalación global y, si estás dentro de un repo, su configuración.

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { cargarRegistro, SALIDA } from '../lib/registro.mjs';
import {
  RUTA_REGISTRO, RAIZ_ORQ, DIR_DATOS, dirConfigClaude, rutaSkillGlobal, registroEfectivo, expandirHome, ARCHIVO_REPO,
} from '../lib/config.mjs';
import { raizRepo, compararVersiones, binDisponible, git } from '../lib/util.mjs';
import { AGENTES, leerVersion } from '../lib/constantes.mjs';
import { configSandbox, sandboxDisponible } from '../lib/sandbox.mjs';
import {
  EJECUTORES, ejecutoresEnUso, ejecutorRequerido, versionEjecutor, salidaJsonEfectiva,
} from '../lib/ejecutores/index.mjs';
import { rutaSettingsAgy } from '../lib/ejecutores/antigravity.mjs';

export const AYUDA = [
  'Uso: orq doctor',
  '',
  'Diagnostica la instalación global del orquestador (Node, git, registro, ejecutores,',
  'Fase 0, sandbox, skill, subagentes, PATH y permisos) y, si estás dentro de un repo,',
  'su configuración efectiva.',
  '',
  'Opciones:',
  '  -h, --help  Muestra esta ayuda.',
  '',
].join('\n');

const REINSTALAR = 'Reinstala con: npx -y github:allopze/omg (o instalar.sh / node instalar.mjs)';

const PERMISOS_POR_DEFECTO = {
  allow: [
    'Bash(orq delegar *)',
    'Bash(orq revision *)',
    'Bash(orq validar *)',
    'Bash(orq ver *)',
    'Bash(orq estado)',
    'Bash(orq estado *)',
    'Bash(orq scorecard)',
    'Bash(orq scorecard *)',
    'Bash(orq doctor)',
    'Bash(git diff *)',
    'Bash(git log *)',
    'Bash(git status)',
    'Bash(git status *)',
    'Bash(git worktree list)',
  ],
  deny: [
    'Bash(cmd)',
    'Bash(cmd *)',
    'Bash(command-code *)',
    'Bash(npx command-code *)',
    'Bash(agy)',
    'Bash(agy *)',
    'Edit(~/.gemini/antigravity-cli/settings.json)',
    'Edit(/{{ORQ_DIR}}/**)',
    'Edit(./.claude/orquestador.yaml)',
  ],
};

function leerPlantillaPermisos() {
  const ruta = path.join(RAIZ_ORQ, '..', 'permisos.json');
  try {
    if (fs.existsSync(ruta)) {
      const parsed = JSON.parse(fs.readFileSync(ruta, 'utf8'));
      if (Array.isArray(parsed?.allow) && Array.isArray(parsed?.deny)) return parsed;
    }
  } catch { /* usar copia incluida */ }
  return PERMISOS_POR_DEFECTO;
}

function sugerenciaPath() {
  const shell = path.basename(process.env.SHELL ?? '');
  if (shell === 'zsh') {
    const zshrc = process.env.ZDOTDIR ? path.join(process.env.ZDOTDIR, '.zshrc') : '~/.zshrc';
    return `Abre una terminal nueva o ejecuta: source ${zshrc}`;
  }
  if (shell === 'bash') {
    const rc = process.platform === 'darwin' ? '~/.bash_profile' : '~/.bashrc';
    return `Abre una terminal nueva o ejecuta: source ${rc}`;
  }
  if (shell === 'fish') {
    return 'Abre una terminal nueva o ejecuta: source ~/.config/fish/conf.d/orquestador.fish';
  }
  return 'Abre una terminal nueva o agrega la carpeta de orq (p. ej. ~/.local/bin) a tu PATH';
}

export async function ejecutar(argv = []) {
  const { values } = parseArgs({
    args: argv,
    options: { help: { type: 'boolean', short: 'h', default: false } },
  });
  if (values.help) {
    process.stdout.write(AYUDA);
    return SALIDA.OK;
  }

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
    const requerido = registro ? ejecutorRequerido(registro, ej) : true;
    if (!v.instalado) {
      if (!requerido) aviso(`${ej.etiqueta} (opcional) no encontrado (${bin})`, ej.instalar);
      else mal(`${ej.etiqueta} no encontrado (${bin})`, ej.instalar);
      continue;
    }
    if (!v.suficiente) mal(`${ej.etiqueta} ${v.version ?? '?'} (se necesita >= ${ej.versionMinima})`, ej.instalar);
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
    const ejCc = EJECUTORES.command_code;
    if (ejecutores.some((e) => e.nombre === 'command_code')) {
      const cc = registro.command_code ?? {};
      const binCc = ejCc.bin(registro);
      const jsonEf = salidaJsonEfectiva(registro, ejCc, binCc);
      const pendientes = [];
      if (cc.skills_compatibles === null || cc.skills_compatibles === undefined) pendientes.push('skills_compatibles');
      if ((cc.salida_json === null || cc.salida_json === undefined) && !jsonEf.automatico) pendientes.push('salida_json');
      const etiquetaJson = jsonEf.activo
        ? (jsonEf.automatico ? `sí (auto con cmd ${jsonEf.version})` : 'sí')
        : 'no';
      if (pendientes.length) {
        const notaAuto = jsonEf.automatico ? ` (salida JSON activa automáticamente con cmd ${jsonEf.version})` : '';
        aviso(`Fase 0 pendiente: falta verificar ${pendientes.join(' y ')}${notaAuto}`, 'orq verificar --capacidades --guardar');
      } else {
        ok(`Skills a Command Code: ${cc.skills_compatibles ? 'sí' : 'no'} · salida JSON con tokens: ${etiquetaJson}`);
      }
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
  if (!fs.existsSync(skill)) mal(`Falta la skill global en ${skill}`, REINSTALAR);
  else if (fs.readFileSync(skill, 'utf8').includes('ENRUTAMIENTO:INICIO')) aviso('La skill orquestar es de una versión anterior', REINSTALAR);
  else ok('Skill orquestar instalada');

  const dirAgentes = path.join(dirConfigClaude(), 'agents');
  const faltan = AGENTES.filter((a) => !fs.existsSync(path.join(dirAgentes, `${a}.md`)));
  if (faltan.length) mal(`Faltan subagentes: ${faltan.join(', ')}`, REINSTALAR);
  else ok('Subagentes nativos instalados');

  if (binDisponible('orq')) ok('orq está en el PATH');
  else aviso('orq no está en el PATH de esta terminal', sugerenciaPath());

  const rutaSettings = path.join(dirConfigClaude(), 'settings.json');
  try {
    const permisos = JSON.parse(fs.readFileSync(rutaSettings, 'utf8')).permissions ?? {};
    const destClaude = path.join(dirConfigClaude(), 'orquestador');
    const plantilla = leerPlantillaPermisos();
    const faltantes = [];
    for (const r of plantilla.allow) {
      if (!(permisos.allow ?? []).includes(r)) faltantes.push(`allow: ${r}`);
    }
    for (const r of plantilla.deny) {
      if (r.includes('{{ORQ_DIR}}')) {
        const esperada = r.replaceAll('{{ORQ_DIR}}', destClaude);
        const alt = r.replaceAll('{{ORQ_DIR}}', DIR_DATOS);
        if (!(permisos.deny ?? []).includes(esperada) && !(permisos.deny ?? []).includes(alt)) {
          faltantes.push(`deny: ${esperada}`);
        }
      } else if (!(permisos.deny ?? []).includes(r)) {
        faltantes.push(`deny: ${r}`);
      }
    }
    if (!faltantes.length) ok('Permisos de Claude Code configurados');
    else mal(`Faltan reglas del orquestador en settings.json (${faltantes.length}): ${faltantes.join(', ')}`, REINSTALAR);

    if (registro?.worktrees?.ubicacion === 'externa') {
      const dirExternoCrudo = registro.worktrees.dir_externo ?? '~/.orquestador/worktrees';
      const dirExterno = path.resolve(expandirHome(dirExternoCrudo));
      const adicionales = Array.isArray(permisos.additionalDirectories) ? permisos.additionalDirectories : [];
      const cubierto = adicionales.some((d) => {
        if (typeof d !== 'string' || !d.trim()) return false;
        const abs = path.resolve(expandirHome(d));
        return dirExterno === abs || dirExterno.startsWith(`${abs}${path.sep}`);
      });
      if (cubierto) ok(`Worktrees externos cubiertos en permissions.additionalDirectories (${dirExternoCrudo})`);
      else {
        aviso(
          `worktrees.ubicacion es "externa" pero "${dirExternoCrudo}" no está en permissions.additionalDirectories de ${rutaSettings}`,
          `Agrega "${dirExternoCrudo}" a permissions.additionalDirectories en ${rutaSettings} para que los subagentes puedan editar allí`,
        );
      }
    }
  } catch {
    mal(`No se pudo leer ${rutaSettings}`, REINSTALAR);
  }

  let raiz = null;
  try {
    raiz = raizRepo();
  } catch { /* fuera de un repositorio git */ }
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
