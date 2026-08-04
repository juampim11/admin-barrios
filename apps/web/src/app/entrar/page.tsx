import type { Metadata } from "next";
import { listarUsuariosDemo } from "@admin-barrios/data/servicios/usuarios-demo";
import { entrarComoUsuarioDemo, salir } from "../../acciones/sesion.ts";
import {
  BarraDeAcciones,
  Boton,
  BotonSecundarioSubmit,
  IconoHerramienta,
  PanelDeIngreso,
  TarjetaDePersona,
} from "@admin-barrios/ui";
import { Nota } from "../../componentes/ui.tsx";
import { conIngreso, hayPantallaDeIngreso, sesionActual } from "../../servidor/db.ts";
import estilos from "./entrar.module.css";

export const metadata: Metadata = { title: "Elegí con quién entrar" };

/**
 * **Esta pantalla no es un inicio de sesión.** Es el sustituto de identidad de desarrollo del
 * ADR-0002 §2.3: se elige con qué usuario del elenco mirar el sistema, y la "sesión" es ese uuid en
 * una cookie sin firmar. Está escrito en la pantalla a propósito — que se vea que no es un mecanismo
 * de seguridad forma parte del diseño.
 *
 * Es el **único** lugar del repo que puede llamar a `conIngreso()`, la única excepción a la puerta
 * única a la base; el test de arquitectura (regla 10) falla si aparece en cualquier otro archivo.
 * `conIngreso` corre con la conexión de request **sin identidad**, con la RLS activa: lo único que
 * puede leer es lo que tenga una policy `using (true)`, que hoy es `usuario_demo` y nada más.
 *
 * **Lista vacía no es un error, es producción.** Fuera de `local` la tabla está vacía y no hay a
 * quién suplantar: eso *es* el candado (§2.4 vuelta 3), y la pantalla lo dice con esas palabras en
 * vez de ofrecer un reintento.
 */
export default async function Entrar({
  searchParams,
}: {
  searchParams: Promise<{ readonly error?: string }>;
}) {
  const { error } = await searchParams;

  // Con un adapter de Auth real esta pantalla no existe: se entra con credenciales, no eligiendo de
  // una lista. Se comprueba antes de tocar la base para que el 404 sea la respuesta y no un error.
  if (!hayPantallaDeIngreso()) {
    return (
      <main id="contenido">
        <PanelDeIngreso
          aviso={<span>Proveedor de identidad real.</span>}
          marca="admin-barrios"
          bajada="administración de barrios, consorcios y PH"
        >
          <Nota tono="peligro" titulo="Esta pantalla no corresponde a este entorno.">
            El proveedor de identidad activo no es el sustituto de desarrollo. Se entra con
            credenciales, no eligiendo de una lista.
          </Nota>
        </PanelDeIngreso>
      </main>
    );
  }

  const [elenco, sesion] = await Promise.all([conIngreso(listarUsuariosDemo), sesionActual()]);

  return (
    <main id="contenido">
      <PanelDeIngreso
        aviso={
          <>
            <IconoHerramienta />
            <span>
              <strong>Entorno de demostración.</strong> Usuarios y datos ficticios. No hay
              contraseña: se elige con quién mirar el sistema.
            </span>
          </>
        }
        marca="admin-barrios"
        bajada="administración de barrios, consorcios y PH"
      >
        {sesion ? (
          <Nota tono="info" titulo={`Ya estás dentro como ${sesion.identidad.nombre ?? sesion.identidad.email}.`}>
            <BarraDeAcciones>
              <Boton href="/" variante="primario">
                Ir a mis barrios
              </Boton>
              <form action={salir}>
                <BotonSecundarioSubmit>Salir</BotonSecundarioSubmit>
              </form>
            </BarraDeAcciones>
          </Nota>
        ) : null}

        {error ? (
          <Nota tono="alerta" titulo="No se pudo entrar con ese usuario.">
            Puede que ya no esté en el elenco de la demo. El motivo exacto quedó en el log del
            servidor.
          </Nota>
        ) : null}

        <div>
          <h1 className={estilos.titulo}>Elegí con quién entrar</h1>
          <p className={estilos.aclaracion}>
            Cada personaje tiene otros permisos y ve otra cosa. Mirar el sistema con los ojos de un
            operador y con los de un contador es como se descubren los agujeros de aislamiento antes
            de que los descubra un cliente.
          </p>
        </div>

        {elenco.length === 0 ? (
          <Nota tono="neutro" titulo="No hay usuarios de demostración en este entorno.">
            Es el comportamiento esperado fuera de <code>local</code>: sin elenco no hay a quién
            suplantar. En desarrollo, el elenco lo carga el seed (<code>pnpm db:seed</code>).
          </Nota>
        ) : (
          <ul className={estilos.elenco}>
            {elenco.map((usuario) => (
              <li key={usuario.usuarioId}>
                <form action={entrarComoUsuarioDemo}>
                  <input type="hidden" name="usuarioId" value={usuario.usuarioId} />
                  <TarjetaDePersona
                    iniciales={iniciales(usuario.nombre)}
                    nombre={usuario.nombre}
                    descripcion={usuario.descripcion}
                    correo={usuario.email}
                  />
                </form>
              </li>
            ))}
          </ul>
        )}

        <p className={estilos.pie}>
          APP_ENTORNO=local · adapter dev-suplantacion · tabla usuario_demo (migración 0019) · la
          cookie de sesión es el uuid en claro, sin firmar
        </p>
      </PanelDeIngreso>
    </main>
  );
}

/** Dos letras del nombre. Decorativo (`aria-hidden`): nunca reemplaza al nombre, lo acompaña. */
function iniciales(nombre: string): string {
  const partes = nombre.trim().split(/\s+/);
  const primera = partes[0]?.[0] ?? "";
  const segunda = partes.length > 1 ? (partes[partes.length - 1]?.[0] ?? "") : "";
  return `${primera}${segunda}`.toUpperCase();
}
