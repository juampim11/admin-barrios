import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { estudiosDeLaAdministracion } from "@admin-barrios/data/servicios/mora";
import { formatearMonto } from "@admin-barrios/shared/dinero";
import { PREFERENCIAS_AVISO, TEXTO_PREFERENCIA_AVISO } from "@admin-barrios/shared/mora";
import { Chip, CuerpoConBarraLateral } from "@admin-barrios/ui";
import { Definicion, Definiciones, EncabezadoDePagina, MarcoTabla, Nota, Pagina, Panel, Tabla, Vacio, ui } from "../../../../componentes/ui.tsx";
import { rutaDeConfiguracionGeneral } from "../../../../rutas.ts";
import { conSesion } from "../../../../servidor/db.ts";
import { BarraDeLaAdministracion, BarraDelBarrio } from "../../barra-del-barrio.tsx";
import { barrioDeLaBarra, pedidoDeAdministracion, resolverAdministracion } from "../../administracion-elegida.ts";
import { AgregarEstudio, DarDeBajaEstudio, EditarEstudio, FormularioDeCriterio } from "./formularios.tsx";
import estilos from "../../admin.module.css";

export const metadata: Metadata = { title: "Estudios jurídicos" };

/**
 * **Configuración general › Estudios jurídicos** (encargo E-a; maqueta de mora, pantalla 4): los
 * estudios con los que trabaja la administración y el criterio general para proponer derivaciones.
 * Acá se dan de alta; después, cada barrio elige cuáles trabajan en él (Configuración del barrio › Mora y
 * estudios).
 *
 * Un estudio no le pertenece a una administración: es una cuenta propia. Si ya trabaja con otra que usa
 * el sistema, al agregarlo por su correo o su CUIT se **vincula** a esta.
 *
 * Misma elección de administración y misma barra lateral que la configuración general. Los botones,
 * solo para quien puede editar (`puedeEditar`); la RLS lo vuelve a decidir al escribir.
 */
export default async function EstudiosJuridicos({
  searchParams,
}: {
  readonly searchParams: Promise<Readonly<Record<string, string | string[] | undefined>>>;
}) {
  const pedido = await pedidoDeAdministracion(await searchParams);
  const datos = await conSesion(async (tx) => {
    const resuelta = await resolverAdministracion(tx, pedido);
    const cfg = resuelta.elegida ? await estudiosDeLaAdministracion(tx, { administracionId: resuelta.elegida.id }) : null;
    return { resuelta, cfg };
  });
  // `notFound()` afuera de la transacción, que ya cerró (ADR-0002 §3.1).
  const { resuelta, cfg } = datos;
  if (!cfg) notFound();

  const unaSola = resuelta.visibles.length <= 1;
  const preferencias = PREFERENCIAS_AVISO.map((p) => ({ valor: p, texto: TEXTO_PREFERENCIA_AVISO[p] }));
  const admin = cfg.administracion;

  const pantalla = (
    <Pagina>
      <EncabezadoDePagina
        migas={[
          { texto: admin.nombre, href: "/" },
          { texto: "Configuración general", href: unaSola ? rutaDeConfiguracionGeneral() : rutaDeConfiguracionGeneral(admin.id) },
          { texto: "Estudios jurídicos" },
        ]}
        titulo="Estudios jurídicos"
        bajada="Los estudios con los que trabaja la administración. Acá se dan de alta; después, cada barrio elige cuáles trabajan en él, en Configuración del barrio › Mora y estudios."
        acciones={
          cfg.puedeEditar ? (
            <AgregarEstudio administracion={admin} preferencias={preferencias} />
          ) : (
            <Chip tono="neutro">Solo lectura</Chip>
          )
        }
      />

      {cfg.estudios.length === 0 ? (
        <Vacio titulo="Todavía no hay ningún estudio">
          {cfg.puedeEditar
            ? "Agregá el primero con «Agregar un estudio». Un estudio que ya trabaja con otra administración se busca por su correo o su CUIT."
            : "Los agrega la administración."}
        </Vacio>
      ) : (
        <MarcoTabla etiqueta="Estudios jurídicos de la administración">
          <Tabla>
            <thead>
              <tr>
                <th scope="col" className={ui.columnaAncla}>
                  Estudio
                </th>
                <th scope="col">Contacto</th>
                <th scope="col">Barrios</th>
                <th scope="col" className={ui.numerica}>
                  Derivadas
                </th>
                {cfg.puedeEditar ? (
                  <th scope="col">
                    <span className={ui.soloLectores}>Acciones</span>
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {cfg.estudios.map((e) => (
                <tr key={e.id}>
                  <th scope="row" className={ui.columnaAncla}>
                    <span className={ui.principal}>{e.nombre}</span>
                    <span className={ui.secundaria}> · CUIT {e.cuit}</span>
                    <br />
                    {e.activo ? <Chip tono="exito">Activo</Chip> : <Chip tono="neutro">De baja</Chip>}{" "}
                    <span className={ui.secundaria}>Acceso del estudio: todavía no disponible</span>
                  </th>
                  <td>
                    <span className={ui.principal}>{e.correoAvisos}</span>
                    <br />
                    <span className={ui.secundaria}>
                      {e.telefonoBoleta ? `Tel. en la boleta: ${e.telefonoBoleta}` : "Tel. en la boleta: sin cargar"} · {TEXTO_PREFERENCIA_AVISO[e.preferenciaAviso]}
                    </span>
                  </td>
                  <td>
                    {e.barrios.length === 0 ? (
                      <span className={ui.secundaria}>Ningún barrio todavía</span>
                    ) : (
                      e.barrios.map((b, i) => (
                        <span key={b.id} className={i === 0 ? ui.principal : ui.secundaria}>
                          {i > 0 ? <br /> : null}
                          {b.nombre}
                          {b.porDefecto ? " (por defecto)" : ""}
                        </span>
                      ))
                    )}
                  </td>
                  <td className={ui.numerica}>{e.derivadas}</td>
                  {cfg.puedeEditar ? (
                    <td>
                      {e.activo ? (
                        <>
                          <EditarEstudio
                            administracionId={admin.id}
                            estudio={{
                              id: e.id,
                              nombre: e.nombre,
                              correoAvisos: e.correoAvisos,
                              telefonoBoleta: e.telefonoBoleta,
                              preferenciaAviso: e.preferenciaAviso,
                            }}
                            preferencias={preferencias}
                          />{" "}
                          <DarDeBajaEstudio
                            administracionId={admin.id}
                            administracion={admin.nombre}
                            estudio={{ id: e.id, nombre: e.nombre }}
                            derivadas={e.derivadas}
                          />
                        </>
                      ) : (
                        <span className={ui.secundaria}>Se vuelve a vincular con «Agregar un estudio».</span>
                      )}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </Tabla>
        </MarcoTabla>
      )}

      <Panel
        titulo="Criterio general para proponer derivaciones"
        origen={
          cfg.criterio.cargado
            ? "Vale para todos los barrios, salvo los que tengan uno propio."
            : "La administración todavía no cargó uno: rige el de por defecto, que es este. Al guardarlo queda como propio de la administración."
        }
      >
        {cfg.puedeEditar ? (
          <FormularioDeCriterio administracionId={admin.id} criterio={cfg.criterio} />
        ) : (
          <Definiciones>
            <Definicion termino="Meses de deuda (más de)">{cfg.criterio.meses}</Definicion>
            <Definicion termino="Monto mínimo de deuda">$ {formatearMonto(cfg.criterio.montoMinimo)}</Definicion>
            <Definicion termino="Intimación previa">
              {cfg.criterio.pedirIntimacion ? "Avisar si no hay intimación registrada" : "No pedir"}
            </Definicion>
            <Definicion termino="Aviso en la boleta (texto base)">{cfg.criterio.leyendaBoleta}</Definicion>
          </Definiciones>
        )}
      </Panel>

      <Nota tono="neutro" titulo="Un estudio trabaja para varias administraciones.">
        Si ya trabaja con otra que usa el sistema, al agregarlo por su correo o su CUIT se vincula a esta, con el nombre
        y los datos que le pongas acá. No se puede dar de baja un estudio con unidades derivadas: primero se retiran o se
        pasan a otro.
      </Nota>
    </Pagina>
  );

  const deLaBarra = barrioDeLaBarra(resuelta, resuelta.barrios.map((b) => b.id));
  return (
    <CuerpoConBarraLateral
      barraLateral={
        deLaBarra ? (
          <BarraDelBarrio barrio={deLaBarra} barrios={resuelta.barrios} administracion={admin.nombre} enConfiguracionGeneral />
        ) : (
          <BarraDeLaAdministracion nombre={admin.nombre} activo="configuracion" conConfiguracionGeneral />
        )
      }
    >
      <main id="contenido" className={estilos.contenido}>
        {pantalla}
      </main>
    </CuerpoConBarraLateral>
  );
}
