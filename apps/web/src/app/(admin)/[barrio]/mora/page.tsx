import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { moraDeLaAdministracion } from "@admin-barrios/data/servicios/mora";
import { Boton } from "@admin-barrios/ui";
import { EncabezadoDePagina, Pagina } from "../../../../componentes/ui.tsx";
import { leerFiltroMora, parametrosDelFiltro } from "../../../../componentes/mora/filtro.ts";
import { ListaDeMora } from "../../../../componentes/mora/lista-de-mora.tsx";
import { criterioEnPalabras, ORIGEN_DEL_CRITERIO } from "../../../../componentes/mora/textos.ts";
import { esIdValido, migaDelBarrio, rutaDeMoraDelBarrio, rutaDelCsvDeMora } from "../../../../rutas.ts";
import { conSesion } from "../../../../servidor/db.ts";

export const metadata: Metadata = { title: "Mora" };

/**
 * **La mora del barrio** (encargo E-a; maqueta de mora, pantalla 2): las unidades con deuda vencida
 * de este barrio, cuáles cumplen el criterio para derivar y cuáles ya trabaja un estudio. Es la misma
 * lista que «Mora · todos los barrios» (`ListaDeMora`), filtrada y sin la columna Barrio.
 *
 * Una lectura: `moraDeLaAdministracion` con el barrio, bajo RLS. El barrio de la URL elige, no autoriza.
 */
export default async function MoraDelBarrio({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly barrio: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { barrio: barrioId } = await params;
  if (!esIdValido(barrioId)) notFound();
  const filtro = leerFiltroMora(await searchParams, { conBarrio: false });

  const mora = await conSesion((tx) => moraDeLaAdministracion(tx, { barrioId }));
  // `notFound()` afuera de la transacción, que ya cerró (ADR-0002 §3.1).
  const barrio = mora?.barrios[0];
  if (!mora || !barrio) notFound();

  return (
    <Pagina>
      <EncabezadoDePagina
        migas={[migaDelBarrio(barrio), { texto: "Mora" }]}
        titulo="Mora"
        bajada={`Las unidades de ${barrio.nombre} con deuda vencida. Se proponen las que pasan el criterio del barrio: ${criterioEnPalabras(barrio.criterio)} (${ORIGEN_DEL_CRITERIO[barrio.origenCriterio]}).`}
        acciones={
          <Boton href={rutaDelCsvDeMora({ barrioId }, parametrosDelFiltro(filtro))} variante="secundario" tamano="sm">
            Bajar CSV
          </Boton>
        }
      />
      <ListaDeMora mora={mora} filtro={filtro} ruta={rutaDeMoraDelBarrio(barrioId)} conBarrio={false} />
    </Pagina>
  );
}
