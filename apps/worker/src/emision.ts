/**
 * El trabajo de verdad: generar los documentos de un período y dejarlos guardados.
 *
 * ### Las tres reglas que ordenan este archivo
 *
 * 1. **Todo corre con `conUsuario(dbRequest, trabajo.solicitadoPor, …)`.** La conexión que saltea la
 *    RLS no aparece acá y no puede aparecer: el gate de arquitectura falla si el identificador
 *    `DbJob` se nombra fuera de `servidor/cola.ts`. Si a quien pidió la emisión le revocaron la
 *    membresía entre el encolado y la corrida, esto **falla** — y está bien: falla cerrado.
 *
 * 2. **`trabajo.barrioId` es una aserción, nunca un filtro.** Bajo `conUsuario` la RLS ya devuelve
 *    solo lo que ese usuario puede leer; el barrio de la fila del trabajo sirve para **comparar** y
 *    detener el proceso si no coincide. La diferencia importa: con un `where barrio_id = …` una fila
 *    corrupta filtraría distinto y nadie se enteraría; con una aserción, una fila corrupta frena el
 *    trabajo.
 *
 * 3. **La transacción no envuelve el render.** Leer las vistas → cerrar → renderizar 50 → guardar 50
 *    objetos → abrir otra transacción y escribir 50 filas. Una transacción abierta catorce segundos
 *    es una conexión secuestrada y filas bloqueadas (ADR-0002 §3.1 y §6.4 punto 3).
 */

import { createHash } from "node:crypto";
import { conUsuario, type DbConIdentidad } from "@admin-barrios/data/client";
import { armarVistasDelPeriodo } from "@admin-barrios/data/servicios/vista-boleta";
import {
  liquidacionesConBoleta,
  liquidacionesPorUnidad,
  nombreDeArchivo,
  registrarDocumentoEmitido,
} from "@admin-barrios/data/servicios/documentos";
import { solicitudesDeBoletas, VERSION_VISTA_BOLETA, type GeneradorDocumento } from "@admin-barrios/documentos";
import type { MedioCobranza } from "@admin-barrios/documentos/cobranza";
import {
  claveDeDocumento,
  nuevoToken,
  ObjetoYaExiste,
  type ObjectStorage,
} from "@admin-barrios/almacenamiento";
import { sql } from "drizzle-orm";
import type { TrabajoTomado } from "./servidor/cola.ts";

export type Contexto = {
  readonly db: DbConIdentidad;
  readonly almacenamiento: ObjectStorage;
  readonly generador: GeneradorDocumento;
  readonly medio: MedioCobranza;
  readonly chunk: number;
  readonly timeoutMs: number;
  /** Se llama al terminar cada chunk. Es lo que mueve la barra de la pantalla. */
  readonly alAvanzar: (avance: { hechos?: number; total?: number }) => Promise<void>;
};

export type ResultadoEmision = {
  readonly escritos: number;
  /** Los que ya estaban: un reintento no vuelve a escribirlos y tampoco los cuenta como nuevos. */
  readonly yaEstaban: number;
};

/** Cuánto se parte el array en pedazos de `n`. */
/**
 * Cada cuántos documentos subidos se mueve la barra dentro de un chunk. Diez es lo que el usuario
 * pidió ver y cuesta ~5 `UPDATE` por chunk: nada al lado de los 50 `put` a storage que ya se hacen.
 */
const PASO_DE_AVANCE = 10;

function enPedazos<T>(items: readonly T[], n: number): T[][] {
  const salida: T[][] = [];
  for (let i = 0; i < items.length; i += n) salida.push(items.slice(i, i + n));
  return salida;
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function emitirDocumentosDelPeriodo(
  trabajo: TrabajoTomado,
  ctx: Contexto,
): Promise<ResultadoEmision> {
  // ── 1. Leer, bajo la identidad de quien pidió la emisión, y cerrar la transacción ────────────
  //
  // Se leen primero los **identificadores** y recién después las vistas, filtradas: armar la vista de
  // una boleta que ya está emitida es trabajo tirado, y renderizarla otra vez sería peor — dejaría
  // dos documentos por unidad, distinguibles solo por la hora, y quien mira la pantalla no sabría
  // cuál mandó (ADR-0001 §5 puntos 3 y 6).
  const contexto = await conUsuario(ctx.db, trabajo.solicitadoPor, async (tx) => {
    const fila = (
      await tx.execute<{ barrio_id: string }>(
        sql`select barrio_id from periodo_expensa where id = ${trabajo.referenciaId}`,
      )
    ).rows[0];
    // Cero filas = el período no existe **o** el solicitante ya no lo puede leer. Los dos casos
    // terminan igual y tienen que terminar igual.
    if (!fila) {
      throw new ErrorDeEmision(
        "El período ya no está disponible para quien pidió la generación.",
        "periodo_inaccesible",
      );
    }
    const porUnidad = await liquidacionesPorUnidad(tx, trabajo.referenciaId);
    const yaEmitidas = await liquidacionesConBoleta(tx, trabajo.referenciaId);
    return { barrioIdReal: fila.barrio_id, porUnidad, yaEmitidas };
  });

  // ── 2. La aserción de aislamiento. NO es un filtro (ver regla 2 del encabezado) ──────────────
  if (contexto.barrioIdReal !== trabajo.barrioId) {
    throw new ErrorDeEmision(
      "La generación se detuvo por una comprobación de seguridad.",
      "barrio_no_coincide",
    );
  }

  const todas = [...contexto.porUnidad.values()];
  if (todas.length === 0) {
    throw new ErrorDeEmision("El período no tiene liquidaciones que emitir.", "sin_liquidaciones");
  }
  const pendientes = todas.filter((id) => !contexto.yaEmitidas.has(id));

  // El guard de early-exit barato: si el período ya está completo, se retorna **sin renderizar nada**
  // y sin abrir el navegador.
  await ctx.alAvanzar({ total: todas.length, hechos: contexto.yaEmitidas.size });
  if (pendientes.length === 0) {
    return { escritos: 0, yaEstaban: contexto.yaEmitidas.size };
  }

  const vistas = await conUsuario(ctx.db, trabajo.solicitadoPor, (tx) =>
    armarVistasDelPeriodo(tx, trabajo.referenciaId, { medio: ctx.medio, liquidacionIds: pendientes }),
  );

  // La huella de la plantilla. **Es la del CSS que emitió la plantilla, no la del módulo entero**:
  // un cambio de layout reflowea el documento y mueve este hash, que es para lo que sirve — pero un
  // cambio en el armado del markup que no toque una regla de estilo NO lo mueve. Está dicho acá
  // porque el nombre de la columna promete más de lo que esto cumple.
  //
  // Se calcula sobre **una sola** solicitud y no sobre el lote entero: los estilos son idénticos para
  // todas las boletas, y armar las 200 solicitudes acá para leerle el CSS a la primera duplicaba el
  // trabajo de Zod y de plantilla que después vuelve a hacerse por chunk — justo lo que el chunking
  // existe para evitar.
  const primera = vistas[0];
  const plantillaHash = primera ? sha256(solicitudesDeBoletas([primera])[0]?.estilos ?? "") : "";

  const porUnidad = contexto.porUnidad;
  let escritos = 0;
  let yaEstaban = contexto.yaEmitidas.size;

  // Cuántos objetos de este chunk ya se subieron. Se reinicia al cerrar el chunk, cuando `escritos`
  // pasa a contarlos de verdad.
  let subidos = 0;

  // ── 3. Un chunk por vez: renderizar fuera de transacción, guardar objeto, después la fila ────
  for (const grupo of enPedazos(vistas, ctx.chunk)) {
    const solicitudes = solicitudesDeBoletas(grupo);
    const pdfs = await ctx.generador.generarLote(solicitudes, {
      timeoutMs: ctx.timeoutMs,
      chunk: ctx.chunk,
    });

    const aRegistrar: {
      liquidacionId: string;
      storageKey: string;
      sha256: string;
      bytes: number;
      vista: unknown;
    }[] = [];

    for (const [i, pdf] of pdfs.entries()) {
      const vista = grupo[i];
      if (!vista) continue;

      const liquidacionId = porUnidad.get(vista.unidad.etiqueta);
      if (!liquidacionId) {
        // Que una boleta no encuentre su liquidación significa que las dos consultas ven padrones
        // distintos. Es un estado imposible por construcción, y por eso se detiene en vez de
        // registrar el documento contra `null` o contra la unidad de al lado.
        throw new ErrorDeEmision(
          "La generación se detuvo: una boleta no pudo asociarse a su liquidación.",
          "liquidacion_sin_pareja",
        );
      }

      const clave = claveDeDocumento({
        barrioId: trabajo.barrioId,
        periodoId: trabajo.referenciaId,
        tipo: "boleta_unidad",
        token: nuevoToken(),
      });

      // **El objeto primero, la fila después.** Si el proceso muere en el medio queda un objeto
      // huérfano de ~73 KB que nadie referencia. Al revés quedaría una fila que la pantalla ofrece
      // y cuya descarga rompe.
      try {
        await ctx.almacenamiento.put(clave, Buffer.from(pdf), {
          contentType: "application/pdf",
          siNoExiste: true,
          // El MISMO nombre que después firma la ruta de descarga. Estaban escritos dos veces, con
          // dos formas distintas, y ganaba el del presign: el de acá se leía como si hiciera algo.
          descargarComo: nombreDeArchivo({
            tipo: "boleta_unidad",
            periodo: vista.periodo.codigo,
            unidad: vista.unidad.etiqueta,
          }),
        });
      } catch (e) {
        // Con token aleatorio de 128 bits esto es, en la práctica, imposible. Se contempla igual
        // porque el put condicional existe justamente para que colisionar no pise un documento.
        if (e instanceof ObjetoYaExiste) {
          yaEstaban += 1;
          continue;
        }
        throw e;
      }

      aRegistrar.push({
        liquidacionId,
        storageKey: clave,
        sha256: sha256(pdf),
        bytes: pdf.byteLength,
        vista,
      });

      /*
       * **Avance de a poco mientras se suben los objetos del chunk.**
       *
       * El chunk es de 50 porque **es memoria medida** (ADR-0001 §3.2: ~520 MB de techo), así que
       * bajarlo para que la barra se mueva más seguido sería pagar con el presupuesto del contenedor
       * un problema de pantalla. Lo que sí se puede es reportar **adentro** del chunk: el usuario veía
       * la barra saltar de 50 en 50 y quedarse quieta un rato largo, sin saber si avanzaba o se había
       * colgado.
       *
       * Se reporta cada `PASO_DE_AVANCE` objetos subidos, o sea ~5 `UPDATE` de más por chunk — nada
       * frente a los 50 `put` que ya se hicieron. **La cifra puede ir momentáneamente adelante de lo
       * registrado en la base**, y eso es correcto: describe lo que ya se subió. Si el proceso muere
       * en el medio, al reanudar se recuenta desde `yaEmitidas` y el número se corrige solo — no
       * queda nada mal escrito, porque `hechos` es un indicador de avance, no un dato contable.
       */
      subidos += 1;
      if (subidos % PASO_DE_AVANCE === 0) {
        await ctx.alAvanzar({ hechos: escritos + yaEstaban + subidos });
      }
    }

    // Las filas del chunk, en una transacción corta y con la identidad de siempre.
    await conUsuario(ctx.db, trabajo.solicitadoPor, async (tx) => {
      for (const d of aRegistrar) {
        await registrarDocumentoEmitido(tx, {
          barrioId: trabajo.barrioId,
          periodoId: trabajo.referenciaId,
          tipo: "boleta_unidad",
          liquidacionId: d.liquidacionId,
          storageKey: d.storageKey,
          sha256: d.sha256,
          bytes: d.bytes,
          vista: d.vista,
          vistaVersion: VERSION_VISTA_BOLETA,
          motor: ctx.generador.motor,
          plantillaHash,
          medioCobranza: ctx.medio.clave,
        });
      }
    });

    escritos += aRegistrar.length;
    subidos = 0;
    await ctx.alAvanzar({ hechos: escritos + yaEstaban });
  }

  return { escritos, yaEstaban };
}

/**
 * Un fallo con un mensaje que **se puede escribir en `trabajo.error` y mostrar en una pantalla**.
 *
 * El `motivo` es para el log; el `message` es lo que ve una persona. Es la misma separación que
 * `mensajeDeError` de ADR-0002 §4.2, y existe por lo mismo: los `raise exception` del esquema
 * interpolan valores de filas que quien lee el trabajo puede no tener derecho a ver.
 */
export class ErrorDeEmision extends Error {
  override readonly name = "ErrorDeEmision";
  readonly motivo: string;
  constructor(mensaje: string, motivo: string) {
    super(mensaje);
    this.motivo = motivo;
  }
}
