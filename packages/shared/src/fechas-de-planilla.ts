/**
 * **El único lector de fechas y de meses de una planilla** (encargo 17b). Lo usan la planilla de
 * deuda (el mes y el vencimiento) y la planilla de usos (la fecha). Dominio puro: recibe el texto de
 * la celda, como lo entrega el lector de archivos (`filasDeXlsx` / `textoDeCsv`).
 *
 * Una planilla llega como la deja Excel en castellano, no como la escribiría una persona en un
 * formulario. Lo que se vio en el ensayo, con archivos guardados por Excel:
 *
 *   · una celda de fecha en un `.xlsx` llega como fecha completa (`2026-08-01`), tenga el formato que
 *     tenga en pantalla («ago-26», «10/8/2026»);
 *   · la misma celda guardada como CSV llega **como se ve**: `ago-26`, `sept-26`, `oct-2026`,
 *     `10/8/2026`, `10/10/26`;
 *   · una celda de fecha con formato «General» llega como su **número de serie** (`46296`), en el
 *     `.xlsx` y en el CSV.
 *
 * Nada se adivina: lo que no es una fecha que exista devuelve `null` y la planilla lo marca en su fila.
 */

const sinAcentos = (t: string) =>
  t
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase();

const ANIO_MIN = 2000;
const ANIO_MAX = 2200;

/** `YYYY-MM-DD` si el día existe y el año está en el rango que tiene sentido; si no, `null`. */
function armar(a: number, m: number, d: number): string | null {
  if (!Number.isInteger(a) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  if (a < ANIO_MIN || a > ANIO_MAX) return null;
  // Que exista de verdad: un 31/02 pasa la forma y no es un día.
  const fecha = new Date(Date.UTC(a, m - 1, d));
  if (fecha.getUTCFullYear() !== a || fecha.getUTCMonth() !== m - 1 || fecha.getUTCDate() !== d) return null;
  return `${String(a).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Un año de dos cifras es de este siglo: `26` → `2026`. */
const anio = (texto: string): number => (texto.length === 2 ? 2000 + Number(texto) : Number(texto));

/**
 * El número de serie de una fecha de Excel → `YYYY-MM-DD`. Excel cuenta los días desde el 30/12/1899
 * (con su 29/02/1900 de más, que no afecta a ninguna fecha de este rango). Tiene que ser un entero:
 * con decimales es mucho más probable un importe que una fecha con hora. Solo se acepta el rango 2000–2100 (36526 a 73415): un `7` o un `172000` no son
 * una fecha.
 */
function deNumeroDeSerie(texto: string): string | null {
  const m = /^(\d{5,6})$/.exec(texto);
  if (!m) return null;
  const serie = Number(m[1]);
  if (serie < 36526 || serie > 73415) return null;
  const dia = new Date(Date.UTC(1899, 11, 30) + serie * 86_400_000);
  return armar(dia.getUTCFullYear(), dia.getUTCMonth() + 1, dia.getUTCDate());
}

/**
 * La fecha de una celda → `YYYY-MM-DD`; `null` si no es una fecha que exista.
 *
 * Acepta `dd/mm/aaaa`, `d/m/aa` (también con `-` o `.`), `aaaa-mm-dd`, las dos con una hora detrás
 * (así llega una celda de fecha), y el número de serie de Excel. El orden es **día/mes**: es una
 * planilla en castellano. `08/11/2026` es el 8 de noviembre.
 */
export function leerFechaDePlanilla(texto: string): string | null {
  const t = texto.trim();
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ][\d:.]*Z?)?$/.exec(t);
  if (iso) return armar(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const local = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})(?: +\d{1,2}:\d{2}(?::\d{2})?)?$/.exec(t);
  if (local) return armar(anio(local[3]!), Number(local[2]), Number(local[1]));
  return deNumeroDeSerie(t);
}

/**
 * Los meses como los abrevia Excel en castellano («ago», «sept» —o «sep», según la versión—, «set» en
 * algunas configuraciones) y con el nombre entero. Sin acentos ni mayúsculas, con o sin punto final.
 */
const MESES: Readonly<Record<string, number>> = {
  ene: 1, enero: 1,
  feb: 2, febrero: 2,
  mar: 3, marzo: 3,
  abr: 4, abril: 4,
  may: 5, mayo: 5,
  jun: 6, junio: 6,
  jul: 7, julio: 7,
  ago: 8, agosto: 8,
  sep: 9, sept: 9, set: 9, septiembre: 9, setiembre: 9,
  oct: 10, octubre: 10,
  nov: 11, noviembre: 11,
  dic: 12, diciembre: 12,
};

/**
 * El mes de una celda → `YYYY-MM`; `null` si no es un mes.
 *
 * Acepta `mm/aaaa`, `m/aaaa`, `mm-aaaa`, `aaaa-mm`, el mes abreviado o entero en castellano con el
 * año de 2 o 4 cifras (`ago-26`, `sept-26`, `sep-2026`, `agosto 2026`, `oct/26`) y una celda de fecha
 * (una fecha completa o su número de serie): de esa se toma el mes.
 *
 * `08/26` **no** se acepta: no se sabe si es agosto de 2026 o el 8 del mes 26. Con el mes en letras
 * no hay duda, y por eso ahí sí vale el año de dos cifras.
 */
export function leerMesDePlanilla(texto: string): string | null {
  const t = texto.trim();
  const numerico = /^(\d{1,2})[/-](\d{4})$/.exec(t);
  const iso = /^(\d{4})-(\d{1,2})$/.exec(t);
  const enLetras = /^([a-z]{3,10})\.?(?:[ /-]| de )(\d{2}|\d{4})$/.exec(sinAcentos(t));
  let mes: number | undefined;
  let a: number;
  if (numerico) [mes, a] = [Number(numerico[1]), Number(numerico[2])];
  else if (iso) [mes, a] = [Number(iso[2]), Number(iso[1])];
  else if (enLetras) [mes, a] = [MESES[enLetras[1]!], anio(enLetras[2]!)];
  else {
    // Una celda de fecha (completa o como número de serie): el mes es el de esa fecha.
    const fecha = leerFechaDePlanilla(t);
    return fecha === null ? null : fecha.slice(0, 7);
  }
  if (mes === undefined) return null;
  const dia = armar(a, mes, 1);
  return dia === null ? null : dia.slice(0, 7);
}
