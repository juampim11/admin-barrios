/**
 * Entrada pública de `@admin-barrios/auth`.
 *
 * **El adapter de desarrollo no se re-exporta desde acá.** Vive detrás de su propia subruta
 * (`@admin-barrios/auth/adapters/dev-suplantacion`) y la única referencia permitida en todo el repo
 * es la rama guardada de `registro.ts` (ADR-0002 §2.4, vuelta 4). Es el mismo mecanismo que mantiene
 * a Chromium fuera del bundle de la web: si se puede llegar por arrastre de un `export *`, la regla
 * se rompe sin que nadie lo escriba.
 *
 * `apps/web` tampoco necesita saber cómo se llama la cookie: le pasa a `sesionDe()` **todas** las
 * cookies entrantes y el provider busca la suya. Un nombre de cookie menos cruzando el límite es un
 * detalle menos del adapter filtrándose a la app.
 */

export type {
  AuthProvider,
  Credenciales,
  EntradaHttp,
  Identidad,
  InstruccionCookie,
  ResultadoInicio,
  Sesion,
} from "./auth-provider.ts";

export {
  ENTORNOS,
  configuracionAuthSchema,
  crearAuthProvider,
  entornoSchema,
  permiteIngresoSinSesion,
  type ConfiguracionAuth,
  type DependenciasAuth,
  type Entorno,
} from "./registro.ts";

export { esHostLocal } from "./host-local.ts";
