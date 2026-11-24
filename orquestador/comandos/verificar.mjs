// orq verificar [--sin-llamadas] [--guardar] [--modelo ID]
//
// Fase 0: comprueba que los ejecutores (Command Code, Antigravity) y el sandbox cumplen lo que el registro supone.
//   --sin-llamadas  Solo revisa versiones, catálogos, autenticación y el sandbox local (no consume créditos).
//   --guardar       Guarda en el registro command_code.skills_compatibles y command_code.salida_json.
//   --modelo ID     Prueba solo ese modelo (cada llamada a agy tarda unos 40 s).
//
// Con llamadas, por cada modelo activo o en prueba hace prompts mínimos para comprobar:
//   1. que un rol de solo lectura puede leer el repo y no escribe,
//   2. que acepta cada nivel de effort del registro (en Antigravity, cada slug),
//   3. Command Code: si --skill carga una skill con el formato SKILL.md de Claude Code,
//   4. Command Code: si --output-format json entrega la línea final con los tokens (Antigravity siempre la entrega),
//   5. que funciona dentro del sandbox y que el sandbox bloquea escrituras fuera de su worktree.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fijarClave } from '../lib/registro-texto.mjs';
import { cargarRegistro, effortsDe, ErrorOrquestador, SALIDA } from '../lib/registro.mjs';
import { RUTA_REGISTRO, DIR_DATOS } from '../lib/config.mjs';
import { configSandbox, envolverEnSandbox, sandboxDisponible, politicaSandbox, entornoSandbox, rutaReal } from '../lib/sandbox.mjs';
import { ejecutoresEnUso, ejecutorDeModelo, modelosDe, versionEjecutor } from '../lib/ejecutores/index.mjs';

const TIMEOUT_MS = 3 * 60 * 1000;

/**
 * Carpetas para probar el sandbox. La de afuera tiene que estar fuera de todo lo escribible (temporales,
 * cachés): se usa la carpeta de datos de orq y, si no sirve (p. ej. ORQ_HOME en /tmp), el HOME.
 */
function carpetasSandbox(registro) {
  const escribibles = politicaSandbox(registro).escritura;
  const escribible = (p) => escribibles.some((e) => p === e || p.startsWith(`${e}${path.sep}`));
  const candidatas = [path.join(DIR_DATOS, 'logs'), os.homedir()].map(rutaReal);
  const base = candidatas.find((c) => !escribible(c)) ?? candidatas[0];
  const dir = path.join(base, `.orq-verificar-${crypto.randomBytes(3).toString('hex')}`);
  const dentro = path.join(dir, 'dentro');
  const fuera = path.join(dir, 'fuera');
  fs.mkdirSync(dentro, { recursive: true });
  fs.mkdirSync(fuera, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: dentro });
  return { dir, dentro, fuera };
}

export async function ejecutar(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      'sin-llamadas': { type: 'boolean', default: false },
      guardar: { type: 'boolean', default: false },
      modelo: { type: 'string' },
    },
  });
  const registro = cargarRegistro(RUTA_REGISTRO);
  if (values.modelo && !registro.models[values.modelo]) throw new ErrorOrquestador(`El modelo "${values.modelo}" no está en el registro.`);
  const resultados = [];
  const anotar = (ok, prueba, detalle = '') => {
    resultados.push({ ok, prueba });
    process.stdout.write(`${ok ? '✔' : '✘'} ${prueba}${detalle ? ` — ${detalle}` : ''}\n`);
  };
  const avisar = (prueba, detalle = '') => process.stdout.write(`! ${prueba}${detalle ? ` — ${detalle}` : ''}\n`);
  const recorte = (t) => t.trim().replace(/\s+/g, ' ').slice(0, 160);

  // Sandbox local: sin ejecutores, solo comprueba que el perfil bloquea lo que debe.
  const { modo } = configSandbox(registro);
  const disponible = sandboxDisponible();
  let sandboxActivo = false;
  if (modo === 'desactivado') {
    avisar('Sandbox desactivado (sandbox.modo)', 'los modelos delegados corren con todos tus permisos');
  } else if (!disponible.tipo) {
    if (modo === 'obligatorio') anotar(false, 'Sandbox disponible', disponible.motivo);
    else avisar('Sandbox no disponible', `${disponible.motivo}; los modelos delegados correrán sin sandbox`);
  } else {
    sandboxActivo = true;
    const c = carpetasSandbox(registro);
    const env = envolverEnSandbox(registro, {
      bin: '/bin/sh', args: ['-c', `echo hola > dentro.txt; echo hola > "${c.fuera}/fuera.txt"; true`], cwd: c.dentro, escribibles: [c.dentro],
    });
    spawnSync(env.bin, env.args, { cwd: c.dentro, env: entornoSandbox(process.env, env.sandbox), stdio: 'ignore', timeout: 20000 });
    anotar(fs.existsSync(path.join(c.dentro, 'dentro.txt')), `Sandbox ${disponible.tipo}: permite escribir en el worktree`);
    anotar(!fs.existsSync(path.join(c.fuera, 'fuera.txt')), `Sandbox ${disponible.tipo}: bloquea escrituras fuera del worktree`);
    fs.rmSync(c.dir, { recursive: true, force: true });
  }

  const ejecutores = values.modelo ? [ejecutorDeModelo(registro, values.modelo)] : ejecutoresEnUso(registro);
  let skillsCompatibles = null;
  let salidaJson = null;

  for (const ej of ejecutores) {
    process.stdout.write(`\n${ej.etiqueta}\n`);
    const bin = ej.bin(registro);
    const modelos = modelosDe(registro, ej).filter(([id]) => !values.modelo || id === values.modelo);

    const v = versionEjecutor(ej, bin);
    if (!v.instalado) {
      anotar(false, `${ej.etiqueta} instalado (${bin})`, v.error.code === 'ENOENT' ? `no se encontró el binario; ${ej.instalar}` : v.error.message);
      continue;
    }
    anotar(v.suficiente, `Versión de ${ej.etiqueta} >= ${ej.versionMinima}`, v.version ?? 'versión no reconocida');

    const acceso = ej.acceso(registro);
    if (acceso.bloqueo) {
      anotar(false, `${ej.etiqueta}: autenticación con ${acceso.etiquetaModo}`, 'el registro no lo permite; orq bloqueará estos modelos');
      continue;
    }
    if (ej.nombre !== 'command_code') anotar(true, `${ej.etiqueta}: autenticación con ${acceso.etiquetaModo}`);

    const catalogo = ej.catalogo(bin);
    for (const [id, ficha] of modelos) {
      for (const clave of ej.idsCatalogo(id, ficha)) {
        anotar(catalogo !== null && catalogo.includes(clave), `"${clave}" aparece en el catálogo de ${ej.etiqueta}`);
      }
    }
    if (values['sin-llamadas']) continue;

    for (const [id, ficha] of modelos) {
      const efforts = effortsDe(ficha);
      const effortPrueba = efforts.includes('low') ? 'low' : efforts[0];
      const res = (extra = {}) => {
        const effort = extra.effort ?? effortPrueba;
        return {
          modelo: id, ejecutor: ej.nombre, effort, yolo: false, salida_json: false,
          slug: ficha.efforts?.[effort] ?? null, ...extra,
        };
      };
      /**
       * Corre el modelo como en una delegación: dentro del sandbox si está activo, con el cwd escribible solo
       * si `escribible` (rol de escritura). Devuelve el texto de su respuesta.
       */
      // Las pruebas sin repo (efforts, skills, JSON) corren en una carpeta vacía, no en el repo desde donde llamas.
      const vacio = fs.mkdtempSync(path.join(os.tmpdir(), 'orq-verificar-vacio-'));
      const correr = (r, { cwd = vacio, prompt, skills = [], escribible = false }) => {
        let ejecutable = bin;
        let args = ej.args(r, skills, { sandbox: sandboxActivo });
        let sandbox = null;
        if (sandboxActivo) {
          const est = ej.estado();
          const env = envolverEnSandbox(registro, {
            bin, args, cwd, escribibles: [...(escribible ? [cwd] : []), ...est.escritura], protegidas: est.protegidas, legibles: [cwd],
          });
          ejecutable = env.bin;
          args = env.args;
          sandbox = env.sandbox;
        }
        const p = spawnSync(ejecutable, args, {
          cwd, env: entornoSandbox(process.env, sandbox), input: ej.entrada(prompt), encoding: 'utf8', timeout: TIMEOUT_MS,
        });
        const lector = ej.lector(r);
        let json = null;
        if (lector) {
          lector.agregar(p.stdout ?? '');
          json = lector.terminar();
        }
        const ok = p.status === 0 && !json?.error;
        return { ok, codigo: p.status, texto: json ? json.texto : (p.stdout ?? ''), salida: `${p.stdout ?? ''}${p.stderr ?? ''}`, json };
      };

      // Fuera de temporales y cachés, como un repo real: con sandbox, el sistema operativo impide escribir ahí.
      const cl = carpetasSandbox(registro);
      const dir = cl.dentro;
      const palabra = `PALABRA-${crypto.randomBytes(3).toString('hex')}`;
      fs.writeFileSync(path.join(dir, 'secreto.txt'), `${palabra}\n`);
      const lectura = correr(res(), {
        cwd: dir,
        prompt: 'Lee el archivo secreto.txt y responde con su contenido exacto. Después crea un archivo nuevo.txt con el texto hola.',
      });
      anotar(lectura.texto.includes(palabra), `${id}: como rol de solo lectura puede leer el repo`, lectura.ok ? '' : recorte(lectura.salida));
      anotar(!fs.existsSync(path.join(dir, 'nuevo.txt')), `${id}: como rol de solo lectura no escribe archivos`);
      fs.rmSync(cl.dir, { recursive: true, force: true });

      // En Antigravity, varios niveles pueden apuntar al mismo slug: se prueba cada slug una vez.
      const probados = new Set();
      for (const effort of efforts) {
        const r = res({ effort });
        const clave = r.slug ?? effort;
        if (probados.has(clave)) continue;
        probados.add(clave);
        const p = correr(r, { prompt: 'Responde únicamente con la palabra OK.' });
        anotar(p.ok, `${id}: ${r.slug ? `slug ${r.slug}` : `--effort ${effort}`}`, p.ok ? '' : recorte(p.salida));
      }

      if (ej.nombre === 'command_code') {
        const dirSkill = fs.mkdtempSync(path.join(os.tmpdir(), 'orq-skill-'));
        const rutaSkill = path.join(dirSkill, 'skill-prueba');
        const clave = `CLAVE-${crypto.randomBytes(3).toString('hex')}`;
        fs.mkdirSync(rutaSkill);
        fs.writeFileSync(
          path.join(rutaSkill, 'SKILL.md'),
          `---\nname: skill-prueba\ndescription: Skill de verificación del orquestador. Úsala siempre que te pregunten por la palabra clave de la skill de prueba.\n---\n\nLa palabra clave de esta skill es ${clave}. Si te preguntan por ella, responde exactamente ${clave}.\n`,
        );
        const conSkill = correr(res(), { prompt: '¿Cuál es la palabra clave de la skill skill-prueba? Responde solo con la palabra.', skills: [rutaSkill] });
        const compatible = conSkill.salida.includes(clave);
        anotar(compatible, `${id}: --skill carga una skill de Claude Code sin modificarla`, compatible ? '' : recorte(conSkill.salida));
        skillsCompatibles = skillsCompatibles === null ? compatible : skillsCompatibles && compatible;
        fs.rmSync(dirSkill, { recursive: true, force: true });

        const rj = correr(res({ salida_json: true }), { prompt: 'Responde únicamente con la palabra OK.' });
        const okJson = rj.codigo === 0 && rj.json?.estado === 'success';
        anotar(okJson, `${id}: --output-format json entrega la línea final`, okJson ? '' : recorte(rj.salida));
        if (okJson && !rj.json.uso) avisar(`${id}: no reconocí los tokens en usage`, `claves: ${Object.keys(rj.json.usoBruto ?? {}).join(', ') || 'ninguna'}`);
        salidaJson = salidaJson === null ? okJson : salidaJson && okJson;
      }

      if (sandboxActivo) {
        const c = carpetasSandbox(registro);
        const r = correr(res({ yolo: true }), {
          cwd: c.dentro,
          escribible: true,
          prompt: `Crea el archivo dentro.txt con el texto hola en el directorio actual. Después crea el archivo ${c.fuera}/fuera.txt con el texto hola. Si algo falla, sigue y responde OK.`,
        });
        const escribio = fs.existsSync(path.join(c.dentro, 'dentro.txt'));
        anotar(escribio, `${id}: funciona dentro del sandbox y escribe en su worktree`, escribio ? '' :
          `${recorte(r.salida)} · si necesita escribir en otra carpeta, agrégala a sandbox.escritura_extra`);
        anotar(!fs.existsSync(path.join(c.fuera, 'fuera.txt')), `${id}: el sandbox bloquea sus escrituras fuera del worktree`);
        fs.rmSync(c.dir, { recursive: true, force: true });
      }
      fs.rmSync(vacio, { recursive: true, force: true });
    }
  }

  const fallas = resultados.filter((r) => !r.ok).length;
  process.stdout.write(`\n${resultados.length - fallas}/${resultados.length} pruebas OK.\n`);

  if (values.guardar) {
    if (skillsCompatibles === null) {
      process.stdout.write('No se guardó nada: no corrieron las pruebas con llamadas de Command Code.\n');
    } else {
      // Solo cambian esas dos líneas: reescribir con la librería YAML reformatearía todo el archivo y el
      // instalador lo daría por modificado (dejaría de actualizarlo).
      const original = fs.readFileSync(RUTA_REGISTRO, 'utf8');
      let texto = fijarClave(original, 'command_code', 'skills_compatibles', String(skillsCompatibles));
      texto = fijarClave(texto, 'command_code', 'salida_json', String(salidaJson));
      fs.writeFileSync(RUTA_REGISTRO, texto);
      try {
        const cc = cargarRegistro(RUTA_REGISTRO).command_code;
        if (cc.skills_compatibles !== skillsCompatibles || cc.salida_json !== salidaJson) throw new Error('los valores no quedaron como se esperaba');
      } catch (e) {
        fs.writeFileSync(RUTA_REGISTRO, original);
        throw new ErrorOrquestador(`No pude guardar el resultado en ${RUTA_REGISTRO} (${e.message}); quedó como estaba.`);
      }
      process.stdout.write(
        `Guardado en ${RUTA_REGISTRO}: command_code.skills_compatibles = ${skillsCompatibles}, command_code.salida_json = ${salidaJson}.\n`,
      );
    }
  }
  return fallas ? 1 : SALIDA.OK;
}
