/**
 * `crearAuthProvider()` — la **única** fábrica de identidad del sistema (ADR-0002 §2.4, vuelta 1).
 *
 * Es el único archivo del repo autorizado a nombrar `adapters/dev-suplantacion.ts`, y el test de
 * arquitectura falla si alguien más lo importa. El motivo es que el gate vive **acá**: un
 * `crearAuthDevSuplantacion(...)` escrito a mano en otro lado se saltea la validación entera y nadie
 * lo nota hasta que hay un despliegue con el andamio activo.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * POR QUÉ `APP_ENTORNO` Y NO `NODE_ENV`
 *
 * `NODE_ENV` es una señal de **modo de build**, no de entorno de despliegue: hay razones legítimas
 * para correr un entorno real con `NODE_ENV=development` (mensajes de error completos, un preview).
 * Una condición `=== "production"` **falla abierta** para todo lo demás — `undefined`, `"Production"`,
 * `"prod"`, `"staging"` — y este repo ya estaba en esa situación: `.env.example` fija
 * `NODE_ENV=development` y el compose se lo pasa tal cual, con el puerto publicado en todas las
 * interfaces.
 *
 * Por eso: variable propia, **obligatoria, sin default**, y evaluada como **lista de permitidos**.
 * El sustituto se habilita si y solo si `APP_ENTORNO === "local"`. Cualquier otro valor —incluidos
 * `undefined` y la cadena vacía— hace que la fábrica **lance**, y el proceso no atiende.
 *
 * Que la falla llegue **temprano** no es gratis y hay que cablearlo: Next carga los módulos de ruta
 * perezosamente, así que un `throw` de módulo aparecería recién en el primer request que toque esa
 * ruta, como un 500, con el contenedor "sano" para el orquestador. Por eso `apps/web` dispara esta
 * validación desde `instrumentation.ts` (hook `register()`, que corre al levantar el servidor).
 */

import { z } from "zod";
import type { AuthProvider } from "./auth-provider.ts";
import {
  CLAVE_DEV_SUPLANTACION,
  crearAuthDevSuplantacion,
  type DependenciasDevSuplantacion,
} from "./adapters/dev-suplantacion.ts";

/** Los tres entornos posibles. Lo que no está declarado explícitamente acá, no existe. */
export const ENTORNOS = ["local", "staging", "produccion"] as const;
export type Entorno = (typeof ENTORNOS)[number];

/**
 * Obligatoria y **sin `.default()`**. Un default es exactamente el modo de falla que esta variable
 * existe para eliminar: si `APP_ENTORNO` no llega, el proceso tiene que negarse a arrancar, no
 * suponer.
 */
export const entornoSchema = z.enum(ENTORNOS, {
  errorMap: () => ({
    message:
      `APP_ENTORNO es obligatoria y tiene que ser una de: ${ENTORNOS.join(" | ")}. ` +
      "No tiene default a propósito: lo que no está declarado explícitamente como desarrollo se " +
      "trata como producción (ADR-0002 §2.4).",
  }),
});

export const configuracionAuthSchema = z.object({
  entorno: entornoSchema,
  /**
   * Qué adapter se pide. Hoy el único implementado es el sustituto de desarrollo.
   *
   * `required_error` explícito: sin él, faltar la variable da el `"Required"` genérico de Zod y el
   * mensaje no nombra a `AUTH_PROVIDER` — que es justo el dato que necesita quien está mirando por
   * qué no le arranca el contenedor.
   */
  proveedor: z
    .string({ required_error: "AUTH_PROVIDER es obligatoria (ver apps/web/.env.local.example)" })
    .min(1, "AUTH_PROVIDER es obligatoria (ver apps/web/.env.local.example)"),
});
export type ConfiguracionAuth = z.infer<typeof configuracionAuthSchema>;

/** Dependencias de infraestructura de los adapters. Se inyectan: `packages/auth` no conoce `pg`. */
export type DependenciasAuth = DependenciasDevSuplantacion;

/**
 * Devuelve el provider activo, o **lanza**.
 *
 * Lanzar es el comportamiento correcto y no una molestia: un proceso sin forma válida de establecer
 * identidad no tiene nada que atender. Es preferible un contenedor que no levanta a uno que levanta
 * y deja entrar.
 */
export function crearAuthProvider(
  configuracion: Readonly<Partial<ConfiguracionAuth>>,
  dependencias: DependenciasAuth,
): AuthProvider {
  const config = configuracionAuthSchema.parse(configuracion);

  if (config.proveedor === CLAVE_DEV_SUPLANTACION) {
    // ── EL GATE. Lista de permitidos: `=== "local"`, no `!== "produccion"`. ────────────────────
    if (config.entorno !== "local") {
      throw new Error(
        `el sustituto de identidad "${CLAVE_DEV_SUPLANTACION}" solo se habilita con APP_ENTORNO="local", ` +
          `y este proceso arrancó con APP_ENTORNO="${config.entorno}". No es una advertencia: el ` +
          "proceso no atiende. Para un entorno real hay que elegir un adapter de Auth de verdad " +
          "(ADR-0002 §2.5).",
      );
    }
    return crearAuthDevSuplantacion(dependencias);
  }

  // Los adapters reales todavía no existen, y decirlo es más honesto que un `default` silencioso.
  // Lo que falta antes de la primera cuenta real está enumerado en el ADR-0002 §2.5: elegir el IdP,
  // el puente `sub` del proveedor → `membership.user_id`, alta de usuarios, revocación efectiva.
  throw new Error(
    `AUTH_PROVIDER="${config.proveedor}" no tiene adapter implementado. El único disponible hoy es ` +
      `"${CLAVE_DEV_SUPLANTACION}", y solo con APP_ENTORNO="local". Elegir el adapter de producción ` +
      "es una decisión abierta (ADR-0002 §2.5 punto 1).",
  );
}

/**
 * ¿Este entorno puede ofrecer la pantalla de ingreso sin sesión?
 *
 * Se pregunta por `aptoParaProduccion` del provider y **no** por `APP_ENTORNO` otra vez: con un
 * adapter real, `conIngreso()` no existe y llamarla lanza (ADR-0002 §3.1). Que la condición se
 * derive del contrato y no de la variable es lo que evita que las dos se desincronicen.
 */
export function permiteIngresoSinSesion(provider: AuthProvider): boolean {
  return !provider.aptoParaProduccion;
}
