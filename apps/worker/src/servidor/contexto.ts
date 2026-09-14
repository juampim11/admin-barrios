/**
 * El contrato de un trabajo del worker: qué recibe, qué devuelve.
 *
 * **Por qué existe este archivo.** Cada handler declara el contexto *que necesita* —`paquete.ts` no
 * pide un generador de PDF, `emision.ts` no pide un notificador— y eso está bien: es lo que hace
 * legible qué toca cada uno. Pero `main.ts` arma **un solo** objeto para los cuatro, y sin un tipo
 * que diga cuál es ese objeto, agregar una capacidad nueva rompía el llamado con un error que habla
 * del handler equivocado.
 *
 * Acá se declara una vez lo que el proceso ofrece; cada handler sigue pidiendo su subconjunto.
 */

import type { DbConIdentidad } from "@admin-barrios/data/client";
import type { ObjectStorage } from "@admin-barrios/almacenamiento";
import type { GeneradorDocumento } from "@admin-barrios/documentos";
import type { RegistroMediosCobranza } from "@admin-barrios/documentos/cobranza";
import type { Notificador } from "@admin-barrios/notificaciones";
import type { TrabajoTomado } from "./cola.ts";

/**
 * El correo saliente, **o `null`** cuando el entorno no lo configuró.
 *
 * `null` es una configuración válida y no un error: un worker sin SMTP emite documentos con
 * normalidad y lo único que no puede es distribuirlos. Ver `servidor/configuracion.ts`.
 */
export type CorreoDelWorker = {
  readonly notificador: Notificador;
  readonly remitente: { readonly direccion: string; readonly nombre: string | null };
  readonly dominioRebotes: string;
} | null;

/** Todo lo que `main.ts` pone a disposición de un trabajo. Cada handler usa lo suyo. */
export type ContextoDeTrabajo = {
  readonly db: DbConIdentidad;
  readonly almacenamiento: ObjectStorage;
  readonly generador: GeneradorDocumento;
  readonly registroDeMedios: RegistroMediosCobranza;
  readonly correo: CorreoDelWorker;
  readonly chunk: number;
  readonly timeoutMs: number;
  readonly alAvanzar: (avance: { hechos?: number; total?: number }) => Promise<void>;
};

/**
 * Lo que un trabajo informa al terminar.
 *
 * `fallados` es opcional porque solo la distribución tiene un resultado parcial que valga la pena
 * contar: en los demás, lo que no se escribió hizo fallar el trabajo entero. Un correo rechazado por
 * una casilla mal cargada **no** puede hacer fallar el lote de los otros 500.
 */
export type ResultadoTrabajo = {
  readonly escritos: number;
  readonly yaEstaban: number;
  readonly fallados?: number;
};

export type ManejadorDeTrabajo = (
  trabajo: TrabajoTomado,
  ctx: ContextoDeTrabajo,
) => Promise<ResultadoTrabajo>;
