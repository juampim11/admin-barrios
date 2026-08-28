/**
 * `Notificador` — la interfaz propia de correo saliente (ADR-0000 §3, regla dura 1).
 *
 * El dominio **nunca** ve `nodemailer`. Mismo espejo que `packages/almacenamiento`: la interfaz
 * acá, el SDK adentro de `src/adapters/`, y una regla del gate que verifica que nadie más lo
 * importe.
 *
 * **Por qué un paquete y no `apps/worker`.** El worker orquesta, no define contratos. Si el envío
 * viviera ahí, el día que la web mande un correo —un reenvío puntual, una recuperación de acceso—
 * nacería un segundo camino de envío, con su propio remitente y su propio formato. (Hoy la web **no**
 * puede mandar correo, y eso lo hace cumplir el guard de credenciales: `SMTP_*` está en
 * `REGLAS.worker.permitidas` y deliberadamente no en las de `web`.)
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * CUATRO DECISIONES DE LA FIRMA QUE NO SON OBVIAS
 *
 * 1. **`enviar()` devuelve el `mensajeId`, y no es cosmético.** Es lo que va a permitir aparear un
 *    rebote con su envío el día que exista la fuente. Un `Promise<void>` cierra esa puerta y obliga
 *    a aparear por dirección y fecha, que es adivinar.
 *
 * 2. **El `Message-ID` lo genera el EMISOR, no el transporte.** Si lo pusiera el servidor SMTP,
 *    cambiaría al cambiar de proveedor y el registro dejaría de ser estable en el tiempo. Con id
 *    propio, migrar de SMTP a una API no invalida ni una fila vieja — **eso es el agnosticismo del
 *    ADR-0000 aplicado a este caso**, no la existencia de la interfaz por sí sola.
 *
 * 3. **Un destinatario por llamada.** No hay `cc`, no hay `bcc`, y `para` no es un array. No es una
 *    simplificación: es el control estructural contra el sobre con dos boletas. Una firma que acepta
 *    varios destinatarios es una firma en la que alguien, alguna vez, va a agrupar por dirección
 *    "para ahorrar envíos".
 *
 * 4. **Adjuntos por bytes, nunca por ruta ni por URL.** Una ruta ata al filesystem del worker; una
 *    URL reintroduce lo que el diseño cerró — una URL firmada tiene TTL ≤ 600 s y estaría vencida
 *    antes de que el vecino abra el mail, y una sin vencimiento es PII servida a quien tenga el
 *    link.
 */

import { randomUUID } from "node:crypto";

/** Un archivo que viaja adentro del mensaje. Bytes, no rutas ni links — ver el punto 4 de arriba. */
export type AdjuntoDeCorreo = {
  /** Cómo lo ve quien recibe. Ya saneado por quien lo arma. */
  readonly nombre: string;
  readonly contenido: Buffer;
  readonly tipoMime: string;
};

export type MensajeDeCorreo = {
  /**
   * **Un solo destinatario.** El nombre va aparte de la dirección a propósito: las cabeceras se
   * arman con objetos, nunca concatenando — un `\r` o un `\n` en un nombre concatenado es inyección
   * de cabecera, y el nombre del contacto es texto que escribe un humano.
   */
  readonly para: { readonly direccion: string; readonly nombre: string | null };
  /** El `From:`. Sale del barrio si lo declaró, o del default del entorno. */
  readonly de: { readonly direccion: string; readonly nombre: string | null };
  /** A dónde contesta quien recibe. Tiene que ser una casilla que alguien lea. */
  readonly responderA: string | null;
  readonly asunto: string;
  readonly cuerpoTexto: string;
  readonly cuerpoHtml: string | null;
  readonly adjuntos: readonly AdjuntoDeCorreo[];
  /**
   * El `Message-ID` que este envío va a llevar, **ya generado** (ver `nuevoMensajeId`). Viaja en el
   * mensaje y se guarda en `envio_liquidacion.mensaje_id` **antes** de mandar.
   */
  readonly mensajeId: string;
  /**
   * `Return-Path` con VERP: `rebotes+{envio_id}@dominio`. **Se configura y todavía no se lee.**
   *
   * Cuesta una variable de entorno hoy y es la diferencia entre "hay que rediseñar" y "hay que
   * escribir el consumidor" el día que se implemente la recepción de rebotes — sin esto habría que
   * re-emitir todo lo ya enviado para poder aparearlo.
   */
  readonly returnPath: string | null;
};

export type ResultadoEnvio = {
  /** El mismo que viajó en el mensaje. Se devuelve para que el llamador no tenga que recordarlo. */
  readonly mensajeId: string;
};

/**
 * El transporte. **Una sola operación**, y esa acotación es deliberada: un `Notificador` que además
 * leyera un buzón sería la superficie de entrada que la Fase 2 decidió no abrir todavía.
 */
export type Notificador = {
  enviar(mensaje: MensajeDeCorreo): Promise<ResultadoEnvio>;
};

/**
 * Un `Message-ID` nuestro, con la forma que manda el RFC 5322: `<algo@dominio>`.
 *
 * El dominio va en el identificador porque un `Message-ID` sin él no es único fuera de este sistema
 * — y el sentido de esta llave es poder reconocer nuestro mensaje **cuando vuelve de afuera**.
 */
export function nuevoMensajeId(dominio: string): string {
  return `<${randomUUID()}@${dominio}>`;
}

/**
 * La dirección de rebote con VERP para un envío.
 *
 * `rebotes+{envio_id}@dominio` reduce el problema de "parsear un email arbitrario" a "leer un uuid
 * de una dirección", que es la diferencia entre un consumidor de rebotes de veinte líneas y uno que
 * necesita su propio panel de seguridad.
 */
export function direccionDeRebote(dominio: string, envioId: string): string {
  return `rebotes+${envioId}@${dominio}`;
}
