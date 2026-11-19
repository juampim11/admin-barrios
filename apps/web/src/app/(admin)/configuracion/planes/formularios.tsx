"use client";

/**
 * Las islas de «Configuración general › Planes de pago» (P2a-1; maqueta de planes, pantalla 1): agregar
 * y editar un plan del catálogo, darlo de baja, y las reglas de los planes de cada barrio.
 *
 * Sin regla de negocio: que el francés lleve tasa, que el máximo de cuotas no sea menor que el mínimo,
 * que si cobra el estudio el plan sea con un estudio, que el barrio sea de la administración — lo deciden
 * `@admin-barrios/shared/planes`, el servicio y la base. Acá se muestran sus mensajes tal cual.
 */

import { useState } from "react";
import { AvisoEnLinea, GrupoDeCasillas } from "@admin-barrios/ui";
import { DialogoDeConfirmacion } from "@admin-barrios/ui/cliente/dialogo-de-confirmacion";
import {
  bajaPlanDelCatalogoAction,
  guardarReglasGeneralesDePlanesAction,
  guardarPlanDelCatalogoAction,
  guardarReglasDePlanesAction,
} from "../../../../acciones/planes.ts";
import {
  ORDEN_COMO_LA_ADMINISTRACION,
  ORDENES_DE_IMPUTACION,
  TEXTO_ORDEN_COMO_LA_ADMINISTRACION,
  TEXTO_ORDEN_DE_IMPUTACION,
  type OrdenDeImputacion,
} from "@admin-barrios/shared/planes";
import {
  AvisoDeCamposSueltos,
  AvisoDeFallo,
  Avisos,
  Campos,
  CampoMonto,
  CampoSeleccion,
  CampoTexto,
  Casilla,
  useFormulario,
  type Opcion,
} from "../../../../componentes/formulario.tsx";

/** Lo que el formulario sabe de un plan existente (para editarlo). */
export type PlanParaEditar = {
  readonly id: string;
  readonly nombre: string;
  readonly sistema: string;
  readonly tasaPorcentaje: string | null;
  readonly cuotasMin: number;
  readonly cuotasMax: number;
  readonly anticipo: string;
  readonly anticipoMaxPorcentaje: string | null;
  readonly deudaMaxima: string | null;
  readonly estudioId: string | null;
  readonly modoCobro: string;
  readonly barrioIds: readonly string[];
};

type Opciones = {
  readonly administracionId: string;
  readonly estudios: readonly Opcion[];
  readonly barrios: readonly { readonly id: string; readonly nombre: string }[];
};

const SISTEMAS: readonly Opcion[] = [
  { valor: "frances", texto: "Francés (con interés)" },
  { valor: "fija", texto: "Cuota fija, sin interés" },
];
const ANTICIPOS: readonly Opcion[] = [
  { valor: "no", texto: "No lleva" },
  { valor: "opcional", texto: "Opcional" },
  { valor: "obligatorio", texto: "Obligatorio" },
];
const MODOS: readonly Opcion[] = [
  { valor: "barrio", texto: "El barrio, en la boleta" },
  { valor: "estudio", texto: "El estudio, y rinde al barrio" },
];
/** El valor del selector cuando el plan es solo de la administración (el esquema lo recibe vacío). */
const SOLO_ADMINISTRACION = "";

/** Agregar o editar: mismo diálogo, mismos campos. */
function DialogoDePlan({ opciones, plan }: { readonly opciones: Opciones; readonly plan: PlanParaEditar | null }) {
  const { enviar, pendiente, resultado, campos, previos } = useFormulario(guardarPlanDelCatalogoAction);
  const sueltos = campos[""] ?? [];
  const titulo = plan ? `Editar ${plan.nombre}` : "Plan de pago estándar";
  // F4 tramo 4: en cuota fija la tasa no se usa: el campo se apaga (deshabilitado no viaja) en vez de
  // aceptar una tasa que el servicio ignora en silencio.
  const [sistema, setSistema] = useState(previos["sistema"] ?? plan?.sistema ?? "");
  const cuotaFija = sistema === "fija";
  // Tras un error, lo que se había marcado (lo devuelve la acción); si no, lo del plan o todos.
  const devueltos = previos["barrioIds"];
  const elegidos = new Set(devueltos !== undefined ? devueltos.split(",").filter(Boolean) : (plan?.barrioIds ?? opciones.barrios.map((b) => b.id)));
  return (
    <DialogoDeConfirmacion
      disparador={plan ? "Editar" : "Agregar un plan"}
      varianteDisparador={plan ? "secundario" : "primario"}
      etiquetaDisparador={plan ? `Editar ${plan.nombre}` : "Agregar un plan"}
      titulo={titulo}
      accion={enviar}
      textoConfirmar="Guardar"
      textoPendiente="Guardando…"
      pendiente={pendiente}
      textoVolver="Cancelar"
      cerrarCon={resultado.estado === "ok" ? resultado : null}
      ancho="ancho"
    >
      <input type="hidden" name="administracionId" value={opciones.administracionId} />
      {plan ? <input type="hidden" name="planId" value={plan.id} /> : null}
      <Campos>
        <CampoTexto
          nombre="nombre"
          etiqueta="Nombre"
          requerido
          maximo={120}
          valorInicial={previos["nombre"] ?? plan?.nombre}
          errores={campos["nombre"]}
          ayuda="Como lo va a ver quien arma el plan. Por ejemplo: «12 cuotas al 2 % mensual»."
          ancho
        />
        <CampoTexto
          nombre="cuotasMin"
          etiqueta="Cuotas, desde"
          requerido
          modoDeTeclado="numeric"
          maximo={2}
          valorInicial={previos["cuotasMin"] ?? (plan ? String(plan.cuotasMin) : undefined)}
          errores={campos["cuotasMin"]}
        />
        <CampoTexto
          nombre="cuotasMax"
          etiqueta="Cuotas, hasta"
          requerido
          modoDeTeclado="numeric"
          maximo={2}
          valorInicial={previos["cuotasMax"] ?? (plan ? String(plan.cuotasMax) : undefined)}
          errores={campos["cuotasMax"]}
        />
        <CampoSeleccion
          nombre="sistema"
          etiqueta="Sistema"
          requerido
          sinSeleccion="Elegí"
          opciones={SISTEMAS}
          valorInicial={previos["sistema"] ?? plan?.sistema}
          errores={campos["sistema"]}
          alCambiar={setSistema}
        />
        <CampoTexto
          nombre="tasaPorcentaje"
          etiqueta="Tasa mensual (%) · solo en el francés"
          modoDeTeclado="decimal"
          maximo={8}
          valorInicial={cuotaFija ? "" : (previos["tasaPorcentaje"] ?? plan?.tasaPorcentaje ?? undefined)}
          errores={campos["tasaPorcentaje"]}
          deshabilitado={cuotaFija}
          ayuda={cuotaFija ? "La cuota fija no lleva tasa." : "Por ejemplo 2 o 2,5."}
        />
        <CampoSeleccion
          nombre="anticipo"
          etiqueta="Anticipo"
          requerido
          sinSeleccion="Elegí"
          opciones={ANTICIPOS}
          valorInicial={previos["anticipo"] ?? plan?.anticipo}
          errores={campos["anticipo"]}
        />
        <CampoTexto
          nombre="anticipoMaxPorcentaje"
          etiqueta="Anticipo máximo (%) · si lleva anticipo"
          modoDeTeclado="decimal"
          maximo={6}
          valorInicial={previos["anticipoMaxPorcentaje"] ?? plan?.anticipoMaxPorcentaje ?? undefined}
          errores={campos["anticipoMaxPorcentaje"]}
          ayuda="Vacío si no lleva anticipo."
        />
        <CampoMonto
          nombre="deudaMaxima"
          etiqueta="Deuda máxima para este plan"
          valorInicial={previos["deudaMaxima"] ?? plan?.deudaMaxima ?? undefined}
          errores={campos["deudaMaxima"]}
          ayuda="Vacío: sin tope."
        />
        <CampoSeleccion
          nombre="estudioId"
          etiqueta="Acordado con"
          sinSeleccion="Solo la administración"
          opciones={opciones.estudios}
          valorInicial={previos["estudioId"] ?? plan?.estudioId ?? SOLO_ADMINISTRACION}
          errores={campos["estudioId"]}
        />
        <CampoSeleccion
          nombre="modoCobro"
          etiqueta="Quién cobra"
          requerido
          sinSeleccion="Elegí"
          opciones={MODOS}
          valorInicial={previos["modoCobro"] ?? plan?.modoCobro ?? "barrio"}
          errores={campos["modoCobro"]}
          ayuda="El barrio: la cuota sale en la boleta. El estudio: la cobra él y le rinde al barrio. Los honorarios nunca entran en el plan."
        />
      </Campos>
      <GrupoDeCasillas leyenda="Barrios" ayuda="En qué barrios se ofrece este plan." errores={campos["barrioIds"]}>
        {opciones.barrios.map((b) => (
          <Casilla key={b.id} nombre="barrioIds" valor={b.id} marcadaInicial={elegidos.has(b.id)}>
            {b.nombre}
          </Casilla>
        ))}
      </GrupoDeCasillas>
      <Avisos>
        <AvisoDeCamposSueltos mensajes={sueltos} />
        {resultado.estado === "falla" ? <AvisoDeFallo error={resultado.error} /> : null}
      </Avisos>
    </DialogoDeConfirmacion>
  );
}

export function AgregarPlan({ opciones }: { readonly opciones: Opciones }) {
  return <DialogoDePlan opciones={opciones} plan={null} />;
}

export function EditarPlan({ opciones, plan }: { readonly opciones: Opciones; readonly plan: PlanParaEditar }) {
  return <DialogoDePlan opciones={opciones} plan={plan} />;
}

export function DarDeBajaPlan({
  administracionId,
  plan,
}: {
  readonly administracionId: string;
  readonly plan: { readonly id: string; readonly nombre: string; readonly usos: number };
}) {
  const { enviar, pendiente, resultado } = useFormulario(bajaPlanDelCatalogoAction);
  return (
    <DialogoDeConfirmacion
      disparador="Dar de baja"
      varianteDisparador="sutil"
      etiquetaDisparador={`Dar de baja ${plan.nombre}`}
      titulo={`Dar de baja ${plan.nombre}`}
      accion={enviar}
      textoConfirmar="Dar de baja"
      varianteConfirmar="peligro"
      textoPendiente="Dando de baja…"
      pendiente={pendiente}
      textoVolver="Cancelar"
      cerrarCon={resultado.estado === "ok" ? resultado : null}
    >
      <input type="hidden" name="administracionId" value={administracionId} />
      <input type="hidden" name="planId" value={plan.id} />
      <p>Deja de ofrecerse al armar un plan.</p>
      {plan.usos > 0 ? (
        <AvisoEnLinea tono="info">
          Ya se {plan.usos === 1 ? "armó 1 plan" : `armaron ${plan.usos} planes`} con este: siguen igual, con las cuotas que
          tenían al firmarse.
        </AvisoEnLinea>
      ) : null}
      <Avisos>{resultado.estado === "falla" ? <AvisoDeFallo error={resultado.error} /> : null}</Avisos>
    </DialogoDeConfirmacion>
  );
}

const OPCIONES_DE_ORDEN: readonly Opcion[] = ORDENES_DE_IMPUTACION.map((o) => ({ valor: o, texto: TEXTO_ORDEN_DE_IMPUTACION[o] }));

/**
 * Las reglas generales de la administración: el orden entre la cuota del plan y la expensa (F4 tramo 1; lo
 * usan los barrios sin uno propio) y el tope de tasa equivalente de un plan a medida (F4 tramo 2).
 */
export function EditarReglasGenerales({
  administracionId,
  orden,
  topeTasaPorcentaje,
}: {
  readonly administracionId: string;
  readonly orden: OrdenDeImputacion;
  readonly topeTasaPorcentaje: string;
}) {
  const { enviar, pendiente, resultado, campos, previos } = useFormulario(guardarReglasGeneralesDePlanesAction);
  return (
    <DialogoDeConfirmacion
      disparador="Cambiar"
      varianteDisparador="secundario"
      etiquetaDisparador="Cambiar las reglas generales de los planes"
      titulo="Reglas generales de los planes"
      accion={enviar}
      textoConfirmar="Guardar"
      textoPendiente="Guardando…"
      pendiente={pendiente}
      textoVolver="Cancelar"
      cerrarCon={resultado.estado === "ok" ? resultado : null}
    >
      <input type="hidden" name="administracionId" value={administracionId} />
      <Campos>
        <CampoSeleccion
          nombre="ordenImputacion"
          etiqueta="Entre la cuota del plan y la expensa"
          requerido
          sinSeleccion="Elegí"
          opciones={OPCIONES_DE_ORDEN}
          valorInicial={previos["ordenImputacion"] ?? orden}
          errores={campos["ordenImputacion"]}
          ayuda="«La más vieja primero»: por vencimiento, y el mismo día primero la cuota. «A elección»: lo elige quien registra el pago; los que entran solos van a la más vieja y quedan para revisar."
          ancho
        />
        <CampoTexto
          nombre="topeTasaPorcentaje"
          etiqueta="Tope de un plan a medida (% mensual)"
          requerido
          valorInicial={previos["topeTasaPorcentaje"] ?? topeTasaPorcentaje}
          errores={campos["topeTasaPorcentaje"]}
          ayuda="Si las cuotas de un plan a medida suman más que la deuda, lo de más se mide como una tasa mensual. Pasado este tope, el plan no se guarda."
        />
      </Campos>
      <Avisos>{resultado.estado === "falla" ? <AvisoDeFallo error={resultado.error} /> : null}</Avisos>
    </DialogoDeConfirmacion>
  );
}

/** Las reglas de los planes de un barrio. */
export function EditarReglas({
  reglas,
}: {
  readonly reglas: {
    readonly barrioId: string;
    readonly barrio: string;
    readonly cuotasParaCaer: number;
    /** null: como la administración. */
    readonly ordenImputacion: OrdenDeImputacion | null;
    readonly financiaMora: boolean;
    readonly quitaRequiereActa: boolean;
    readonly rendicionCuatroOjos: boolean;
  };
}) {
  const { enviar, pendiente, resultado, campos, previos } = useFormulario(guardarReglasDePlanesAction);
  return (
    <DialogoDeConfirmacion
      disparador="Editar"
      varianteDisparador="secundario"
      etiquetaDisparador={`Editar las reglas de ${reglas.barrio}`}
      titulo={`Reglas de los planes en ${reglas.barrio}`}
      accion={enviar}
      textoConfirmar="Guardar"
      textoPendiente="Guardando…"
      pendiente={pendiente}
      textoVolver="Cancelar"
      cerrarCon={resultado.estado === "ok" ? resultado : null}
    >
      <input type="hidden" name="barrioId" value={reglas.barrioId} />
      <Campos>
        <CampoSeleccion
          nombre="cuotasParaCaer"
          etiqueta="El plan cae con"
          requerido
          sinSeleccion="Elegí"
          opciones={Array.from({ length: 12 }, (_, i) => i + 1).map((n) => ({ valor: String(n), texto: n === 1 ? "1 cuota impaga" : `${n} cuotas impagas` }))}
          valorInicial={previos["cuotasParaCaer"] ?? String(reglas.cuotasParaCaer)}
          errores={campos["cuotasParaCaer"]}
          ayuda="Cuotas vencidas e impagas. La caída la declara la administración: no es automática."
        />
        <CampoSeleccion
          nombre="ordenImputacion"
          etiqueta="Si el pago no dice a qué va"
          requerido
          sinSeleccion="Elegí"
          opciones={[
            { valor: ORDEN_COMO_LA_ADMINISTRACION, texto: TEXTO_ORDEN_COMO_LA_ADMINISTRACION },
            ...OPCIONES_DE_ORDEN,
          ]}
          valorInicial={previos["ordenImputacion"] ?? reglas.ordenImputacion ?? ORDEN_COMO_LA_ADMINISTRACION}
          errores={campos["ordenImputacion"]}
          ayuda="Cuando la unidad debe cuotas del plan y expensas. «Como la administración» usa el de Configuración general."
          ancho
        />
        <CampoSeleccion
          nombre="financiaMora"
          etiqueta="La mora que entra al plan"
          requerido
          sinSeleccion="Elegí"
          opciones={[
            { valor: "no", texto: "No genera interés: va en partes iguales" },
            { valor: "si", texto: "Se financia junto con el capital" },
          ]}
          valorInicial={previos["financiaMora"] ?? (reglas.financiaMora ? "si" : "no")}
          errores={campos["financiaMora"]}
          ayuda="«No genera interés»: en el francés el interés corre solo sobre el capital, y en todo plan la mora se reparte en partes iguales entre las cuotas. «Se financia»: el francés corre sobre capital y mora, y la mora va en las primeras cuotas. Vale para los planes que se arman de ahora en más."
          ancho
        />
        <CampoSeleccion
          nombre="quitaRequiereActa"
          etiqueta="Un plan con quita"
          requerido
          sinSeleccion="Elegí"
          opciones={[
            { valor: "no", texto: "Lo aprueba la administración" },
            { valor: "si", texto: "Necesita el acta del órgano del barrio" },
          ]}
          valorInicial={previos["quitaRequiereActa"] ?? (reglas.quitaRequiereActa ? "si" : "no")}
          errores={campos["quitaRequiereActa"]}
          ayuda="Sin acta, quedan registrados quién lo aprobó, cuándo y el motivo."
          ancho
        />
        <CampoSeleccion
          nombre="rendicionCuatroOjos"
          etiqueta="La rendición de un estudio"
          requerido
          sinSeleccion="Elegí"
          opciones={[
            { valor: "no", texto: "La confirma quien la carga" },
            { valor: "si", texto: "La confirma otra persona" },
          ]}
          valorInicial={previos["rendicionCuatroOjos"] ?? (reglas.rendicionCuatroOjos ? "si" : "no")}
          errores={campos["rendicionCuatroOjos"]}
          ayuda="«Otra persona»: quien la creó o cargó la última cuota o ingreso no la puede confirmar."
          ancho
        />
      </Campos>
      <Avisos>{resultado.estado === "falla" ? <AvisoDeFallo error={resultado.error} /> : null}</Avisos>
    </DialogoDeConfirmacion>
  );
}
