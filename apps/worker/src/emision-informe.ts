/**
 * El trabajo `emitir_informe_periodo`: **el eslabón que faltaba**.
 *
 * `vista-informe.ts` produce la vista y `packages/documentos` sabe imprimirla, pero hasta acá nadie
 * las unía: el tipo de trabajo existía en el `CHECK` desde `0053`, el `CHECK` de la distribución
 * exige un `informe_mensual` emitido, y **nada emitía uno**. La cadena entera terminaba en un
 * documento que ningún camino podía producir.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * ES UN DOCUMENTO DEL PERÍODO, NO DE UNA UNIDAD, Y ESO CAMBIA TRES COSAS
 *
 *  1. **`liquidacion_id` va en `null`.** La columna es nullable justamente para esto: un informe no
 *     sale de la liquidación de nadie, sale del período.
 *  2. **No hay chunking ni navegador por lotes.** Es un PDF, no 510.
 *  3. **La idempotencia no puede ser "los que falten"**, que es lo que hace barata la re-emisión de
 *     boletas. Acá el guard es distinto y está abajo.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * POR QUÉ NO SE REEMITE SI YA HAY UNO
 *
 * `documento_emitido` es append-only: reemitir no reemplaza, **agrega**. Dos informes del mismo
 * período, distinguibles solo por la hora, y el envío adjunta "el más reciente" — o sea que un
 * segundo armado cambia en silencio qué documento reciben los vecinos que todavía no lo recibieron,
 * partiendo el lote en dos versiones del mismo informe.
 *
 * Así que este trabajo **no reemite**: si ya hay uno, sale sin hacer nada y lo dice. Corregir un
 * informe ya emitido es una decisión con consecuencias —hay que decidir qué pasa con los envíos que
 * ya salieron— y no puede ser el efecto colateral de volver a apretar un botón.
 */

import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { conUsuario } from "@admin-barrios/data/client";
import { armarVistaInformeMensual } from "@admin-barrios/data/servicios/vista-informe";
import {
  marcaDelPeriodo,
  nombreDeArchivo,
  registrarDocumentoEmitido,
} from "@admin-barrios/data/servicios/documentos";
import { solicitudDeInformeMensual } from "@admin-barrios/documentos";
import { VERSION_VISTA_INFORME } from "@admin-barrios/shared/documentos";
import { claveDeDocumento, nuevoToken, ObjetoYaExiste } from "@admin-barrios/almacenamiento";
import { ErrorDeEmision } from "./emision.ts";
import type { ContextoDeTrabajo, ResultadoTrabajo } from "./servidor/contexto.ts";
import type { TrabajoTomado } from "./servidor/cola.ts";

export async function emitirInformeDelPeriodo(
  trabajo: TrabajoTomado,
  ctx: ContextoDeTrabajo,
): Promise<ResultadoTrabajo> {
  const periodoId = trabajo.referenciaId;

  // ── 1. ¿Ya hay uno? El guard barato, antes de abrir el navegador ─────────────────────────────
  const previo = await conUsuario(ctx.db, trabajo.solicitadoPor, async (tx) => {
    const { rows } = await tx.execute<{ barrio_id: string; emitidos: string; hoy: string }>(sql`
      select p.barrio_id,
             (select count(*) from documento_emitido d
               where d.periodo_id = p.id and d.tipo = 'informe_mensual')::text as emitidos,
             -- **La fecha sale de Postgres, no del reloj del proceso.** El worker corre en UTC y el
             -- barrio no; después de las 21:00 ART un Date local ya es el día siguiente, y acá
             -- esa fecha se imprime en un documento contable. Misma convención que el resto de los
             -- servicios, que resuelven hoy con current_date.
             current_date::text as hoy
        from periodo_expensa p where p.id = ${periodoId}
    `);
    return rows[0];
  });

  if (!previo) {
    // "No existe" y "ya no lo podés leer" terminan igual, y tienen que terminar igual.
    throw new ErrorDeEmision(
      "El período ya no está disponible para quien pidió la emisión.",
      "periodo_inaccesible",
    );
  }

  // Aserción de aislamiento, nunca filtro. Misma regla que el resto de los trabajos.
  if (previo.barrio_id !== trabajo.barrioId) {
    throw new ErrorDeEmision(
      "La generación se detuvo por una comprobación de seguridad.",
      "barrio_no_coincide",
    );
  }

  if (Number.parseInt(previo.emitidos, 10) > 0) {
    // No es un error: es el resultado correcto de pedir dos veces lo mismo. Ver el encabezado.
    await ctx.alAvanzar({ total: 1, hechos: 1 });
    return { escritos: 0, yaEstaban: 1 };
  }

  await ctx.alAvanzar({ total: 1, hechos: 0 });

  // ── 2. La vista y la marca, bajo la identidad de quien pidió la emisión ──────────────────────
  //
  // La marca **la lee la capa de datos**, no la arma este archivo: si el membrete fuera un parámetro
  // del emisor, un documento con el membrete de otro barrio sería indistinguible de uno legítimo.
  const vista = await conUsuario(ctx.db, trabajo.solicitadoPor, async (tx) => {
    const marca = await marcaDelPeriodo(tx, { periodoId });
    // El corte y la emisión son HOY, con la fecha que dio Postgres en la consulta de arriba.
    return armarVistaInformeMensual(tx, periodoId, {
      marca,
      corteIso: previo.hoy,
      emisionIso: previo.hoy,
    });
  });

  // ── 3. Render fuera de toda transacción ──────────────────────────────────────────────────────
  const solicitud = solicitudDeInformeMensual(vista);
  const [pdf] = await ctx.generador.generarLote([solicitud], {
    timeoutMs: ctx.timeoutMs,
    chunk: 1,
  });

  if (!pdf) {
    throw new ErrorDeEmision("El informe no se pudo generar.", "render_vacio");
  }

  // ── 4. El objeto primero, la fila después ────────────────────────────────────────────────────
  //
  // Si el proceso muere en el medio queda un objeto huérfano que nadie referencia. Al revés quedaría
  // una fila que la pantalla ofrece y cuya descarga rompe.
  const clave = claveDeDocumento({
    barrioId: trabajo.barrioId,
    periodoId,
    tipo: "informe_mensual",
    token: nuevoToken(),
  });

  try {
    await ctx.almacenamiento.put(clave, Buffer.from(pdf), {
      contentType: "application/pdf",
      siNoExiste: true,
      descargarComo: nombreDeArchivo({ tipo: "informe_mensual", periodo: vista.periodo.codigo }),
    });
  } catch (e) {
    // Con token de 128 bits es impracticable; se contempla porque el `put` condicional existe
    // justamente para que colisionar no pise un documento ajeno.
    if (e instanceof ObjetoYaExiste) {
      throw new ErrorDeEmision("El informe no se pudo guardar. Reintentá.", "clave_colisionada");
    }
    throw e;
  }

  await conUsuario(ctx.db, trabajo.solicitadoPor, (tx) =>
    registrarDocumentoEmitido(tx, {
      barrioId: trabajo.barrioId,
      periodoId,
      tipo: "informe_mensual",
      // El informe es del período, no de una unidad: no sale de la liquidación de nadie.
      liquidacionId: null,
      storageKey: clave,
      sha256: createHash("sha256").update(pdf).digest("hex"),
      bytes: pdf.byteLength,
      vista,
      vistaVersion: VERSION_VISTA_INFORME,
      motor: ctx.generador.motor,
      plantillaHash: createHash("sha256").update(solicitud.estilos).digest("hex"),
      /*
       * **El informe no lleva cupón de pago**, así que no hay adapter que registrar. La columna es
       * `not null` y lo honesto es decir eso y no copiar el medio del barrio: registrar "el medio
       * que usa el barrio" en un documento que no imprimió ningún cupón sería un dato falso con
       * apariencia de dato.
       */
      medioCobranza: "no_aplica",
    }),
  );

  await ctx.alAvanzar({ hechos: 1 });
  return { escritos: 1, yaEstaban: 0 };
}
