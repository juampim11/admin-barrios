import type { Metadata } from "next";
import Link from "next/link";
import type { CSSProperties } from "react";
import { acentoBarrio } from "@admin-barrios/design-tokens/barrio-accent";
import {
  listarBarriosAccesibles,
  type BarrioAccesible,
} from "@admin-barrios/data/servicios/barrios";
import { IconoBarrio } from "../../componentes/iconos.tsx";
import { Chip, Dato, EncabezadoDePagina, Pagina, TiraDeChips, Vacio } from "../../componentes/ui.tsx";
import { etiquetaFiguraCorta, ROL } from "../../componentes/etiquetas.tsx";
import { conSesion } from "../../servidor/db.ts";
import estilos from "./barrios.module.css";

export const metadata: Metadata = { title: "Mis barrios" };

/**
 * Los barrios que el usuario administra — la primera pantalla después de entrar.
 *
 * **La lista no se filtra acá.** No hay un `where barrio_id in (…)`: sale de lo que la RLS deja ver.
 * Un usuario con membresía en un solo barrio ve una tarjeta y no sabe que existen las otras; el
 * administrador de estudio —el caso central del producto— ve todas las suyas (ADR-0002 §3.4).
 *
 * **Tarjetas y no una tabla**, porque son pocas y el dato que más importa es la identidad del barrio,
 * no comparar columnas entre barrios. La franja de acento determinístico de arriba es lo que hace que
 * dos barrios se distingan de reojo (doc 06 §b.5): el mismo `id` da siempre el mismo matiz, dentro de
 * una banda que excluye los colores de la marca y los semánticos.
 */
export default async function MisBarrios() {
  const barrios = await conSesion((tx) => listarBarriosAccesibles(tx));

  return (
    <main id="contenido">
      <Pagina>
        <EncabezadoDePagina
          titulo="Mis barrios"
          bajada={
            barrios.length === 0
              ? undefined
              : `${barrios.length} ${barrios.length === 1 ? "barrio accesible" : "barrios accesibles"} con tu usuario. Cada uno con su figura jurídica, su padrón y su liquidación aparte.`
          }
        />

        {barrios.length === 0 ? (
          <Vacio icono={<IconoBarrio />} titulo="Tu usuario no tiene rol de gestión en ningún barrio">
            No es que no haya barrios: es que ninguno es accesible con esta identidad. El acceso lo
            decide la base a partir de las membresías, y hoy las carga el seed.
          </Vacio>
        ) : (
          <div className={estilos.rejilla}>
            {barrios.map((barrio) => (
              <TarjetaDeBarrio key={barrio.id} barrio={barrio} />
            ))}
          </div>
        )}
      </Pagina>
    </main>
  );
}

function TarjetaDeBarrio({ barrio }: { readonly barrio: BarrioAccesible }) {
  const acento = {
    "--acento-claro": acentoBarrio(barrio.id, "light"),
    "--acento-oscuro": acentoBarrio(barrio.id, "dark"),
  } as CSSProperties;

  return (
    <Link href={`/${barrio.id}/tablero`} className={estilos.tarjeta} style={acento}>
      <div>
        <p className={estilos.nombre}>{barrio.nombre}</p>
        <p className={estilos.ubicacion}>{municipioLegible(barrio.municipio)}</p>
      </div>

      <TiraDeChips>
        <Chip tono="neutro">{etiquetaFiguraCorta(barrio.figuraJuridica)}</Chip>
      </TiraDeChips>

      <div className={estilos.cifras}>
        {/*
          "50 unidades" no dice nada; "50 unidades activas" sí, y la palabra "activas" es el
          denominador implícito — las de baja siguen en el padrón porque su deuda sigue existiendo
          (art. 2049) y se cuentan aparte, en la ficha del barrio.
        */}
        <Dato etiqueta="Unidades activas" origen="sin contar las dadas de baja" grande>
          <span className="dinero">{barrio.unidadesActivas}</span>
        </Dato>
        <Dato
          etiqueta="Se cobra como"
          origen={barrio.denominacionConcepto ? "denominación del barrio" : "la define el administrador"}
        >
          {barrio.denominacionConcepto ?? "—"}
        </Dato>
      </div>

      <div className={estilos.pieTarjeta}>
        <p>
          <span className={estilos.rolesEtiqueta}>Tu rol acá</span>
          {barrio.roles.length > 0 ? barrio.roles.map((rol) => ROL[rol]).join(" · ") : "sin rol directo"}
        </p>
        <p>
          <span className={estilos.rolesEtiqueta}>Administrado por</span>
          {/*
            `null` no significa "no hay estudio": significa que el nombre vive en un nodo ancestro
            que la policy de `tenant_node` no alcanza con este rol. Decir "sin administrador" sería
            afirmar algo que la consulta no sabe.
          */}
          {barrio.administrador?.nombre ?? "no visible con tu rol"}
        </p>
      </div>
    </Link>
  );
}

/** `"villa-allende"` → `"Villa Allende"`. El municipio se guarda como slug controlado, no como enum. */
function municipioLegible(slug: string): string {
  return slug
    .split("-")
    .map((parte) => (parte ? parte[0]?.toUpperCase() + parte.slice(1) : parte))
    .join(" ");
}
