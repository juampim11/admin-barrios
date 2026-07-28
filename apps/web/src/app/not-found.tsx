import Link from "next/link";
import estilos from "./error.module.css";

/**
 * El 404 de toda la app, y también lo que ve alguien que pide un barrio o un período **que no puede
 * leer**.
 *
 * Los dos casos se ven igual **a propósito**: si "no existe" y "no tenés acceso" se distinguieran, el
 * uuid de un barrio ajeno sería un oráculo de existencia — se podría averiguar qué barrios administra
 * otro estudio probando identificadores. Por eso el texto no promete que la cosa exista.
 */
export default function NoEncontrado() {
  return (
    <main className={estilos.marco} id="contenido">
      <div className={estilos.caja}>
        <h1 className={estilos.titulo}>Acá no hay nada</h1>
        <p className={estilos.texto}>
          Esta dirección no corresponde a nada que tu usuario pueda ver. Puede que el barrio o el
          período no existan, o que no estén entre los que administrás.
        </p>
        <Link href="/" className={estilos.boton}>
          Ir a mis barrios
        </Link>
      </div>
    </main>
  );
}
