import type { ReactNode } from "react";
import { BotonSecundarioSubmit, ShellAdministrador } from "@admin-barrios/ui";
import { rolesDelUsuario } from "@admin-barrios/data/servicios/barrios";
import { rolDelElenco } from "@admin-barrios/data/servicios/usuarios-demo";
import { salir } from "../../acciones/sesion.ts";
import { ROL } from "../../componentes/etiquetas.tsx";
import { conSesion } from "../../servidor/db.ts";

/**
 * Armazón de todas las pantallas del administrador.
 *
 * Resuelve la sesión una sola vez para la barra superior. Cada página vuelve a consultar con
 * `conSesion()`: este layout nombra al usuario y encierra el chrome, no autoriza datos.
 */

/*
 * **Todo lo que cuelga de este layout se rinde por request, nunca en el build.**
 *
 * Sin esto, `next build` intenta **prerenderizar estáticamente** `/` y, al hacerlo, ejecuta el
 * provider de identidad y la conexión a la base: compilar terminaba exigiendo `DATABASE_URL_APP`
 * y un adapter de Auth válido, y el gate de CI —que corre el build **a propósito sin ninguna URL**—
 * quedaba rojo. Normalmente Next lo deduce solo, porque leer cookies vuelve dinámica a la ruta;
 * acá no alcanza, porque la falla ocurre **mientras** resuelve la sesión, antes de que la señal
 * de dinamismo llegue a registrarse.
 *
 * No se pierde nada: **ninguna pantalla del administrador puede ser estática.** Todas dependen de
 * quién mira —la sesión decide qué barrios ve y qué datos le devuelve la RLS—, así que una versión
 * cacheada en el build sería, en el mejor caso, la de nadie.
 */
export const dynamic = "force-dynamic";
export default async function LayoutAdministrador({ children }: { children: ReactNode }) {
  // `conSesion` resuelve la sesión una sola vez y redirige a /entrar si no hay.
  //
  // Debajo del nombre, el ROL (BL-024): antes decía el adapter de identidad («dev-suplantacion»), que
  // es jerga para quien mira la demo. Primero el rótulo de su tarjeta del elenco —el mismo que vio al
  // entrar, con su género—; sin elenco, los roles de sus membresías; sin ninguno, «Sin rol asignado».
  const { sesion, rol } = await conSesion(async (tx, sesion) => {
    const delElenco = await rolDelElenco(tx);
    const rol = delElenco ?? (await rolesDelUsuario(tx)).map((r) => ROL[r]).join(" · ");
    return { sesion, rol: rol || "Sin rol asignado" };
  });

  return (
    <ShellAdministrador
      marca="admin-barrios"
      marcaHref="/"
      demo
      usuario={sesion.identidad.nombre ?? sesion.identidad.email ?? "sin nombre"}
      origen={rol}
      accionSesion={
        <form action={salir}>
          <BotonSecundarioSubmit>Salir</BotonSecundarioSubmit>
        </form>
      }
    >
      {children}
    </ShellAdministrador>
  );
}
