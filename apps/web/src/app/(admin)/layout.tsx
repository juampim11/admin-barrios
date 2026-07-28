import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { salir } from "../../acciones/sesion.ts";
import { Chip } from "../../componentes/ui.tsx";
import { IconoHerramienta } from "../../componentes/iconos.tsx";
import { sesionActual } from "../../servidor/db.ts";
import estilos from "./admin.module.css";

/**
 * El armazón de todas las pantallas del administrador.
 *
 * Resuelve la sesión una sola vez para la barra superior. **El `redirect()` va acá afuera, no dentro
 * de ninguna transacción**: `sesionActual()` no abre una (ADR-0002 §3.1).
 *
 * Que esto redirija no reemplaza a `conSesion()`: cada página vuelve a pedir la sesión al consultar,
 * y esa es la que decide. Este chequeo existe para que la cabecera sepa a quién nombrar, no para
 * autorizar nada.
 *
 * La marca lleva el chip **"Demostración"** en todas las pantallas: mientras el proveedor de
 * identidad sea el sustituto de desarrollo, la app no se puede confundir con una real (doc 06 §c.5).
 */
export default async function LayoutAdministrador({ children }: { children: ReactNode }) {
  const sesion = await sesionActual();
  if (!sesion) redirect("/entrar");

  return (
    <div className={estilos.marco}>
      <header className={estilos.barra}>
        <Link href="/" className={estilos.marca}>
          admin-barrios
        </Link>
        {/* Punteado: la sesión es de un andamio de desarrollo, no de un proveedor de identidad real. */}
        <Chip tono="alerta" icono={<IconoHerramienta />} punteado>
          Demostración
        </Chip>
        <div className={estilos.sesion}>
          <span className={estilos.quien}>
            <span className={estilos.quienNombre}>
              {sesion.identidad.nombre ?? sesion.identidad.email ?? "sin nombre"}
            </span>
            <span className={estilos.quienOrigen}>{sesion.origen}</span>
          </span>
          <form action={salir}>
            <button type="submit" className={estilos.salir}>
              Salir
            </button>
          </form>
        </div>
      </header>
      {children}
    </div>
  );
}
