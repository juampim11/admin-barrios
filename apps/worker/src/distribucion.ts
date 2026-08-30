/**
 * El trabajo `distribuir_liquidaciones`: un correo por unidad, con dos adjuntos.
 *
 * **Es el único trabajo del sistema que hace algo irreversible.** Emitir un PDF de nuevo es gratis,
 * rearmar un ZIP es gratis, una URL firmada vence sola. Un correo entregado se queda en la bandeja
 * del vecino para siempre. Todo el orden de las operaciones de abajo está puesto para que un fallo
 * en cualquier punto deje *menos* correos, nunca más.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * EL ORDEN, QUE ES LO ÚNICO QUE IMPORTA ACÁ
 *
 *   1. Verificar que **haya con qué mandar** antes de tocar una fila. Un lote registrado que después
 *      no puede salir porque falta una credencial deja 510 filas mintiendo.
 *   2. Registrar el lote entero y **commitear**. Recién ahí existe algo que impide el duplicado.
 *   3. Bajar el informe **una vez**: es el mismo archivo para los 510.
 *   4. Por cada envío: reclamar (`pendiente → enviando`) **y commitear**, después mandar, después
 *      registrar el resultado. Si el proceso muere en el medio, la fila queda en `enviando` y nadie
 *      la reintenta: es estado desconocido a propósito.
 *   5. Sellar el período como `distribuida` **solo si no quedó nada en vuelo**.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * UN FALLO NO CORTA EL LOTE
 *
 * Una casilla que rebota, un buzón lleno, un dominio que ya no existe: son cosas normales en un
 * padrón de 510 unidades. Cortar el lote en la primera dejaría a los 400 vecinos siguientes sin su
 * liquidación por culpa de una dirección mal cargada. Cada fallo se registra en su fila, con un
 * código corto, y el bucle sigue.
 *
 * Lo que sí corta el lote es un fallo del **transporte** (autenticación rechazada, servidor caído):
 * ahí ninguno de los que siguen va a salir, y seguir intentando 500 veces solo consigue que el
 * proveedor bloquee la cuenta.
 */

import { conUsuario, type DbConIdentidad } from "@admin-barrios/data/client";
import {
  crearLoteDeEnvios,
  enviosPendientes,
  leerContextoDeDistribucion,
  marcarEnvioAceptado,
  marcarEnvioFallado,
  marcarPeriodoDistribuido,
  reclamarEnvio,
  resumenDeEnvios,
} from "@admin-barrios/data/servicios/distribucion";
import {
  armarCuerpoDeLiquidacion,
  VERSION_PLANTILLA_LIQUIDACION,
} from "@admin-barrios/notificaciones/plantillas/liquidacion";
import { direccionDeRebote, nuevoMensajeId } from "@admin-barrios/notificaciones";
import type { ObjectStorage } from "@admin-barrios/almacenamiento";
import type { TrabajoTomado } from "./servidor/cola.ts";
import type { CorreoDelWorker } from "./servidor/contexto.ts";

export type ContextoDistribucion = {
  readonly db: DbConIdentidad;
  readonly almacenamiento: ObjectStorage;
  readonly correo: CorreoDelWorker;
  readonly alAvanzar: (avance: { hechos?: number; total?: number }) => Promise<void>;
};

export type ResultadoDistribucion = {
  readonly escritos: number;
  readonly yaEstaban: number;
  readonly fallados: number;
};

/**
 * Los errores cuyo texto **sí** puede llegar a una pantalla, igual que `ErrorDeEmision`. El resto se
 * traduce a un mensaje genérico en `main.ts`, porque los `raise exception` del esquema interpolan
 * valores de filas que quien mira el trabajo puede no tener derecho a ver.
 */
export class ErrorDeDistribucion extends Error {
  override readonly name = "ErrorDeDistribucion";
}

export async function distribuirLiquidaciones(
  trabajo: TrabajoTomado,
  ctx: ContextoDistribucion,
): Promise<ResultadoDistribucion> {
  const periodoId = trabajo.referenciaId;

  /*
   * 1. **Antes de tocar una sola fila.** Registrar el lote y descubrir después que no hay
   *    credenciales dejaría 510 filas diciendo "pendiente" para un envío que no puede ocurrir, y la
   *    pantalla mostraría un lote en curso que nadie va a mover.
   */
  if (ctx.correo === null) {
    throw new ErrorDeDistribucion(
      "El correo saliente no está configurado en este entorno y no se distribuyó nada. " +
        "Configurá las variables SMTP_* del worker y volvé a intentar.",
    );
  }
  const correo = ctx.correo;

  const contexto = await conUsuario(ctx.db, trabajo.solicitadoPor, (tx) =>
    leerContextoDeDistribucion(tx, { periodoId }),
  );

  // Aserción, nunca filtro — la misma que en `emision.ts` y `paquete.ts`.
  if (contexto.barrioId !== trabajo.barrioId) {
    throw new Error("el período del trabajo pertenece a otro barrio: se detiene la distribución");
  }

  /*
   * 2. **El lote nace acá y esta transacción cierra antes del primer `sendMail()`.** Es la línea que
   *    separa "puede haber duplicados" de "no puede haberlos".
   */
  const nacidos = await conUsuario(ctx.db, trabajo.solicitadoPor, (tx) =>
    crearLoteDeEnvios(tx, {
      periodoId,
      barrioId: contexto.barrioId,
      informeDocumentoId: contexto.informeDocumentoId,
      plantillaVersion: VERSION_PLANTILLA_LIQUIDACION,
      trabajoId: trabajo.id,
      destinatarios: contexto.destinatarios,
    }),
  );

  const pendientes = await conUsuario(ctx.db, trabajo.solicitadoPor, (tx) =>
    enviosPendientes(tx, { periodoId }),
  );

  await ctx.alAvanzar({ total: pendientes.length, hechos: 0 });

  // 3. El informe, una sola vez. Fuera de toda transacción: es I/O contra el storage.
  const informe = await ctx.almacenamiento.get(contexto.informeStorageKey);

  let aceptados = 0;
  let fallados = 0;

  for (const envio of pendientes) {
    /*
     * 4a. **La boleta se baja ANTES del claim, y esa línea es la que separa "un blip de red" de
     *     "un vecino que se quedó sin su liquidación".**
     *
     * Estaba adentro del `try`, después de reclamar. Un timeout del storage —uno solo, en una de
     * 510 vueltas— marcaba la fila `fallado` **sin que se hubiera intentado ningún correo**, y de
     * `fallado` no se vuelve: `enviosPendientes()` filtra `estado = 'pendiente'` y no hay ninguna
     * pantalla que la devuelva a la cola. El vecino se quedaba sin su boleta y el administrador sin
     * forma de arreglarlo desde el producto.
     *
     * Acá arriba, un `get` que falla deja la fila **intacta en `pendiente`** y el próximo encolado
     * la toma. **No roza la regla de oro**: bajar un PDF no le manda nada a nadie, así que adelantar
     * este I/O no adelanta ningún efecto irreversible.
     *
     * El fallo del storage sigue contando como fallo del destinatario —no se lo traga— pero se
     * registra sin quemar la fila: se cuenta y se sigue, igual que antes.
     */
    let boleta: Buffer;
    try {
      boleta = await ctx.almacenamiento.get(envio.boletaStorageKey);
    } catch (e) {
      /*
       * Ni se reclama ni se marca `fallado`: la fila queda `pendiente` y es reintentable. Se cuenta
       * para que la barra avance y para que el resumen final no mienta sobre cuántos salieron.
       */
      fallados += 1;
      // Solo el id del envío y el código corto: esta línea va al log del worker, y ni la dirección
      // ni el mensaje crudo del proveedor tienen por qué terminar ahí (mismo criterio que
      // `error_codigo`).
      console.warn(`no se pudo leer la boleta del envío ${envio.id}: ${codigoDeFalla(e)}`);
      await ctx.alAvanzar({ hechos: aceptados + fallados });
      continue;
    }

    /*
     * 4b. **El claim, en su propia transacción.** `conUsuario` cierra la transacción al volver, así
     *     que para cuando se ejecuta la línea siguiente la fila ya está commiteada como `enviando`
     *     con su `Message-ID` puesto. Ese es el punto de todo el archivo.
     */
    const mensajeId = nuevoMensajeId(correo.dominioRebotes);
    const reclamado = await conUsuario(ctx.db, trabajo.solicitadoPor, (tx) =>
      reclamarEnvio(tx, { envioId: envio.id, mensajeId }),
    );
    // `false` significa "otro la tomó o alguien la canceló": se sigue de largo, jamás se reintenta.
    if (!reclamado) continue;

    try {
      const cuerpo = armarCuerpoDeLiquidacion({
        barrioNombre: contexto.barrioNombre,
        periodoEtiqueta: contexto.periodoEtiqueta,
        denominacion: contexto.denominacion,
        unidadEtiqueta: envio.unidadEtiqueta,
        nombreDestinatario: envio.nombre,
        responderA: null,
      });

      await correo.notificador.enviar({
        para: { direccion: envio.email, nombre: envio.nombre },
        de: correo.remitente,
        // `null` y no una casilla inventada: el `From:` del barrio ya es una dirección que se lee.
        responderA: null,
        asunto: cuerpo.asunto,
        cuerpoTexto: cuerpo.texto,
        cuerpoHtml: null,
        mensajeId,
        returnPath: direccionDeRebote(correo.dominioRebotes, envio.id),
        adjuntos: [
          /*
           * Los nombres de archivo **no llevan el nombre del titular**, igual que adentro del ZIP y
           * que en las descargas firmadas: un adjunto se guarda y se reenvía, y el nombre sobrevive
           * a todo eso.
           */
          {
            nombre: `Liquidacion-${contexto.periodoEtiqueta.replace("/", "-")}.pdf`,
            contenido: boleta,
            tipoMime: "application/pdf",
          },
          {
            nombre: `Informe-${contexto.periodoEtiqueta.replace("/", "-")}.pdf`,
            contenido: informe,
            tipoMime: "application/pdf",
          },
        ],
      });

      await conUsuario(ctx.db, trabajo.solicitadoPor, (tx) =>
        marcarEnvioAceptado(tx, { envioId: envio.id }),
      );
      aceptados += 1;
    } catch (e) {
      /*
       * **El código corto, nunca el mensaje del servidor.** Un error de SMTP suele traer la
       * dirección completa del destinatario y a veces un pedazo del cuerpo; esta columna la lee una
       * pantalla de administración, y no tiene por qué ser el lugar por donde se filtre eso.
       */
      await conUsuario(ctx.db, trabajo.solicitadoPor, (tx) =>
        marcarEnvioFallado(tx, { envioId: envio.id, codigo: codigoDeFalla(e) }),
      );
      fallados += 1;

      /*
       * Un fallo de transporte no es "esta casilla no anda": es "ninguna va a andar". Seguir con los
       * 400 restantes solo consigue que el proveedor bloquee la cuenta, y deja 400 filas `fallado`
       * que en realidad nunca se intentaron de verdad.
       */
      if (esFallaDeTransporte(e)) {
        throw new ErrorDeDistribucion(
          "El servidor de correo rechazó la conexión y se detuvo el envío. " +
            `Se alcanzó a enviar ${aceptados} de ${pendientes.length}; el resto quedó pendiente.`,
        );
      }
    }

    await ctx.alAvanzar({ hechos: aceptados + fallados });
  }

  /*
   * 5. El sello del período. `marcarPeriodoDistribuido()` no hace nada si quedó algo `pendiente` o
   *    `enviando` — y que no haga nada es correcto: el estado `distribuida` es terminal y su firma
   *    se congela, así que no se declara hasta que sea verdad.
   */
  await conUsuario(ctx.db, trabajo.solicitadoPor, (tx) => marcarPeriodoDistribuido(tx, { periodoId }));

  const resumen = await conUsuario(ctx.db, trabajo.solicitadoPor, (tx) =>
    resumenDeEnvios(tx, { periodoId }),
  );

  return {
    escritos: aceptados,
    // Los que ya existían de un intento anterior: se recorrieron, pero no nacieron en esta corrida.
    yaEstaban: pendientes.length - nacidos > 0 ? pendientes.length - nacidos : 0,
    fallados: resumen.fallados,
  };
}

/**
 * Un código corto y estable para `envio_liquidacion.error_codigo`.
 *
 * Es deliberadamente pobre: el nombre del error y nada más. Lo que sirve para diagnosticar va al log
 * del worker, que no es un dato de negocio ni lo lee una pantalla.
 */
function codigoDeFalla(e: unknown): string {
  const codigo = codigoSmtp(e);
  if (codigo !== null) return codigo;
  return e instanceof Error ? e.name : "desconocido";
}

/**
 * El `code` que traen los errores de un cliente SMTP (`EAUTH`, `EENVELOPE`, …).
 *
 * No está en el tipo `Error` de Node, así que se lee estructuralmente y **sin castear a través de
 * `Error`**: un `as` que promete una forma que el tipo no tiene es el hábito con el que después se
 * lee una propiedad que no existe y se escribe `undefined` en una columna.
 */
function codigoSmtp(e: unknown): string | null {
  if (typeof e !== "object" || e === null || !("code" in e)) return null;
  const codigo: unknown = (e as { code: unknown }).code;
  return typeof codigo === "string" ? codigo : null;
}

/**
 * Distingue "esta dirección no anda" de "el correo no sale para nadie".
 *
 * Los códigos son los que levanta un cliente SMTP cuando el problema es la conexión o la cuenta, no
 * el destinatario. Ante la duda **se sigue**: cortar el lote por un error ambiguo deja sin
 * liquidación a vecinos cuya casilla estaba perfecta.
 */
const FALLAS_DE_TRANSPORTE = new Set(["EAUTH", "ECONNECTION", "ESOCKET", "ETLS", "EDNS"]);

function esFallaDeTransporte(e: unknown): boolean {
  const codigo = codigoSmtp(e);
  return codigo !== null && FALLAS_DE_TRANSPORTE.has(codigo);
}
