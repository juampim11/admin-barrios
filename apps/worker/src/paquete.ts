/**
 * El trabajo `armar_paquete_periodo`: el ZIP con todas las boletas de un período.
 *
 * **No genera nada.** Las boletas ya están emitidas y guardadas desde que el período se emitió: esto
 * las lee del storage y las empaqueta. Es la diferencia que hace que el reintento sea libre —a
 * diferencia del envío, armar el ZIP de nuevo no le hace nada a nadie.
 *
 * Rigen las mismas tres reglas que `emision.ts`, y no se repiten acá: todo corre bajo
 * `conUsuario(trabajo.solicitadoPor)`, `trabajo.barrioId` es una **aserción** y no un filtro, y la
 * transacción no envuelve el trabajo pesado.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * EL ZIP ES DETERMINÍSTICO, Y SIN ESO EL `sha256` NO SIGNIFICA NADA
 *
 * Un ZIP guarda, por cada entrada, su nombre, su fecha de modificación y el resultado de comprimir.
 * Si cualquiera de esas tres cosas varía entre dos corridas sobre **el mismo contenido**, los bytes
 * salen distintos y el hash también — y entonces el `sha256` que guardamos no acredita el contenido:
 * acredita una corrida.
 *
 * Por eso las tres están fijadas: **orden estable** (por manzana y lote, que es como se recorre el
 * padrón), **`mtime` fijo** y **nivel de compresión fijo**. Con eso, dos empaquetados de las mismas
 * boletas dan el mismo hash, y el hash sirve para lo que tiene que servir: saber si el archivo que
 * alguien tiene en la mano es el que se armó.
 */

import { createHash } from "node:crypto";
import { ZipFile } from "yazl";
import { conUsuario, type DbConIdentidad } from "@admin-barrios/data/client";
import { registrarPaquete } from "@admin-barrios/data/servicios/paquetes";
import { claveDePaquete, nuevoToken, type ObjectStorage } from "@admin-barrios/almacenamiento";
import { sql } from "drizzle-orm";
import type { TrabajoTomado } from "./servidor/cola.ts";

export type ContextoPaquete = {
  readonly db: DbConIdentidad;
  readonly almacenamiento: ObjectStorage;
  readonly alAvanzar: (avance: { hechos?: number; total?: number }) => Promise<void>;
};

/**
 * Misma forma que el resultado de la emisión, para que el bucle del worker no tenga que ramificar
 * por tipo de trabajo al registrar el resultado.
 *
 * `escritos` son las boletas que entraron al paquete; `yaEstaban` es siempre 0 y no es un descuido:
 * **armar el paquete no es incremental**. A diferencia de la emisión —donde "generar los que falten"
 * es cierto y por eso hay algo que ya estaba—, un ZIP se arma entero o no se arma: si el período
 * cambió, lo que corresponde es un paquete nuevo, no completar el anterior.
 */
export type ResultadoPaquete = {
  readonly escritos: number;
  readonly yaEstaban: number;
  readonly bytes: number;
};

/**
 * **La fecha que llevan todas las entradas del ZIP.**
 *
 * Fija y no `new Date()`: si fuera la hora de la corrida, dos empaquetados del mismo período darían
 * archivos distintos y el `sha256` dejaría de acreditar el contenido. El valor concreto no importa
 * mientras sea estable — se elige el epoch de referencia de los formatos ZIP.
 */
const FECHA_ENTRADA_ZIP = new Date(Date.UTC(1980, 0, 1, 0, 0, 0));

type FilaBoleta = {
  documento_id: string;
  storage_key: string;
  manzana: string;
  lote: string;
};

export async function armarPaqueteDelPeriodo(
  trabajo: TrabajoTomado,
  ctx: ContextoPaquete,
): Promise<ResultadoPaquete> {
  const periodoId = trabajo.referenciaId;

  // 1. Leer QUÉ se empaqueta, bajo RLS y en su propia transacción corta.
  const boletas = await conUsuario(ctx.db, trabajo.solicitadoPor, async (tx) => {
    const { rows } = await tx.execute<FilaBoleta & { barrio_id: string }>(sql`
      select d.id as documento_id, d.storage_key, u.manzana, u.lote, d.barrio_id
        from documento_emitido d
        join liquidacion l on l.id = d.liquidacion_id
        join unidad_funcional u on u.id = l.unidad_funcional_id
       where d.periodo_id = ${periodoId} and d.tipo = 'boleta_unidad'
       -- **El orden es parte del contrato**: sin un orden estable el ZIP no es reproducible.
       -- Numérico y no alfabético, para que el lote 10 no quede entre el 1 y el 2.
       order by
         nullif(regexp_replace(u.manzana, '\\D', '', 'g'), '')::bigint nulls last, u.manzana,
         nullif(regexp_replace(u.lote, '\\D', '', 'g'), '')::bigint nulls last, u.lote,
         d.id
    `);

    for (const fila of rows) {
      // Aserción, nunca filtro: una fila de otro barrio detiene el trabajo en vez de filtrarse.
      if (fila.barrio_id !== trabajo.barrioId) {
        throw new Error("una boleta del lote pertenece a otro barrio: se detiene el empaquetado");
      }
    }
    return rows;
  });

  if (boletas.length === 0) {
    throw new Error("el período no tiene boletas emitidas: no hay qué empaquetar");
  }

  await ctx.alAvanzar({ total: boletas.length, hechos: 0 });

  // 2. Traer los objetos. **Fuera de toda transacción**: es I/O contra el storage, y una conexión
  //    abierta mientras se leen 510 objetos es una conexión secuestrada.
  const entradas: EntradaDeZip[] = [];
  let hechos = 0;
  for (const boleta of boletas) {
    entradas.push({ nombre: nombreEnElZip(boleta), contenido: await ctx.almacenamiento.get(boleta.storage_key) });
    hechos += 1;
    if (hechos % 25 === 0) await ctx.alAvanzar({ hechos });
  }

  const bytes = await armarZipDeterministico(entradas);
  const sha256 = createHash("sha256").update(bytes).digest("hex");

  // 3. Subir y registrar. La clave se arma acá y se valida contra el mismo patrón que el `CHECK`.
  const clave = claveDePaquete({ barrioId: trabajo.barrioId, periodoId, token: nuevoToken() });
  // `siNoExiste` por default: la clave lleva un token nuevo en cada armado, así que dos corridas
  // nunca compiten por el mismo objeto — y si compitieran, es mejor que falle a que se pise.
  await ctx.almacenamiento.put(clave, bytes, {
    contentType: "application/zip",
    descargarComo: `Liquidaciones.zip`,
  });

  await conUsuario(ctx.db, trabajo.solicitadoPor, (tx) =>
    registrarPaquete(tx, {
      periodoId,
      storageKey: clave,
      sha256,
      bytes: bytes.byteLength,
      documentoIds: boletas.map((b) => b.documento_id),
    }),
  );

  await ctx.alAvanzar({ hechos: boletas.length });
  return { escritos: boletas.length, yaEstaban: 0, bytes: bytes.byteLength };
}

/**
 * Cómo se llama cada boleta adentro del ZIP.
 *
 * Con la unidad, para que el administrador pueda encontrar una sin abrirlas todas — es un archivo
 * que se guarda y se consulta meses después. **Sin el nombre del titular**: el ZIP se archiva, se
 * copia y se reenvía, y un nombre de persona en el nombre de un archivo sobrevive a todo eso.
 */
function nombreEnElZip(boleta: FilaBoleta): string {
  const seguro = (s: string) => s.replace(/[^\p{L}\p{N}_-]/gu, "_");
  return `MZ-${seguro(boleta.manzana)}-LOTE-${seguro(boleta.lote)}.pdf`;
}

export type EntradaDeZip = { readonly nombre: string; readonly contenido: Buffer };

/**
 * Arma el ZIP **de forma reproducible**: las mismas entradas, en el mismo orden, dan siempre los
 * mismos bytes — y por lo tanto el mismo `sha256`.
 *
 * Está separada del resto del trabajo para poder probar exactamente esa propiedad, que es la que
 * hace que el hash guardado signifique algo. Si el archivo no fuera reproducible, el `sha256` de
 * `paquete_distribucion` no acreditaría el contenido: acreditaría una corrida, y compararlo contra
 * un segundo armado siempre daría distinto sin que nada estuviera mal.
 *
 * Las tres fuentes de variación quedan fijadas: el **orden** (lo decide quien llama, y viene del
 * `order by` de la consulta), el **`mtime`** (constante) y el **nivel de compresión** (el default de
 * la librería, que no se toca por corrida).
 */
export function armarZipDeterministico(entradas: readonly EntradaDeZip[]): Promise<Buffer> {
  const zip = new ZipFile();
  const bytes = new Promise<Buffer>((resolver, rechazar) => {
    const partes: Buffer[] = [];
    zip.outputStream.on("data", (parte: Buffer) => partes.push(parte));
    zip.outputStream.on("end", () => resolver(Buffer.concat(partes)));
    zip.outputStream.on("error", rechazar);
  });

  for (const entrada of entradas) {
    zip.addBuffer(entrada.contenido, entrada.nombre, { mtime: FECHA_ENTRADA_ZIP, compress: true });
  }
  zip.end();
  return bytes;
}
