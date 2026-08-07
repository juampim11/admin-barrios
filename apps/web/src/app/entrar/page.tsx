import type { Metadata } from "next";
import { listarUsuariosDemo } from "@admin-barrios/data/servicios/usuarios-demo";
import { entrarComoUsuarioDemo, salir } from "../../acciones/sesion.ts";
import {
  BarraDeAcciones,
  Boton,
  BotonSecundarioSubmit,
  DetalleDelEntorno,
  HojaDeIngreso,
  ListaDeElenco,
  PanelDeMarca,
  TarjetaDeIngreso,
  TarjetaDePersona,
} from "@admin-barrios/ui";
import { Nota } from "../../componentes/ui.tsx";
import { conIngreso, hayPantallaDeIngreso, sesionActual } from "../../servidor/db.ts";

/**
 * El nombre del producto, y nada más.
 *
 * `absolute` saltea la plantilla del layout raíz (`%s · admin-barrios`), que si no dejaría
 * "admin-barrios · admin-barrios". Es lo que se ve en la solapa durante **toda** la demostración, así
 * que no puede ser una instrucción dirigida a quien la está dando.
 */
export const metadata: Metadata = { title: { absolute: "admin-barrios" } };

/**
 * ⚠ **No es decorativo, y hoy sería cierto por accidente.** La ruta es dinámica porque en algún punto
 * se leen los `headers()`, pero eso es una deducción sobre el compilador. Si dejara de valer, un
 * `pnpm build` corrido en una máquina de desarrollo —con `.env.local` y `APP_ENTORNO=local`—
 * hornearía **el elenco de la demostración en un HTML estático** dentro del artefacto, servido
 * después sin chequeo de `Host` y sin validar el entorno. Verificado por la regla 10d.
 */
export const dynamic = "force-dynamic";

/**
 * **Esta pantalla no es un inicio de sesión.** Es el sustituto de identidad de desarrollo del
 * ADR-0002 §2.3: se elige con qué usuario del elenco mirar el sistema, y la "sesión" es ese uuid en
 * una cookie sin firmar. Está escrito en la pantalla a propósito, y en el desplegable del pie está
 * escrito con nombre y apellido de las piezas.
 *
 * **Un solo `<form>` y N botones de envío, no N formularios.** Un botón `submit` aporta su propio par
 * nombre/valor al `FormData`, así que `name="usuarioId" value={id}` en el botón alcanza.
 *
 * ⚠ **El motivo que estaba escrito acá era falso, y se corrige en vez de borrarse.** Decía que con un
 * formulario por persona "un doble clic podía entrar con quien no era". No: el doble clic cae sobre
 * el mismo elemento y manda dos veces **el mismo** identificador. Lo señaló `code-reviewer`. Lo que
 * la forma única gana de verdad es más modesto y sigue valiendo la pena: menos DOM, un contrato más
 * chico, y **un solo lugar** donde deshabilitar el conjunto el día que esta pantalla tenga
 * JavaScript. Hoy cuesta cero bytes y así se queda.
 *
 * ⚠ Lo que la forma única **sí** introduce: si alguien mete un `<input>` acá adentro, Enter envía con
 * el primer botón `submit` —o sea, entra como la primera persona de la lista sin que nadie lo pida—.
 * No es una advertencia suelta: la regla 10e del test de arquitectura prohíbe todo `<input>` en esta
 * pantalla, justamente por esto.
 *
 * **Cero JavaScript, y se conserva.** El error vuelve por la URL (`?error=`) y no por
 * `useActionState`: sin eso haría falta un componente de cliente y la primera pantalla del producto
 * dejaría de costar cero bytes de bundle. Está explicado en el docblock de `acciones/sesion.ts`.
 *
 * **Ningún campo de credencial, ni siquiera decorativo** (guardrail 1, verificado por la regla 10c).
 * Un campo de contraseña es una afirmación —"este sistema verifica quién sos"— y hoy es falsa. Un
 * campo de correo de texto libre es peor: convierte el formulario en un delator del elenco.
 *
 * Es el **único** lugar del repo que puede llamar a `conIngreso()`, la única excepción a la puerta
 * única a la base; el test de arquitectura (regla 10) falla si aparece en cualquier otro archivo.
 * `conIngreso` corre con la conexión de request **sin identidad**, con la RLS activa: lo único que
 * puede leer es lo que tenga una policy `using (true)`, que hoy es `usuario_demo` y nada más.
 *
 * **Elenco vacío no es un error, es producción.** Fuera de `local` la tabla está vacía y no hay a
 * quién suplantar: eso *es* el candado (§2.4 vuelta 3), y por eso el estado vacío está redactado en
 * tono neutro y no ofrece reintentar.
 */
export default async function Entrar({
  searchParams,
}: {
  searchParams: Promise<{ readonly error?: string }>;
}) {
  const { error } = await searchParams;

  /*
   * El panel de la izquierda es el mismo en los dos caminos: es la cara del producto, no un adorno
   * del modo demostración. No lleva ni un control focusable, así que el tabulador entra directo a la
   * tarjeta.
   */
  const marca = (
    <PanelDeMarca
      nombre="admin-barrios"
      descripcion="Administración de barrios, consorcios y PH."
    />
  );

  /*
   * Con un adapter de Auth real esta pantalla no existe: se entra con credenciales, no eligiendo de
   * una lista. Se comprueba antes de tocar la base, y el tono es informativo y no de error: no falló
   * nada ni hizo nada mal quien llegó acá — está mirando otro entorno. Sin banda de declaración,
   * porque acá no hay ninguna demostración que declarar.
   */
  if (!hayPantallaDeIngreso()) {
    return (
      <main id="contenido">
        <HojaDeIngreso marca={marca}>
          <TarjetaDeIngreso titulo="Entrar" bajada="Este entorno usa un proveedor de identidad real.">
            <Nota tono="info" titulo="Acá no se entra eligiendo de una lista.">
              La lista de personas es del entorno de demostración. En este se entra con las
              credenciales de cada uno, por el proveedor de identidad que tenga configurado la
              administración.
            </Nota>
          </TarjetaDeIngreso>
        </HojaDeIngreso>
      </main>
    );
  }

  const [elenco, sesion] = await Promise.all([conIngreso(listarUsuariosDemo), sesionActual()]);

  return (
    <main id="contenido">
      <HojaDeIngreso marca={marca}>
        <TarjetaDeIngreso
          declaracion={
            <>
              <strong>Entorno de demostración.</strong> Los barrios, las personas y los importes son
              ficticios. Se entra eligiendo desde qué rol mirar el sistema, sin contraseña.
            </>
          }
          titulo="Entrar"
          bajada="Después de entrar elegís con qué barrio vas a trabajar."
          pie={
            <DetalleDelEntorno resumen="Detalles del entorno">
              APP_ENTORNO=local · adapter dev-suplantacion · tabla usuario_demo (migración 0019) · la
              cookie de sesión es el uuid en claro, sin firmar
            </DetalleDelEntorno>
          }
        >
          {/*
            Importa más de lo que parece: `salir` vuelve acá, así que esta es la última pantalla de la
            demostración. Quien acaba de salir tiene que poder volver a entrar sin pensar, y quien
            llegó acá con la sesión abierta tiene que poder seguir donde estaba.
          */}
          {sesion ? (
            <Nota
              tono="info"
              titulo={`Ya estás dentro como ${sesion.identidad.nombre ?? sesion.identidad.email}.`}
            >
              <BarraDeAcciones>
                <Boton href="/" variante="primario" tamano="sm">
                  Seguir donde estaba
                </Boton>
                <form action={salir}>
                  <BotonSecundarioSubmit>Salir</BotonSecundarioSubmit>
                </form>
              </BarraDeAcciones>
            </Nota>
          ) : null}

          {/*
            El motivo exacto queda en el log del servidor y acá llega uno genérico: es la misma regla
            del `mensajeDeError` del ADR-0002 §4.2. Redactado para quien está mirando la demostración,
            no para quien la programó.
          */}
          {error ? (
            <Nota tono="peligro" titulo="No se pudo entrar.">
              Probá de nuevo con la misma persona. Si vuelve a fallar, es que ya no está en el elenco
              de esta demostración: elegí otra.
            </Nota>
          ) : null}

          {elenco.length === 0 ? (
            <Nota tono="neutro" titulo="Todavía no hay nadie cargado en este entorno.">
              Es lo esperable fuera de una máquina de desarrollo: sin elenco no hay a quién elegir.
            </Nota>
          ) : (
            <form action={entrarComoUsuarioDemo}>
              <ListaDeElenco rotulo="Elegí desde qué rol mirar">
                {/*
                  `rol` y `alcance` vienen partidos del servicio. Acá se componen y nada más: cómo se
                  guardan en `usuario_demo` es un formato de datos de `packages/data`, y decodificarlo
                  desde una pantalla era ponerle a esta página una responsabilidad de otra capa
                  (ADR-0002 §5).
                */}
                {elenco.map((usuario) => (
                  <li key={usuario.usuarioId}>
                    <TarjetaDePersona
                      iniciales={iniciales(usuario.nombre)}
                      nombre={usuario.nombre}
                      rol={usuario.rol}
                      alcance={usuario.alcance}
                      nombreCampo="usuarioId"
                      valor={usuario.usuarioId}
                    />
                  </li>
                ))}
              </ListaDeElenco>
            </form>
          )}
        </TarjetaDeIngreso>
      </HojaDeIngreso>
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
