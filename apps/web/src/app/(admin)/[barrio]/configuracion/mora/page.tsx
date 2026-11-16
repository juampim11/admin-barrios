import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { moraDelBarrio } from "@admin-barrios/data/servicios/mora";
import { formatearMonto } from "@admin-barrios/shared/dinero";
import { PACTOS_EJECUTIVIDAD, TEXTO_PACTO } from "@admin-barrios/shared/mora";
import type { FiguraJuridica } from "@admin-barrios/shared/barrio";
import { Chip } from "@admin-barrios/ui";
import { Definicion, Definiciones, EncabezadoDePagina, Nota, Pagina, Panel, ui } from "../../../../../componentes/ui.tsx";
import { FIGURA_JURIDICA } from "../../../../../componentes/etiquetas.tsx";
import { esIdValido, migaDelBarrio, rutaDeEstudiosJuridicos, rutaDeMoraDelBarrio } from "../../../../../rutas.ts";
import { conSesion } from "../../../../../servidor/db.ts";
import { criterioEnPalabras } from "../../../../../componentes/mora/textos.ts";

const mayuscula = (t: string): string => t.charAt(0).toUpperCase() + t.slice(1);
import { EstudioEnElBarrio, FormularioDeMoraDelBarrio } from "./formularios.tsx";

export const metadata: Metadata = { title: "Mora y estudios" };

/**
 * **Configuración del barrio › Mora y estudios** (encargo E-a; maqueta de mora, pantalla 5): qué
 * estudios trabajan la mora del barrio, cuál viene elegido al derivar, con qué criterio se proponen las
 * derivaciones, si hay pacto de ejecutividad y qué dice la boleta de una unidad derivada.
 *
 * **La figura jurídica se muestra y no se edita acá**: es `barrio.figura_juridica`, se fija al dar de
 * alta el barrio y cambia todo el encuadre (legal y contable), no solo la mora.
 */
export default async function MoraYEstudios({ params }: { readonly params: Promise<{ readonly barrio: string }> }) {
  const { barrio: barrioId } = await params;
  if (!esIdValido(barrioId)) notFound();

  const cfg = await conSesion((tx) => moraDelBarrio(tx, { barrioId }));
  // `notFound()` afuera de la transacción, que ya cerró (ADR-0002 §3.1).
  if (!cfg) notFound();

  const adm = cfg.criterioAdministracion;
  const criterioAdministracion = `${mayuscula(criterioEnPalabras(adm))}.`;
  const figura = FIGURA_JURIDICA[cfg.barrio.figuraJuridica as FiguraJuridica] ?? cfg.barrio.figuraJuridica;
  const hrefEstudios = rutaDeEstudiosJuridicos(cfg.administracion.id);
  const textoFigura = (
    <p>
      <strong>{figura}</strong>{" "}
      <span className={ui.secundaria}>· La figura se fija al dar de alta el barrio y no se cambia acá.</span>
    </p>
  );

  return (
    <Pagina>
      <EncabezadoDePagina
        migas={[
          migaDelBarrio(cfg.barrio),
          { texto: "Configuración del barrio", href: `/${cfg.barrio.id}/configuracion` },
          { texto: "Mora y estudios" },
        ]}
        titulo="Mora y estudios"
        bajada={`Qué estudios trabajan la mora de ${cfg.barrio.nombre} y con qué criterio se proponen las derivaciones.`}
        acciones={cfg.puedeEditar ? undefined : <Chip tono="neutro">Solo lectura</Chip>}
      />

      {cfg.puedeEditar ? null : (
        <Nota tono="neutro" titulo="Estás viendo la mora del barrio en modo de solo lectura.">
          La cambia la administración del barrio.
        </Nota>
      )}

      <Panel
        titulo="Estudios que trabajan en este barrio"
        origen="De los dados de alta por la administración. Al derivar viene elegido el de por defecto, y solo se ofrecen los que trabajan acá."
        pie={
          <Link href={hrefEstudios}>Agregar otro estudio en Configuración general</Link>
        }
      >
        {cfg.estudios.length === 0 ? (
          <p className={ui.secundaria}>
            La administración todavía no dio de alta ningún estudio. Se agregan en Configuración general › Estudios jurídicos.
          </p>
        ) : cfg.puedeEditar ? (
          cfg.estudios.map((e) => <EstudioEnElBarrio key={e.id} barrioId={cfg.barrio.id} estudio={e} />)
        ) : (
          <ul>
            {cfg.estudios.map((e) => (
              <li key={e.id}>
                {e.nombre} {e.porDefecto ? <Chip tono="marca">Por defecto</Chip> : null}{" "}
                <span className={ui.secundaria}>
                  {e.enElBarrio ? "trabaja acá" : "no trabaja acá"} · {e.derivadas === 1 ? "1 derivada" : `${e.derivadas} derivadas`} acá
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {cfg.puedeEditar ? (
        <FormularioDeMoraDelBarrio
          barrioId={cfg.barrio.id}
          criterioAdministracion={criterioAdministracion}
          criterioPropio={cfg.criterioPropio}
          pacto={cfg.pactoEjecutividad}
          pactos={PACTOS_EJECUTIVIDAD.map((p) => ({ valor: p, texto: TEXTO_PACTO[p] }))}
          leyendaAdministracion={cfg.leyendaAdministracion}
          leyendaPropia={cfg.leyendaPropia}
          figura={textoFigura}
        />
      ) : (
        <Panel titulo="Criterio, figura y aviso">
          <Definiciones>
            <Definicion termino="Criterio para proponer">
              {cfg.criterioPropio
                ? `Propio: ${criterioEnPalabras(cfg.criterioPropio)}.`
                : `El de la administración: ${criterioAdministracion}`}
            </Definicion>
            <Definicion termino="Figura del barrio">{textoFigura}</Definicion>
            <Definicion termino="Pacto de ejecutividad">{TEXTO_PACTO[cfg.pactoEjecutividad]}</Definicion>
            <Definicion termino="Aviso en la boleta">{cfg.leyendaPropia ?? `Texto base de la administración: ${cfg.leyendaAdministracion}`}</Definicion>
          </Definiciones>
        </Panel>
      )}

      <p>
        <Link href={rutaDeMoraDelBarrio(cfg.barrio.id)}>Ver la mora del barrio</Link>
      </p>
    </Pagina>
  );
}
