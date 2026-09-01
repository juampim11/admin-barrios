/**
 * De la configuración del entorno al notificador, o a `null` con el motivo puesto.
 *
 * Vive aparte de `main.ts` porque tiene una decisión con filo —qué pasa cuando el SMTP está a
 * medio configurar— y `main.ts` no debería tener decisiones.
 */

import { crearNotificadorSmtp } from "@admin-barrios/notificaciones/smtp";
import type { CorreoDelWorker } from "./servidor/contexto.ts";
import type { Configuracion } from "./servidor/configuracion.ts";

/**
 * Separa `"Administración <liquidaciones@barrio.test>"` en nombre y dirección.
 *
 * **No valida la dirección** y no es un descuido: el adapter rechaza cualquier CR/LF antes de
 * mandar, y el servidor SMTP rechaza lo que no sea una casilla. Una tercera validación acá solo
 * agregaría una forma más de decir que no, con su propio criterio, distinto de los otros dos.
 */
export function partirRemitente(valor: string): { direccion: string; nombre: string | null } {
  const conNombre = /^\s*(.*?)\s*<\s*([^>]+)\s*>\s*$/.exec(valor);
  if (conNombre) {
    const nombre = conNombre[1] ?? "";
    return { direccion: (conNombre[2] ?? "").trim(), nombre: nombre.length > 0 ? nombre : null };
  }
  return { direccion: valor.trim(), nombre: null };
}

/**
 * El notificador, si el entorno lo permite.
 *
 * **O están las seis variables o no está ninguna**: una configuración a medias es peor que ninguna,
 * porque el worker arrancaría creyendo que puede mandar y fallaría recién con el lote en la mano.
 * Ante la duda, no hay correo — y el trabajo de distribución lo dice en su primera línea.
 *
 * `secure` sale del puerto y no de una variable propia: 465 es TLS implícito y 587 hace STARTTLS.
 * **No se expone "sin cifrado"** — mandar credenciales y PII en claro no es una opción de
 * configuración, así que no hay forma de pedirlo.
 */
export function armarCorreoDelWorker(config: Configuracion): CorreoDelWorker {
  const { smtpHost, smtpPuerto, smtpUsuario, smtpPassword, smtpRemitente, smtpDominioRebotes } = config;

  if (!smtpHost || !smtpPuerto || !smtpUsuario || !smtpPassword || !smtpRemitente || !smtpDominioRebotes) {
    return null;
  }

  return {
    notificador: crearNotificadorSmtp({
      host: smtpHost,
      puerto: smtpPuerto,
      usuario: smtpUsuario,
      password: smtpPassword,
      seguro: smtpPuerto === 465,
    }),
    remitente: partirRemitente(smtpRemitente),
    dominioRebotes: smtpDominioRebotes,
  };
}
