// Edición del registro como texto, sin dependencias (lo usa también instalar.mjs antes de instalar `yaml`).
//
// `orq verificar --guardar` solo cambia command_code.skills_compatibles y command_code.salida_json.
// Reescribirlo con la librería YAML reformatea todo el archivo (pliega textos largos, despliega listas,
// mueve comentarios); aquí se cambia solo la línea de cada clave y el resto queda byte a byte igual.
// Así el instalador puede reconocer un registro "sin modificar" ignorando los ajustes del usuario.

import crypto from 'node:crypto';

/** Claves que escribe la Fase 0. */
export const CLAVES_FASE0 = ['skills_compatibles', 'salida_json'];

/**
 * Ajustes del usuario: no cuentan como modificación del registro (el instalador lo sigue actualizando)
 * y su valor se conserva al actualizar. Solo si están en una línea (`clave: valor`); una lista en varias
 * líneas sí cuenta como modificación.
 */
export const AJUSTES_USUARIO = [
  ...CLAVES_FASE0.map((c) => ['command_code', c]),
  ['antigravity', 'permitir_cuenta_personal'],
  ['sandbox', 'escritura_extra'],
  ['sandbox', 'lectura_denegada'],
  ['sandbox', 'lectura_extra'],
  ['sandbox', 'preparar_con_credenciales'],
];

const CLAVES_LISTA = new Set(['lectura_denegada', 'lectura_extra', 'escritura_extra']);
const escaparRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Rango de líneas [inicio, fin) del bloque de una sección de primer nivel, o null si no existe. */
function bloque(lineas, seccion) {
  const esc = escaparRegex(seccion);
  const reInicio = new RegExp(`^${esc}:\\s*(?:\\{\\})?(?:\\s+#.*)?\\s*$`);
  const inicio = lineas.findIndex((l) => reInicio.test(l));
  if (inicio === -1) return null;
  let fin = inicio + 1;
  while (fin < lineas.length && (lineas[fin].trim() === '' || /^\s/.test(lineas[fin]) || lineas[fin].startsWith('#'))) fin++;
  // las líneas en blanco y comentarios sueltos al final pertenecen a lo que sigue
  while (fin > inicio + 1 && (lineas[fin - 1].trim() === '' || lineas[fin - 1].startsWith('#'))) fin--;
  return { inicio, fin };
}

/**
 * Divide una línea `  clave: valor # comentario` respetando `#` dentro de comillas simples o dobles.
 * Devuelve { cabecera, valor, comentario } o null si la línea no declara esa clave.
 */
function parsearClave(linea, clave) {
  const esc = escaparRegex(clave);
  const pref = linea.match(new RegExp(`^(\\s+${esc}:)([^\\n]*)$`));
  if (!pref) return null;
  const [, cabecera, resto] = pref;
  let comilla = null;
  let posComentario = -1;
  for (let i = 0; i < resto.length; i++) {
    const ch = resto[i];
    if (comilla === "'") {
      if (ch === "'") {
        if (resto[i + 1] === "'") i++;
        else comilla = null;
      }
    } else if (comilla === '"') {
      if (ch === '\\') i++;
      else if (ch === '"') comilla = null;
    } else if (ch === "'" || ch === '"') {
      comilla = ch;
    } else if (ch === '#' && i > 0 && /\s/.test(resto[i - 1])) {
      posComentario = i;
      break;
    }
  }
  if (posComentario === -1) return { cabecera, valor: resto.trim(), comentario: '' };
  let inicioEspacios = posComentario;
  while (inicioEspacios > 0 && /\s/.test(resto[inicioEspacios - 1])) inicioEspacios--;
  return {
    cabecera,
    valor: resto.slice(0, inicioEspacios).trim(),
    comentario: resto.slice(inicioEspacios),
  };
}

/** Valor (texto de una línea) de `seccion.clave`, o undefined si no está. */
export function leerClave(texto, seccion, clave) {
  const lineas = texto.split('\n');
  const b = bloque(lineas, seccion);
  if (!b) return undefined;
  for (let i = b.inicio + 1; i < b.fin; i++) {
    const p = parsearClave(lineas[i], clave);
    if (p) return p.valor;
  }
  return undefined;
}

/**
 * Fija `seccion.clave: valor` cambiando solo esa línea (conserva su comentario). Si la clave no existe,
 * la agrega al final del bloque con la sangría de sus hermanas (expandiendo `{}` si la sección estaba vacía).
 * Lanza si la sección no existe.
 */
export function fijarClave(texto, seccion, clave, valor) {
  const lineas = texto.split('\n');
  const b = bloque(lineas, seccion);
  if (!b) throw new Error(`No encontré la sección "${seccion}:" en el registro.`);
  for (let i = b.inicio + 1; i < b.fin; i++) {
    const p = parsearClave(lineas[i], clave);
    if (p) {
      lineas[i] = `${p.cabecera} ${valor}${p.comentario}`;
      return lineas.join('\n');
    }
  }
  const esc = escaparRegex(seccion);
  lineas[b.inicio] = lineas[b.inicio].replace(new RegExp(`^(${esc}:)\\s*\\{\\}(?:(\\s+#.*)|\\s*$)`), '$1$2');
  const hermana = lineas.slice(b.inicio + 1, b.fin).find((l) => /^\s+\S/.test(l) && !l.trim().startsWith('#'));
  const sangria = hermana ? hermana.match(/^\s+/)[0] : '  ';
  lineas.splice(b.fin, 0, `${sangria}${clave}: ${valor}`);
  return lineas.join('\n');
}

/**
 * sha256 del registro sin las líneas de los ajustes del usuario: un registro cuya única diferencia con la
 * plantilla instalada son esos ajustes (o el resultado de `orq verificar --guardar`) cuenta como no modificado.
 */
export function hashRegistro(texto) {
  const lineas = texto.split('\n');
  const fuera = new Set();
  for (const [seccion, clave] of AJUSTES_USUARIO) {
    const b = bloque(lineas, seccion);
    if (!b) continue;
    for (let i = b.inicio + 1; i < b.fin; i++) {
      const p = parsearClave(lineas[i], clave);
      if (p && p.valor) fuera.add(i); // valor en la misma línea; una lista en varias líneas sí cuenta
    }
  }
  return crypto.createHash('sha256').update(lineas.filter((_, i) => !fuera.has(i)).join('\n')).digest('hex');
}

/**
 * Copia a `nuevo` los ajustes que el usuario tenga en `anterior`:
 * - booleanos (Fase 0, permitir_cuenta_personal, preparar_con_credenciales): si son true o false;
 * - listas (lectura_denegada, lectura_extra, escritura_extra): cualquier lista en una línea entre corchetes (incluida []).
 */
export function conservarAjustes(anterior, nuevo) {
  let t = nuevo;
  for (const [seccion, clave] of AJUSTES_USUARIO) {
    const valor = leerClave(anterior, seccion, clave);
    if (valor === undefined) continue;
    const esLista = CLAVES_LISTA.has(clave);
    const conservar = esLista ? /^\[[\s\S]*\]$/.test(valor) : valor === 'true' || valor === 'false';
    if (!conservar) continue;
    try {
      t = fijarClave(t, seccion, clave, valor);
    } catch { /* la plantilla nueva ya no tiene esa sección */ }
  }
  return t;
}

/** Compatibilidad con el nombre anterior. */
export const conservarFase0 = conservarAjustes;
