/**
 * La búsqueda de una unidad por texto libre: **una sola**, para todas las grillas que la ofrecen.
 *
 * Nació en el padrón editable (`listarPadronEditable`, maqueta `alta-barrio-padron.html`) y se movió
 * acá cuando Cobros pidió la misma búsqueda (encargo 8, T1). Dos copias del mismo `where` divergen en
 * silencio: el día que el padrón aprenda a buscar por otra cosa, Cobros tiene que aprenderlo igual.
 *
 * Coincide por:
 * - **manzana, exacta**, cuando el texto la nombra: «Mza 1», «mza 1», «Manzana A» o «1-» traen la
 *   manzana 1 (o la A) y **solo esa** — no la 10 ni la 11 (encargo 10, BL-030 c);
 * - **manzana y lote, exactos**: «Mza 1 Lote 2», «1-2», «mza 1 lt 2»;
 * - **código de pago**, con o sin ceros y con o sin verificador: «19», «000019» y «000019-7» traen la
 *   unidad 19 (BL-030 c). Antes el último dígito se tomaba siempre como verificador, y «19» buscaba la 1;
 * - **un número solo** es un código de pago o un CUIT/CUIL/DNI, no un pedazo de manzana o de lote;
 * - y, si el texto no es nada de lo anterior, lo de siempre: **manzana y lote** por parecido («12 3»),
 *   y **titular vigente**, por nombre (parcial) o por CUIT/CUIL/DNI (6 dígitos o más).
 *
 * Los titulares los sigue filtrando la RLS de `obligado`: un rol que no los ve no encuentra por nombre.
 *
 * Interno al paquete: no está en el mapa de `exports`. Devuelve un fragmento ` and (…)` para pegar
 * detrás de un `where` sobre `unidad_funcional u` (con `u.barrio_id`), o un fragmento vacío si no hay
 * nada que buscar.
 */

import { sql, type SQL } from "drizzle-orm";
import { verificadorValido } from "@admin-barrios/shared/codigo-pago";

/** El techo del texto que se busca: lo mismo que acepta el `?q=` de la pantalla. */
export const LARGO_MAXIMO_BUSQUEDA = 80;

/** Más dígitos que esto no es un código de pago (número + verificador; security-engineer, B1). */
const MAXIMO_DIGITOS_DE_CODIGO = 15;

/** Lo que se entendió del texto. Todo como texto: ningún número pasa por `Number`. */
export type BusquedaInterpretada = {
  /** El texto tal cual (recortado), para las coincidencias por parecido. */
  readonly texto: string;
  /** Manzana nombrada («Mza 1», «1-»): si está, la manzana se compara exacta y no por parecido. */
  readonly manzana: string | null;
  /** Lote nombrado junto con la manzana («Mza 1 Lote 2»). */
  readonly lote: string | null;
  /** Números de código de pago candidatos (sin ceros a la izquierda): coinciden con `codigo_pago_numero`. */
  readonly numerosDeCodigo: readonly string[];
  /**
   * El código impreso sin el verificador (prefijo + número con ceros), cuando el texto era el código
   * completo pegado sin separador y el verificador da: «0000197» → «000019».
   */
  readonly codigoImpreso: string | null;
};

const sinCeros = (digitos: string): string => digitos.replace(/^0+(?=\d)/, "");
const esNumeroDeCodigo = (digitos: string): boolean =>
  /^\d+$/.test(digitos) && digitos.length <= MAXIMO_DIGITOS_DE_CODIGO && sinCeros(digitos) !== "0";

/** Una manzana o un lote: letras y números, sin espacios («1», «A», «12B»). */
const PIEZA = "([0-9a-zñ]{1,20})";
// Con límite de palabra: sin él, «mza 1» se leía como «mz» + manzana «a» + lote «1».
const MZA = "(?:manzana|mza\\.?|mz\\.?)(?![a-zñ])";
const LOTE = "(?:lote|lt\\.?|l\\.?)(?![a-zñ])";

/**
 * Qué quiso buscar la persona. Pura: se prueba sin base (`busqueda-de-unidad.test.ts`).
 *
 * - «Mza 1», «mza1», «Manzana A» → manzana exacta.
 * - «1-» (el número de manzana con el guion de «Mza-Lote») → manzana exacta.
 * - «Mza 1 Lote 2», «mza 1 lt 2», «1-2» → manzana y lote exactos. «1-2» además puede ser el código 1
 *   con su verificador: se buscan las dos cosas.
 * - «19», «000019» → el código 19 (y, si «000019» fuera un código impreso completo con verificador
 *   válido, también ese).
 * - «000019-7» → el código 19: lo de antes del guion es el número.
 */
export function interpretarBusquedaDeUnidad(entrada: string): BusquedaInterpretada {
  const texto = entrada.trim().slice(0, LARGO_MAXIMO_BUSQUEDA);
  const compacto = texto.toLowerCase().replace(/\s+/g, " ");
  let manzana: string | null = null;
  let lote: string | null = null;
  const numeros = new Set<string>();
  let codigoImpreso: string | null = null;

  // Sin la palabra «Mza», el guion solo dice manzana si lo de adelante parece una manzana: «000019-7»
  // es un código de pago (ceros adelante, o cuatro dígitos o más), no la manzana 19 lote 7.
  const pareceManzana = (m: RegExpExecArray | null): RegExpExecArray | null =>
    m && !/^(0\d*|\d{4,})$/.test(m[1]!) ? m : null;
  const conLote =
    new RegExp(`^${MZA}\\s*${PIEZA}\\s*(?:-|\\s)\\s*(?:${LOTE}\\s*)?${PIEZA}$`).exec(compacto) ??
    pareceManzana(new RegExp(`^${PIEZA}\\s*-\\s*${PIEZA}$`).exec(compacto)) ??
    new RegExp(`^${PIEZA}\\s+${LOTE}\\s*${PIEZA}$`).exec(compacto);
  const soloManzana =
    new RegExp(`^${MZA}\\s*${PIEZA}\\s*-?$`).exec(compacto) ?? pareceManzana(new RegExp(`^${PIEZA}\\s*-$`).exec(compacto));

  if (conLote) {
    manzana = conLote[1]!;
    lote = conLote[2]!;
  } else if (soloManzana) {
    manzana = soloManzana[1]!;
  }

  // El código de pago: lo de antes del guion es el número; sin guion, el número entero y, si el
  // verificador da, también el código impreso sin su último dígito.
  // Los espacios solo se toleran alrededor del guion: «1 1» es manzana y lote, no el código 11.
  const sinEspacios = texto.replace(/\s*-\s*/g, "-");
  const conGuion = /^(\d+)-([0-9a-z]?)$/i.exec(sinEspacios);
  if (conGuion && conGuion[2] !== "") {
    // «000019-7»: con verificador. «1-» (sin nada después del guion) es una manzana, no un código.
    if (esNumeroDeCodigo(conGuion[1]!)) numeros.add(sinCeros(conGuion[1]!));
  } else if (/^\d+$/.test(sinEspacios) && sinEspacios.length <= MAXIMO_DIGITOS_DE_CODIGO) {
    if (esNumeroDeCodigo(sinEspacios)) numeros.add(sinCeros(sinEspacios));
    if (sinEspacios.length > 1 && verificadorValido(sinEspacios)) codigoImpreso = sinEspacios.slice(0, -1);
  }

  return { texto, manzana, lote, numerosDeCodigo: [...numeros], codigoImpreso };
}

/** Manzana o lote, exacto: sin distinguir mayúsculas ni ceros a la izquierda («01» es «1»). */
const igual = (columna: SQL, valor: string): SQL =>
  sql`ltrim(lower(${columna}), '0') = ltrim(lower(${valor}), '0')`;

export function condicionDeBusquedaDeUnidad(entrada: string): SQL {
  const b = interpretarBusquedaDeUnidad(entrada);
  if (b.texto === "") return sql``;

  const porCodigo: SQL[] = [];
  if (b.numerosDeCodigo.length > 0) {
    porCodigo.push(sql`u.codigo_pago_numero::text = any(${`{${b.numerosDeCodigo.join(",")}}`}::text[])`);
  }
  if (b.codigoImpreso !== null) {
    porCodigo.push(sql`exists (select 1 from barrio bc where bc.barrio_id = u.barrio_id
                         and bc.codigo_pago_prefijo || lpad(u.codigo_pago_numero::text, bc.codigo_pago_largo, '0') = ${b.codigoImpreso})`);
  }

  const masCodigo = porCodigo.length === 0 ? sql`` : sql` or ${sql.join(porCodigo, sql` or `)}`;

  // El texto nombra una manzana: exacta, y nada por parecido (si no, «Mza 1» trae la 10 y la 11).
  if (b.manzana !== null) {
    const ubicacion =
      b.lote === null
        ? igual(sql`u.manzana`, b.manzana)
        : sql`${igual(sql`u.manzana`, b.manzana)} and ${igual(sql`u.lote`, b.lote)}`;
    return sql` and ((${ubicacion})${masCodigo})`;
  }

  const soloDigitos = b.texto.replace(/\D/g, "");
  const porDocumento = sql`exists (select 1 from unidad_obligado uo join obligado o on o.id = uo.obligado_id
                      where uo.unidad_funcional_id = u.id and uo.hasta is null
                        and (o.nombre ilike ${`%${b.texto}%`}
                             or (${soloDigitos} <> '' and length(${soloDigitos}) >= 6
                                 and (o.cuit_cuil like ${`%${soloDigitos}%`} or o.numero_documento like ${`%${soloDigitos}%`}))))`;

  // Un número solo («19», «000019», «000019-7») es un código de pago o un documento, no un pedazo de
  // manzana o de lote: por parecido, «19» traía todos los lotes 19 y la manzana 19 junto con la unidad
  // del código. La manzana se pide con «Mza 19» o «19-».
  if (b.numerosDeCodigo.length > 0 || b.codigoImpreso !== null) {
    return sql` and (${sql.join(porCodigo, sql` or `)} or ${porDocumento})`;
  }

  return sql` and (
          (u.manzana || ' ' || u.lote) ilike ${`%${b.texto}%`}
          or ('mza ' || u.manzana || ' lote ' || u.lote) ilike ${`%${b.texto}%`}
          or ${porDocumento}
        )`;
}
