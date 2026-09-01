/**
 * El adapter SMTP. **Es el único archivo del repo que importa `nodemailer`**, y hay una regla del
 * gate que lo verifica — mismo cerrojo que `packages/almacenamiento/src/adapters/s3.ts` tiene sobre
 * el SDK de S3.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * EL PRECEDENTE DEL SISTEMA DE GAS APENAS CUBRE EL TRANSPORTE
 *
 * `docs/diseno/01-alcance-modulos.md` §4.8 dice "reusa `nodemailer` del gas". Lo que hay allá es un
 * archivo de 46 líneas (`src/services/jobs/alerta-email-service.ts`) que manda **a un buzón fijo
 * interno, sin adjuntos, sin plantilla y sin manejo de rebotes**. Lo reusable son las diez líneas de
 * `createTransport`; el envío 1‑a‑1 con dos adjuntos, la plantilla y el registro son de cero.
 *
 * Conviene tenerlo escrito para que nadie lo lea como "esto ya estaba resuelto en el otro proyecto".
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * LAS CABECERAS SE ARMAN CON OBJETOS, NUNCA CONCATENANDO
 *
 * El nombre del barrio y el del contacto son texto que escribe un humano y terminan en el `Subject`
 * y en el display-name del `To`. Un `\r` o un `\n` ahí, concatenados a mano, son **inyección de
 * cabecera**: se pueden inventar cabeceras de respuesta enteras.
 *
 * Por eso este archivo **rechaza y no limpia**. Limpiar convierte un dato corrupto en un envío
 * silencioso con el nombre alterado; rechazar frena el envío y deja el problema a la vista, que es
 * lo que corresponde cuando lo que se detecta es un dato que no debería existir.
 */

import nodemailer from "nodemailer";
import type { MensajeDeCorreo, Notificador, ResultadoEnvio } from "../index.ts";

export type ConfiguracionSmtp = {
  readonly host: string;
  readonly puerto: number;
  readonly usuario: string;
  readonly password: string;
  /**
   * `true` para el puerto 465 (TLS implícito). En 587 va en `false` y el transporte hace STARTTLS.
   * No se expone "sin cifrado": mandar credenciales y PII en claro no es una opción de configuración.
   */
  readonly seguro: boolean;
};

/** Los caracteres que convierten un valor de cabecera en dos. */
const CORTE_DE_CABECERA = /[\r\n]/;

/**
 * Valida un valor que va a una cabecera. **Lanza** si trae un corte de línea.
 *
 * Ver el encabezado sobre por qué rechaza en vez de limpiar.
 */
function exigirCabeceraSegura(valor: string, campo: string): string {
  if (CORTE_DE_CABECERA.test(valor)) {
    throw new Error(
      `el campo "${campo}" del correo tiene un salto de línea y no se envía: un valor de cabecera ` +
        "con CR/LF permite inyectar cabeceras nuevas. Se rechaza en vez de limpiarlo, para que el " +
        "dato corrupto no salga convertido en un envío silencioso",
    );
  }
  return valor;
}

/**
 * El adapter sobre `nodemailer`.
 *
 * `pool: true` con un tope bajo de conexiones: 510 envíos son 510 llamadas, y abrir una conexión por
 * cada una es la forma más rápida de que el proveedor empiece a rechazar. El ritmo real lo maneja
 * quien recorre el lote, no este archivo.
 */
export function crearNotificadorSmtp(config: ConfiguracionSmtp): Notificador {
  const transporte = nodemailer.createTransport({
    host: config.host,
    port: config.puerto,
    secure: config.seguro,
    auth: { user: config.usuario, pass: config.password },
    pool: true,
    maxConnections: 2,
  });

  return {
    /*
     * `transporte.verify()` de nodemailer: abre la conexión, hace EHLO y autentica, **sin enviar
     * ningún mensaje**. Es exactamente el contrato que pide la interfaz — lanza si el transporte
     * sabe que hoy no puede — y no promete nada sobre si el servidor va a aceptar un destinatario
     * puntual, que es otra cosa y se descubre recién al mandar.
     */
    async verificar(): Promise<void> {
      await transporte.verify();
    },

    async enviar(mensaje: MensajeDeCorreo): Promise<ResultadoEnvio> {
      exigirCabeceraSegura(mensaje.asunto, "asunto");
      exigirCabeceraSegura(mensaje.para.direccion, "destinatario");
      if (mensaje.para.nombre) exigirCabeceraSegura(mensaje.para.nombre, "nombre del destinatario");
      exigirCabeceraSegura(mensaje.de.direccion, "remitente");
      if (mensaje.de.nombre) exigirCabeceraSegura(mensaje.de.nombre, "nombre del remitente");

      await transporte.sendMail({
        // Objetos y no cadenas armadas a mano: es la librería la que escapa el display-name.
        from: { address: mensaje.de.direccion, name: mensaje.de.nombre ?? "" },
        to: { address: mensaje.para.direccion, name: mensaje.para.nombre ?? "" },
        ...(mensaje.responderA ? { replyTo: mensaje.responderA } : {}),
        subject: mensaje.asunto,
        text: mensaje.cuerpoTexto,
        ...(mensaje.cuerpoHtml ? { html: mensaje.cuerpoHtml } : {}),
        // **Nuestro**, no el que generaría el servidor. Ver el punto 2 del encabezado de `index.ts`.
        messageId: mensaje.mensajeId,
        // VERP. Se configura hoy y todavía no se lee.
        ...(mensaje.returnPath ? { envelope: { from: mensaje.returnPath, to: mensaje.para.direccion } } : {}),
        attachments: mensaje.adjuntos.map((a) => ({
          filename: a.nombre,
          content: a.contenido,
          contentType: a.tipoMime,
        })),
      });

      /*
       * **Se devuelve el id que se mandó, no el que informa el transporte.** `nodemailer` devuelve un
       * `messageId` que en algunos servidores viene reescrito, y si el registro guardara ese valor,
       * la llave con la que después se busca un rebote dependería del proveedor. La estabilidad de
       * esa llave es justamente lo que hace que migrar de proveedor no invalide las filas viejas.
       */
      return { mensajeId: mensaje.mensajeId };
    },
  };
}
