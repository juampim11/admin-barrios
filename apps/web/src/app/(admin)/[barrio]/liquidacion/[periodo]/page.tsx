import type { Metadata } from "next";
import { Suspense } from "react";
import { notFound } from "next/navigation";
import { cuotaFijaVigente } from "@admin-barrios/data/servicios/cuota-fija";
import { estadoDelMes, type Falta } from "@admin-barrios/data/servicios/circuito-del-mes";
import { formatearMonto } from "@admin-barrios/shared/dinero";
import { formatearFechaHora, formatearPeriodo, nombreDelPeriodo } from "@admin-barrios/shared/fechas";
import {
  Boton,
  CifraDelMes,
  CifrasDelMes,
  EtapaDelMes,
  EtapasDelMes,
  ItemDeFalta,
  ListaDeFaltas,
  ProximoPaso,
  type EstadoDeEtapa,
} from "@admin-barrios/ui";
import { Nota, Pagina, Panel } from "../../../../../componentes/ui.tsx";
import {
  esIdValido,
  rutaDeCuota,
  rutaDeMesesAnteriores,
  rutasDeCobros,
  rutasDeOrdenesPago,
  rutasDelPeriodo,
  salidasDelPeriodo,
} from "../../../../../rutas.ts";
import { conSesion } from "../../../../../servidor/db.ts";
import { bloqueosYAvisos } from "../../../../../componentes/etiquetas.tsx";
import { EncabezadoDelMes, faltasDelMes, mesOno404, vistaDelMes } from "./mes.tsx";

export const metadata: Metadata = { title: "El mes" };

/**
 * **El resumen del mes** (T2, ADR-0011, maqueta `mes-liquidacion.html` v2): entra en una pantalla.
 * Arriba las tres etapas (Preparar · Emitir · Enviar y cobrar), un solo **próximo paso**, lo que falta
 * con sus marcas **Bloquea** y **Avisa**, y las cifras. El detalle vive en las pestañas: la vista previa
 * en Boletas; PDF, informe, paquete y correo en Envío.
 *
 * No hay «Generar el borrador» ni «Revisada» (D1, D3): lo que se ve antes de emitir es la vista previa,
 * siempre al día, y emitir calcula, valida y firma en el mismo acto.
 */
export default async function ResumenDelMes({
  params,
}: {
  readonly params: Promise<{ readonly barrio: string; readonly periodo: string }>;
}) {
  const { barrio: barrioId, periodo: periodoId } = await params;
  if (!esIdValido(barrioId) || !esIdValido(periodoId)) notFound();
  const { periodo } = await mesOno404(barrioId, periodoId);

  return (
    <Pagina>
      <EncabezadoDelMes barrioId={barrioId} periodoId={periodoId} pestana="resumen" />
      <Suspense
        fallback={
          <Nota tono="info" titulo="Calculando la vista previa del mes…">
            Se calcula con lo cargado hasta ahora, con el interés a hoy. En un barrio grande tarda unos segundos.
          </Nota>
        }
      >
        <CuerpoDelResumen barrioId={barrioId} periodoId={periodoId} />
      </Suspense>
      {periodo.modelo === "fija" && estadoDelMes(periodo.estado) === "preparando" ? (
        <CuotaDelMes barrioId={barrioId} periodoId={periodoId} mes={periodo.periodo} puede={periodo.puedeEmitir} />
      ) : null}
    </Pagina>
  );
}

const pesos = (m: string) => `$ ${formatearMonto(m)}`;
const cosas = (n: number, una: string, varias: string) => `${n} ${n === 1 ? una : varias}`;

async function CuerpoDelResumen({ barrioId, periodoId }: { readonly barrioId: string; readonly periodoId: string }) {
  const { periodo, conteos } = await mesOno404(barrioId, periodoId);
  const vista = await vistaDelMes(periodoId);
  const faltas = await faltasDelMes(periodoId);
  const rutas = rutasDelPeriodo(barrioId, periodoId);
  const estado = estadoDelMes(periodo.estado);
  const bloquean = faltas.filter((f) => f.tipo === "bloquea");
  const avisan = faltas.filter((f) => f.tipo === "avisa");
  const totales = vista.estado === "vista_previa" || vista.estado === "emitida" ? vista.totales : null;

  const preparar = bloqueosYAvisos(bloquean.length, avisan.length);
  const emitirTexto =
    estado === "preparando"
      ? totales
        ? `${cosas(totales.boletas, "boleta", "boletas")} · ${pesos(totales.total)} a hoy`
        : vista.estado === "sin_permiso"
          ? "La vista previa la calcula la administración"
          : "Se calcula cuando nada bloquee"
      : `Emitido el ${periodo.emitidaAtBarrio ? formatearFechaHora(periodo.emitidaAtBarrio) : ""}${periodo.emitidaPorNombre ? ` por ${periodo.emitidaPorNombre}` : ""}`;
  const enviarTexto =
    estado === "enviado" ? "Enviado" : estado === "emitido" ? "Falta enviar por correo" : "Al emitir se preparan los PDF y el informe";

  const etapas: [EstadoDeEtapa, EstadoDeEtapa, EstadoDeEtapa] =
    estado === "enviado"
      ? ["hecha", "hecha", "hecha"]
      : estado === "emitido"
        ? ["hecha", "hecha", "actual"]
        : bloquean.length > 0
          ? ["actual", "pendiente", "pendiente"]
          : ["hecha", "actual", "pendiente"];

  // La salida de lo que bloquea sale de su código (`salidasDelPeriodo`), no del texto del mensaje.
  const salidas: Readonly<Record<string, { readonly texto: string; readonly href: string }>> = salidasDelPeriodo(barrioId, periodoId);
  const salidaDe = (f: Falta): { texto: string; href: string } | null => (f.codigo ? (salidas[f.codigo] ?? null) : null);
  const paso =
    estado === "enviado"
      ? {
          titulo: "Cobrar y conciliar",
          detalle: "Las boletas ya se enviaron. Los pagos se registran en Cobros.",
          acciones: <Boton href={rutasDeCobros(barrioId).grilla}>Ir a Cobros</Boton>,
        }
      : estado === "emitido"
        ? {
            titulo: "Enviar las boletas por correo",
            detalle: "Los PDF, el informe y el paquete se arman solos. El envío lo hacés vos.",
            acciones: (
              <Boton href={rutas.envio} variante="primario">
                Ir a Envío
              </Boton>
            ),
          }
        : bloquean[0]
          ? {
              titulo: bloquean[0].titulo,
              detalle: bloquean[0].detalle,
              acciones: (() => {
                const salida = salidaDe(bloquean[0]);
                return salida ? (
                  <Boton href={salida.href} variante="primario">
                    {salida.texto}
                  </Boton>
                ) : (
                  <Boton href={rutas.boletas}>Ver la vista previa</Boton>
                );
              })(),
            }
          : vista.estado === "sin_permiso"
            ? {
                titulo: "Lo emite la administración del barrio",
                detalle: "Cuando se emita, las boletas y su envío aparecen en este mes.",
                acciones: undefined,
              }
            : {
                titulo: totales ? `Emitir ${cosas(totales.boletas, "boleta", "boletas")}` : "Emitir",
                detalle: "Los avisos no frenan. Revisá la vista previa si querés y emití con el botón de arriba.",
                acciones: <Boton href={rutas.boletas}>Ver la vista previa</Boton>,
              };

  const donde = (f: Falta): { texto: string; href: string } | null => {
    if (f.tipo === "bloquea") return salidaDe(f) ?? { texto: "Ver la vista previa", href: rutas.boletas };
    switch (f.donde) {
      case "gastos":
        return { texto: "Ver los gastos", href: rutas.gastos };
      case "boletas":
        return { texto: "Ver la vista previa", href: rutas.boletas };
      case "ordenes":
        return { texto: "Ver las órdenes", href: rutasDeOrdenesPago(barrioId).grilla };
      case "vencimientos":
        return null;
    }
  };

  return (
    <>
      {conteos.anterioresPendientes > 0 ? (
        <Nota
          tono="alerta"
          titulo={
            conteos.anterioresPendientes === 1
              ? "Hay un mes anterior sin emitir o sin enviar."
              : `Hay ${conteos.anterioresPendientes} meses anteriores sin emitir o sin enviar.`
          }
        >
          Siguen ahí aunque haya empezado un mes nuevo: <a href={rutaDeMesesAnteriores(barrioId)}>ver los meses anteriores</a>.
        </Nota>
      ) : null}
      <EtapasDelMes>
        <EtapaDelMes numero={1} titulo="Preparar" estado={etapas[0]}>
          {estado === "preparando" ? preparar : "Cerrado"}
        </EtapaDelMes>
        <EtapaDelMes numero={2} titulo="Emitir" estado={etapas[1]}>
          {emitirTexto}
        </EtapaDelMes>
        <EtapaDelMes numero={3} titulo="Enviar y cobrar" estado={etapas[2]}>
          {enviarTexto}
        </EtapaDelMes>
      </EtapasDelMes>

      <ProximoPaso titulo={paso.titulo} detalle={paso.detalle} acciones={paso.acciones} />

      {estado === "preparando" && faltas.length > 0 ? (
        <ListaDeFaltas>
          {faltas.map((f, i) => {
            const enlace = donde(f);
            return (
              <ItemDeFalta
                key={i}
                tipo={f.tipo}
                titulo={f.titulo}
                detalle={f.detalle}
                accion={enlace ? <a href={enlace.href}>{enlace.texto}</a> : undefined}
              />
            );
          })}
        </ListaDeFaltas>
      ) : null}

      <CifrasDelMes>
        <CifraDelMes valor={pesos(conteos.totalGastos)} etiqueta={`gastos del mes · ${conteos.gastos}`} />
        <CifraDelMes valor={totales ? pesos(totales.cargos) : "—"} etiqueta={`cargos y descuentos · ${conteos.cargos}`} />
        <CifraDelMes
          valor={totales ? pesos(totales.interes) : "—"}
          etiqueta={`interés por mora · ${totales ? cosas(totales.conInteres, "unidad", "unidades") : "—"}`}
        />
        <CifraDelMes
          valor={totales ? pesos(totales.total) : "—"}
          etiqueta={`total a cobrar · ${totales ? cosas(totales.boletas, "boleta", "boletas") : "—"}`}
        />
      </CifrasDelMes>
    </>
  );
}

/** En cuota fija: la cuota del mes y «Aplicar aumento desde este mes» (D4), que abre Configuración. */
async function CuotaDelMes({
  barrioId,
  periodoId,
  mes,
  puede,
}: {
  readonly barrioId: string;
  readonly periodoId: string;
  readonly mes: string;
  readonly puede: boolean;
}) {
  const cuota = await conSesion((tx) => cuotaFijaVigente(tx, barrioId));
  return (
    <Panel
      titulo={`Cuota del mes ${cuota.importeUnico ? pesos(cuota.importeUnico) : "(varía por unidad)"}`}
      origen={
        cuota.vigenteDesde
          ? `Vigente desde ${formatearPeriodo(cuota.vigenteDesde.slice(0, 7))}${cuota.descripcion ? ` · ${cuota.descripcion}` : ""} · ${
              cuota.importeUnico ? `igual para las ${cuota.unidadesActivas} unidades` : `${cuota.unidadesActivas} unidades`
            }`
          : "Todavía no hay una cuota cargada."
      }
      acciones={puede ? <Boton href={rutaDeCuota(barrioId, mes, periodoId)}>Aplicar aumento desde este mes</Boton> : undefined}
    >
      <p>
        La cuota vive en Configuración del barrio: cada cambio rige desde un mes, con su acta, y nunca toca boletas emitidas.
        {` ${nombreDelPeriodo(mes)} se emite con la que rija para el mes.`}
      </p>
    </Panel>
  );
}
