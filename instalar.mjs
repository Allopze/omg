#!/usr/bin/env node
// Instalador global del orquestador multimodelo (Claude Code + Command Code).
//
// Uso:
//   node instalar.mjs                 Instala o actualiza para tu usuario (todos los repos).
//   node instalar.mjs --simular       Muestra lo que haría, sin tocar nada.
//   node instalar.mjs --desinstalar   Quita todo lo instalado (respalda registro y logs).
//
// Opciones:
//   --forzar        Reemplaza subagentes modificados por ti y un `orq` ajeno en el PATH.
//   --sin-path      No toca tu archivo de shell (agrega ~/.local/bin al PATH tú mismo).
//   --borrar-todo   Con --desinstalar, no respalda registro ni logs.
//
// Respeta CLAUDE_CONFIG_DIR. Variables para casos especiales: ORQ_BIN_DIR (carpeta del comando orq).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AGENTES, leerVersion } from './orquestador/lib/constantes.mjs';
import { hashRegistro, conservarAjustes } from './orquestador/lib/registro-texto.mjs';

const ORIGEN = path.dirname(fs.realpathSync(fileURLToPath(import.meta.url)));
const argv = new Set(process.argv.slice(2));
const OPC = {
  simular: argv.has('--simular'),
  desinstalar: argv.has('--desinstalar'),
  forzar: argv.has('--forzar'),
  sinPath: argv.has('--sin-path'),
  borrarTodo: argv.has('--borrar-todo'),
};
const desconocidas = [...argv].filter((a) => !['--simular', '--desinstalar', '--forzar', '--sin-path', '--borrar-todo'].includes(a));
if (desconocidas.length) fallar(`Opción desconocida: ${desconocidas.join(', ')}`);

const HOME = os.homedir();
const expandir = (p) => (p.startsWith('~/') ? path.join(HOME, p.slice(2)) : p);
const CONFIG = process.env.CLAUDE_CONFIG_DIR ? path.resolve(expandir(process.env.CLAUDE_CONFIG_DIR)) : path.join(HOME, '.claude');
const DEST = path.join(CONFIG, 'orquestador');
const MANIFIESTO = path.join(DEST, 'instalacion.json');
const BIN_DIR = process.env.ORQ_BIN_DIR ? path.resolve(expandir(process.env.ORQ_BIN_DIR)) : path.join(HOME, '.local', 'bin');
const SHIM = path.join(BIN_DIR, 'orq');
const MARCA_SHIM = '# orquestador-multimodelo';
const BLOQUE_INI = '# >>> orquestador >>>';
const BLOQUE_FIN = '# <<< orquestador <<<';
// Lo que no es código en DEST: se conserva en cada actualización.
const DATOS = new Set(['models.yaml', 'models.yaml.nuevo', 'models.yaml.anterior', 'logs', 'instalacion.json']);
// Lo que trae el paquete y no se instala.
const NO_INSTALAR = new Set(['models.yaml', 'node_modules', 'logs', 'test']);
// Código de versiones anteriores que ya no existe en el paquete.
const OBSOLETO = ['test'];
// Huellas (hashRegistro: sin los ajustes del usuario) de los models.yaml publicados. Si el tuyo coincide
// con una, no lo modificaste y se actualiza.
const REGISTROS_PUBLICADOS = [
  '57c4d81287401435b259ff6d41d77487c3a323dca6f2dbc1a8e40fbcaa07adb1', // 0.2.0
  '1d65eb4dae62c967b6d8d079e302030cd913fb5dc584f96f063cf83fd0867dae', // 0.4.0 (primera publicación)
  'f53a1816a7e8a0094814f9e0eb378ec5224931e84bada00bae9a0e3ba1cce76d', // 0.4.0
  'bbc5dc8000390572ba92460fc9d0c3ca020cf20434452301bd582a24d2ad1778', // 0.4.1 (pre-publicación)
  '6a6201a22c80cbbed2eb302c45804cae3fca844e7b91e54e5fa5c848141f8a70', // 0.4.1
  '8d5a1983172217096795a523749e9de053898ff9938d9f698dffa039fc6278d8', // 0.4.1 (actual)
];

function fallar(mensaje) {
  process.stderr.write(`✘ ${mensaje}\n`);
  process.exit(1);
}
const paso = (m) => process.stdout.write(`${OPC.simular ? '· (simulado) ' : '· '}${m}\n`);
const nota = (m) => process.stdout.write(`  ${m}\n`);
const hacer = (fn) => { if (!OPC.simular) fn(); };
const hash = (ruta) => crypto.createHash('sha256').update(fs.readFileSync(ruta)).digest('hex');
const shQuote = (s) => `'${s.replace(/'/g, "'\\''")}'`;
const leerJson = (ruta, porDefecto) => (fs.existsSync(ruta) ? JSON.parse(fs.readFileSync(ruta, 'utf8')) : porDefecto);
const escribirJson = (ruta, datos) => fs.writeFileSync(ruta, `${JSON.stringify(datos, null, 2)}\n`);
const corto = (p) => (p.startsWith(HOME) ? `~${p.slice(HOME.length)}` : p);
const leerPlantillaPermisos = () => JSON.parse(
  fs.readFileSync(path.join(ORIGEN, 'permisos.json'), 'utf8').replaceAll('{{ORQ_DIR}}', JSON.stringify(DEST).slice(1, -1)),
);

function comando(bin, args, opciones = {}) {
  const r = spawnSync(bin, args, { encoding: 'utf8', ...opciones });
  return r.error || r.status !== 0 ? null : `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
}

function archivoShell() {
  const shell = path.basename(process.env.SHELL ?? '');
  if (shell === 'zsh') return { tipo: 'zsh', ruta: path.join(process.env.ZDOTDIR || HOME, '.zshrc') };
  if (shell === 'bash') return { tipo: 'bash', ruta: path.join(HOME, process.platform === 'darwin' ? '.bash_profile' : '.bashrc') };
  if (shell === 'fish') return { tipo: 'fish', ruta: path.join(HOME, '.config', 'fish', 'conf.d', 'orquestador.fish') };
  return null;
}

function quitarBloque(texto) {
  const re = new RegExp(`\\n?${BLOQUE_INI}[\\s\\S]*?${BLOQUE_FIN}\\n?`, 'g');
  return texto.replace(re, '\n').replace(/\n{3,}$/, '\n');
}

function copiarArbol(origen, destino) {
  fs.mkdirSync(destino, { recursive: true });
  for (const nombre of fs.readdirSync(origen)) {
    if (nombre === 'node_modules') continue;
    const o = path.join(origen, nombre);
    const d = path.join(destino, nombre);
    if (fs.statSync(o).isDirectory()) copiarArbol(o, d);
    else fs.copyFileSync(o, d);
  }
}

// Antes de tocar nada, settings.json y el manifiesto tienen que ser JSON válido: si no, se corta aquí,
// sin dejar una instalación o una desinstalación a medias.
const RUTA_SETTINGS = path.join(CONFIG, 'settings.json');
function leerJsonValido(ruta, porDefecto, consejo = '') {
  try {
    return leerJson(ruta, porDefecto);
  } catch {
    return fallar(`${corto(ruta)} no es JSON válido; corrígelo${consejo} y vuelve a ejecutar el instalador. No se modificó nada.`);
  }
}
const SETTINGS = leerJsonValido(RUTA_SETTINGS, {});
const MANIFIESTO_LEIDO = leerJsonValido(MANIFIESTO, null, ' (o bórralo si no lo editaste)');

// ───────────────────────────── desinstalar ─────────────────────────────
if (OPC.desinstalar) {
  process.stdout.write(`Desinstalando el orquestador de ${corto(CONFIG)}\n\n`);
  const man = MANIFIESTO_LEIDO;
  if (!man) nota('No encontré instalacion.json; se quitará lo que se pueda reconocer.');

  if (fs.existsSync(DEST) && !OPC.borrarTodo) {
    const sello = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const respaldo = path.join(CONFIG, `orquestador-respaldo-${sello}`);
    paso(`Respaldo del registro y los logs en ${corto(respaldo)}`);
    hacer(() => {
      fs.mkdirSync(respaldo, { recursive: true });
      for (const n of ['models.yaml', 'logs']) {
        const o = path.join(DEST, n);
        if (fs.existsSync(o)) fs.cpSync(o, path.join(respaldo, n), { recursive: true });
      }
    });
  }
  const dirSkill = path.join(CONFIG, 'skills', 'orquestar');
  if (fs.existsSync(dirSkill)) { paso('Quitar la skill orquestar'); hacer(() => fs.rmSync(dirSkill, { recursive: true, force: true })); }

  for (const a of AGENTES) {
    const ruta = path.join(CONFIG, 'agents', `${a}.md`);
    if (!fs.existsSync(ruta)) continue;
    const origen = path.join(ORIGEN, 'agents', `${a}.md`);
    const nuestro = man ? man.agentes?.[a] : (fs.existsSync(origen) ? hash(origen) : null);
    if (nuestro && nuestro === hash(ruta)) { paso(`Quitar el subagente ${a}`); hacer(() => fs.rmSync(ruta)); }
    else nota(`Se conserva el subagente ${a}: no lo instaló el orquestador o lo modificaste.`);
  }

  const reglas = man?.reglas ?? (fs.existsSync(path.join(ORIGEN, 'permisos.json')) ? leerPlantillaPermisos() : null);
  if (reglas && fs.existsSync(RUTA_SETTINGS)) {
    const tieneReglas = ['allow', 'deny'].some((clave) => SETTINGS.permissions?.[clave]?.some((r) => reglas[clave]?.includes(r)));
    if (tieneReglas) {
      paso('Quitar las reglas de permisos del orquestador de settings.json');
      hacer(() => {
        const s = SETTINGS;
        for (const clave of ['allow', 'deny']) {
          if (s.permissions?.[clave]) s.permissions[clave] = s.permissions[clave].filter((r) => !reglas[clave]?.includes(r));
        }
        escribirJson(RUTA_SETTINGS, s);
      });
    }
  }

  if (fs.existsSync(SHIM) && fs.readFileSync(SHIM, 'utf8').includes(MARCA_SHIM)) {
    paso(`Quitar ${corto(SHIM)}`);
    hacer(() => fs.rmSync(SHIM));
  }

  const shell = man?.shell ?? archivoShell();
  if (shell?.ruta && fs.existsSync(shell.ruta)) {
    const contenido = shell.tipo === 'fish' ? '' : fs.readFileSync(shell.ruta, 'utf8');
    if (shell.tipo === 'fish' || contenido.includes(BLOQUE_INI)) {
      paso(`Quitar la línea de PATH de ${corto(shell.ruta)}`);
      hacer(() => {
        if (shell.tipo === 'fish') fs.rmSync(shell.ruta);
        else fs.writeFileSync(shell.ruta, quitarBloque(contenido));
      });
    }
  }
  if (fs.existsSync(DEST)) { paso(`Quitar ${corto(DEST)}`); hacer(() => fs.rmSync(DEST, { recursive: true, force: true })); }
  if (fs.existsSync(`${RUTA_SETTINGS}.bak-orquestador`)) nota(`Queda tu respaldo de settings.json de antes de instalar: ${corto(RUTA_SETTINGS)}.bak-orquestador`);
  process.stdout.write(`\n${OPC.simular ? 'Simulación terminada.' : 'Orquestador desinstalado.'} Los worktrees y .claude/orquestador.yaml de cada repo no se tocan.\n`);
  process.exit(0);
}

// ───────────────────────────── instalar ─────────────────────────────
const version = leerVersion(path.join(ORIGEN, 'orquestador'));
const anterior = MANIFIESTO_LEIDO;
process.stdout.write(
  `${anterior ? `Actualizando el orquestador ${anterior.version} → ${version}` : `Instalando el orquestador ${version}`} en ${corto(CONFIG)}\n\n`,
);

// 0. Requisitos
const [mayor] = process.versions.node.split('.').map(Number);
if (mayor < 20) fallar(`Se necesita Node 20 o superior (tienes ${process.versions.node}).`);
if (!comando('git', ['--version'])) fallar('git no está disponible.');
if (!comando('npm', ['--version'])) fallar('npm no está disponible.');
if (fs.existsSync(SHIM) && !fs.readFileSync(SHIM, 'utf8').includes(MARCA_SHIM) && !OPC.forzar) {
  fallar(`Ya existe ${corto(SHIM)} y no es del orquestador. Usa --forzar para reemplazarlo u ORQ_BIN_DIR para otra carpeta.`);
}
const cmdVersion = comando(process.env.ORQ_CMD_BIN || 'cmd', ['--version']);
nota(cmdVersion ? `Command Code detectado: ${cmdVersion.split('\n')[0]}` : 'Command Code no detectado: instálalo con npm i -g command-code@latest');
const agyVersion = comando(process.env.ORQ_AGY_BIN || 'agy', ['--version']);
nota(agyVersion ? `Antigravity CLI detectado: ${agyVersion.split('\n')[0]}` : 'Antigravity CLI (agy) no detectado: opcional, solo para los modelos antigravity/*.');
nota(comando('claude', ['--version']) ? 'Claude Code detectado.' : 'Claude Code no detectado en el PATH (no es obligatorio para instalar).');
process.stdout.write('\n');

const manifiesto = {
  version,
  fecha: new Date().toISOString(),
  agentes: { ...(anterior?.agentes ?? {}) },
  reglas: { allow: [...(anterior?.reglas?.allow ?? [])], deny: [...(anterior?.reglas?.deny ?? [])] },
  shell: anterior?.shell ?? null,
  registro: anterior?.registro ?? null,
};

// 1. Código y dependencias. Se arma en una carpeta aparte (con npm ci) y después se reemplaza por
//    renombres: si npm ci falla, la instalación anterior queda intacta. El registro y los logs no se tocan.
paso(`Copiar el código a ${corto(DEST)} e instalar dependencias (yaml)`);
hacer(() => {
  const nuevo = path.join(DEST, '.instalando');
  const anterior = path.join(DEST, '.anterior');
  fs.rmSync(nuevo, { recursive: true, force: true });
  fs.rmSync(anterior, { recursive: true, force: true });
  fs.mkdirSync(nuevo, { recursive: true });
  const entradas = fs.readdirSync(path.join(ORIGEN, 'orquestador')).filter((n) => !NO_INSTALAR.has(n));
  for (const nombre of entradas) {
    const o = path.join(ORIGEN, 'orquestador', nombre);
    if (fs.statSync(o).isDirectory()) copiarArbol(o, path.join(nuevo, nombre));
    else fs.copyFileSync(o, path.join(nuevo, nombre));
  }
  try {
    execFileSync('npm', ['ci', '--omit=dev', '--prefer-offline', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: nuevo, stdio: 'inherit' });
  } catch {
    fs.rmSync(nuevo, { recursive: true, force: true });
    fallar('Falló npm ci; la instalación anterior quedó intacta. Revisa tu conexión y vuelve a ejecutar el instalador.');
  }
  fs.chmodSync(path.join(nuevo, 'bin', 'orq.mjs'), 0o755);
  const dirShims = path.join(nuevo, 'lib', 'shims-macos');
  if (fs.existsSync(dirShims)) {
    for (const s of fs.readdirSync(dirShims)) fs.chmodSync(path.join(dirShims, s), 0o755);
  }

  fs.mkdirSync(anterior);
  for (const nombre of [...entradas, 'node_modules', ...OBSOLETO]) {
    if (DATOS.has(nombre)) continue;
    const d = path.join(DEST, nombre);
    if (fs.existsSync(d)) fs.renameSync(d, path.join(anterior, nombre));
  }
  for (const nombre of [...entradas, 'node_modules']) fs.renameSync(path.join(nuevo, nombre), path.join(DEST, nombre));
  fs.rmSync(nuevo, { recursive: true, force: true });
  fs.rmSync(anterior, { recursive: true, force: true });
});

// 2. Registro: se actualiza solo si no lo modificaste (coincide con lo que instaló el orquestador)
const registroNuevo = path.join(ORIGEN, 'orquestador', 'models.yaml');
const registroActual = path.join(DEST, 'models.yaml');
// Las huellas ignoran los ajustes del usuario (Fase 0, permitir_cuenta_personal, lectura_denegada, lectura_extra), que se conservan.
const textoNuevo = fs.readFileSync(registroNuevo, 'utf8');
const hashNuevo = hashRegistro(textoNuevo);
const textoActual = fs.existsSync(registroActual) ? fs.readFileSync(registroActual, 'utf8') : null;
const hashActual = textoActual === null ? null : hashRegistro(textoActual);
if (textoActual === null) {
  paso('Crear el registro global models.yaml');
  hacer(() => fs.copyFileSync(registroNuevo, registroActual));
  manifiesto.registro = hashNuevo;
} else if (hashActual === hashNuevo) {
  paso('Registro sin cambios');
  hacer(() => fs.rmSync(`${registroActual}.nuevo`, { force: true }));
  manifiesto.registro = hashNuevo;
} else if (hashActual === anterior?.registro || REGISTROS_PUBLICADOS.includes(hashActual)) {
  paso('Actualizar el registro models.yaml (no lo habías modificado; se conservan tus ajustes y el anterior queda en models.yaml.anterior)');
  hacer(() => {
    fs.copyFileSync(registroActual, `${registroActual}.anterior`);
    fs.writeFileSync(registroActual, conservarAjustes(textoActual, textoNuevo));
    fs.rmSync(`${registroActual}.nuevo`, { force: true });
  });
  manifiesto.registro = hashNuevo;
} else {
  paso('Se conserva tu models.yaml (lo modificaste); la versión del paquete queda en models.yaml.nuevo para comparar');
  hacer(() => fs.copyFileSync(registroNuevo, `${registroActual}.nuevo`));
}

// 3. Skill global (los roles los muestra `orq estado`; la skill no tiene partes generadas)
paso('Instalar la skill orquestar');
hacer(() => copiarArbol(path.join(ORIGEN, 'skill', 'orquestar'), path.join(CONFIG, 'skills', 'orquestar')));

// 4. Subagentes: se actualizan si no los modificaste
for (const a of AGENTES) {
  const o = path.join(ORIGEN, 'agents', `${a}.md`);
  const d = path.join(CONFIG, 'agents', `${a}.md`);
  const hNuevo = hash(o);
  if (!fs.existsSync(d)) {
    paso(`Instalar el subagente ${a}`);
  } else if (hash(d) === hNuevo) {
    manifiesto.agentes[a] = hNuevo;
    continue;
  } else if (anterior?.agentes?.[a] === hash(d) || OPC.forzar) {
    paso(`Actualizar el subagente ${a}`);
  } else {
    nota(`Se conserva tu subagente ${a} (lo modificaste o no es del orquestador). Usa --forzar para reemplazarlo.`);
    delete manifiesto.agentes[a];
    continue;
  }
  hacer(() => {
    fs.mkdirSync(path.dirname(d), { recursive: true });
    fs.copyFileSync(o, d);
  });
  manifiesto.agentes[a] = hNuevo;
}

// 5. Permisos de Claude Code a nivel de usuario
const rutaSettings = RUTA_SETTINGS;
const plantilla = leerPlantillaPermisos();
const settings = SETTINGS;
settings.permissions ??= {};
const agregadas = { allow: [], deny: [] };
for (const clave of ['allow', 'deny']) {
  const actuales = settings.permissions[clave] ?? [];
  // Si una actualización cambió una regla del orquestador, se quita la antigua.
  const obsoletas = (anterior?.reglas?.[clave] ?? []).filter((r) => !plantilla[clave].includes(r));
  const limpias = actuales.filter((r) => !obsoletas.includes(r));
  for (const r of plantilla[clave]) if (!limpias.includes(r)) agregadas[clave].push(r);
  settings.permissions[clave] = [...limpias, ...agregadas[clave]];
  manifiesto.reglas[clave] = [...new Set([...manifiesto.reglas[clave].filter((r) => !obsoletas.includes(r)), ...agregadas[clave]])];
}
const nAgregadas = agregadas.allow.length + agregadas.deny.length;
paso(nAgregadas ? `Agregar ${nAgregadas} regla(s) de permisos a ${corto(rutaSettings)}` : 'Permisos de Claude Code ya configurados');
hacer(() => {
  fs.mkdirSync(CONFIG, { recursive: true });
  if (fs.existsSync(rutaSettings) && !fs.existsSync(`${rutaSettings}.bak-orquestador`)) {
    fs.copyFileSync(rutaSettings, `${rutaSettings}.bak-orquestador`);
  }
  escribirJson(rutaSettings, settings);
});

// 6. Comando orq
paso(`Crear el comando ${corto(SHIM)}`);
hacer(() => {
  fs.mkdirSync(BIN_DIR, { recursive: true });
  const shim = [
    '#!/bin/sh',
    MARCA_SHIM,
    "NODE_BIN=''",
    'if command -v node >/dev/null 2>&1; then',
    '  VER="$(node -v 2>/dev/null || true)"',
    '  VER="${VER#v}"',
    '  VER="${VER%%.*}"',
    '  case "$VER" in',
    "    ''|*[!0-9]*) ;;",
    '    *) if [ "$VER" -ge 20 ]; then NODE_BIN=node; fi ;;',
    '  esac',
    'fi',
    `if [ -z "$NODE_BIN" ]; then NODE_BIN=${shQuote(process.execPath)}; fi`,
    `exec "$NODE_BIN" ${shQuote(path.join(DEST, 'bin', 'orq.mjs'))} "$@"`,
    '',
  ].join('\n');
  fs.writeFileSync(SHIM, shim);
  fs.chmodSync(SHIM, 0o755);
});

// 7. PATH
const enPath = (process.env.PATH ?? '').split(path.delimiter).map((d) => path.resolve(d)).includes(BIN_DIR);
if (enPath) {
  paso(`${corto(BIN_DIR)} ya está en el PATH`);
} else if (OPC.sinPath) {
  nota(`Agrega ${corto(BIN_DIR)} a tu PATH para usar orq.`);
} else {
  const shell = archivoShell();
  if (!shell) {
    nota(`No reconocí tu shell (${process.env.SHELL ?? 'desconocido'}). Agrega ${corto(BIN_DIR)} a tu PATH.`);
  } else {
    const dirShell = BIN_DIR === HOME || BIN_DIR.startsWith(`${HOME}/`) ? `$HOME${BIN_DIR.slice(HOME.length)}` : BIN_DIR;
    const linea = shell.tipo === 'fish' ? `fish_add_path "${dirShell}"` : `export PATH="${dirShell}:$PATH"`;
    const actual = fs.existsSync(shell.ruta) ? fs.readFileSync(shell.ruta, 'utf8') : '';
    if (actual.includes(BLOQUE_INI) && actual.includes(linea)) {
      paso(`El PATH ya está configurado en ${corto(shell.ruta)}`);
    } else {
      const reemplaza = actual.includes(BLOQUE_INI);
      paso(`${reemplaza ? 'Actualizar' : 'Agregar'} ${corto(BIN_DIR)} al PATH en ${corto(shell.ruta)}`);
      hacer(() => {
        fs.mkdirSync(path.dirname(shell.ruta), { recursive: true });
        if (reemplaza) {
          const limpio = quitarBloque(actual).replace(/\n{2,}$/, '\n');
          const base = limpio === '\n' ? '' : limpio;
          const sep = base && !base.endsWith('\n') ? '\n' : '';
          fs.writeFileSync(shell.ruta, `${base}${sep}\n${BLOQUE_INI}\n${linea}\n${BLOQUE_FIN}\n`);
        } else {
          const sep = actual && !actual.endsWith('\n') ? '\n' : '';
          fs.appendFileSync(shell.ruta, `${sep}\n${BLOQUE_INI}\n${linea}\n${BLOQUE_FIN}\n`);
        }
      });
    }
    manifiesto.shell = shell;
  }
}

// 8. Manifiesto: qué instaló esta versión (para actualizar y desinstalar sin pisar lo tuyo)
hacer(() => escribirJson(MANIFIESTO, manifiesto));

if (OPC.simular) {
  process.stdout.write('\nSimulación terminada: no se modificó nada.\n');
  process.exit(0);
}

process.stdout.write('\nDiagnóstico:\n');
spawnSync(process.execPath, [path.join(DEST, 'bin', 'orq.mjs'), 'doctor'], {
  stdio: 'inherit',
  env: { ...process.env, PATH: `${BIN_DIR}${path.delimiter}${process.env.PATH ?? ''}` },
});

process.stdout.write(
  [
    '',
    `Orquestador ${version} instalado para todos tus repos.`,
    enPath ? '' : 'Abre una terminal nueva (o recarga tu shell) para usar orq.',
    'Siguientes pasos:',
    '  orq verificar --sin-llamadas     # Fase 0 sin gastar créditos (incluye el sandbox)',
    '  orq verificar --guardar          # Fase 0 completa: skills, salida JSON y Command Code en el sandbox',
    '  orq init --sensible              # dentro de un repo con datos sensibles',
    '  Edita repos_sensibles en ~/.claude/orquestador/models.yaml para detectarlos solos.',
    '',
  ].filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n'),
);
