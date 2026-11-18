"use client";

/**
 * Las islas de la rendición del estudio (encargo P2b, pantalla 5 de la maqueta de planes de pago):
 * abrir una rendición, cargar las cuotas que cobró el estudio y los ingresos al barrio, adjuntar el PDF
 * firmado, quitar lo cargado y confirmar.
 *
 * Sin regla de negocio: que la cuota sea de un plan vigente que cobra ese estudio, que el ingreso entre
 * a la cuenta del barrio, que cuadre y que lo confirmado no cambie lo deciden el servicio y la base
 * (`0097`). Los archivos los sube el navegador; el SHA-256 lo calcula la acción leyendo el objeto.
 */

import { useEffect, useState } from "react";
import { MEDIOS_DEL_INGRESO, MEDIOS_DEL_VECINO, NOMBRE_MEDIO_DEL_INGRESO, NOMBRE_MEDIO_DEL_VECINO } from "@admin-barrios/shared/planes-rendicion";
import type { CuotaParaRendir } from "@admin-barrios/data/servicios/planes-rendicion";
import { Boton } from "@admin-barrios/ui";
import {
  adjuntarPdfDeRendicionAction,
  agregarCuotaARendicionAction,
  agregarIngresoARendicionAction,
  confirmarRendicionAction,
  crearRendicionAction,
  quitarDeRendicionAction,
} from "../../acciones/planes-rendicion.ts";
import { useSubidaDeRendicion } from "../useSubidaDeRendicion.ts";
import {
  Acciones,
  AvisoDeFallo,
  Avisos,
  BotonEnviar,
  CampoArchivo,
  CampoMonto,
  CampoOpciones,
  CampoSeleccion,
  Campos,
  CampoTexto,
  Formulario,
  useFormulario,
} from "../formulario.tsx";

const TIPOS_DEL_COMPROBANTE = "application/pdf,image/jpeg,image/png";

/** «Nueva rendición»: de qué estudio y qué mes rinde. */
export function NuevaRendicion({
  barrioId,
  estudios,
  mesSugerido,
}: {
  readonly barrioId: string;
  readonly estudios: readonly { readonly id: string; readonly nombre: string }[];
  /** `YYYY-MM`. */
  readonly mesSugerido: string;
}) {
  const { enviar, pendiente, resultado, campos, previos } = useFormulario(crearRendicionAction);
  return (
    <Formulario accion={enviar} etiqueta="Nueva rendición">
      <input type="hidden" name="barrioId" value={barrioId} />
      <Campos>
        <CampoSeleccion
          nombre="estudioId"
          etiqueta="Estudio"
          requerido
          sinSeleccion="Elegí el estudio…"
          valorInicial={previos["estudioId"] ?? (estudios.length === 1 ? estudios[0]!.id : "")}
          errores={campos["estudioId"]}
          opciones={estudios.map((e) => ({ valor: e.id, texto: e.nombre }))}
        />
        <CampoTexto nombre="periodo" etiqueta="Mes que rinde" tipo="month" requerido valorInicial={previos["periodo"] ?? mesSugerido} errores={campos["periodo"]} />
      </Campos>
      <Acciones>
        <BotonEnviar pendiente={pendiente} cargando="Abriendo…">
          Nueva rendición
        </BotonEnviar>
      </Acciones>
      <Avisos>{resultado.estado === "falla" ? <AvisoDeFallo error={resultado.error} /> : null}</Avisos>
    </Formulario>
  );
}

/** «Agregar una cuota»: cuál, cuánto (pago parcial permitido), cuándo y cómo le pagó el vecino al estudio. */
export function AgregarCuota({ rendicionId, paraRendir }: { readonly rendicionId: string; readonly paraRendir: readonly CuotaParaRendir[] }) {
  const { enviar, pendiente, resultado, campos, previos } = useFormulario(agregarCuotaARendicionAction);
  const [elegida, setElegida] = useState(previos["planCuotaId"] ?? "");
  const saldo = paraRendir.find((c) => c.planCuotaId === elegida)?.saldo;
  // Agregada la cuota, sale de la lista: se suelta la elegida (code-reviewer).
  useEffect(() => {
    if (resultado.estado === "ok") setElegida("");
  }, [resultado]);
  return (
    <Formulario accion={enviar} etiqueta="Agregar una cuota a la rendición">
      <input type="hidden" name="rendicionId" value={rendicionId} />
      <Campos>
        <CampoSeleccion
          nombre="planCuotaId"
          etiqueta="Cuota que cobró el estudio"
          requerido
          ancho
          sinSeleccion="Elegí la cuota…"
          valorInicial={previos["planCuotaId"] ?? ""}
          alCambiar={setElegida}
          errores={campos["planCuotaId"]}
          opciones={paraRendir.map((c) => ({ valor: c.planCuotaId, texto: c.etiqueta }))}
        />
        <CampoMonto
          key={`importe-${elegida}`}
          nombre="importe"
          etiqueta="Importe"
          requerido
          valorInicial={previos["importe"] ?? saldo ?? ""}
          errores={campos["importe"]}
          ayuda="Si cobró parte de la cuota, va el importe cobrado: se imputa como pago parcial."
        />
        <CampoTexto nombre="fechaCobro" etiqueta="El vecino le pagó el" tipo="date" requerido valorInicial={previos["fechaCobro"]} errores={campos["fechaCobro"]} />
        <CampoSeleccion
          nombre="medioVecino"
          etiqueta="Cómo le pagó"
          requerido
          sinSeleccion="Elegí el medio…"
          valorInicial={previos["medioVecino"] ?? ""}
          errores={campos["medioVecino"]}
          ayuda="Solo un dato: es entre el vecino y el estudio."
          opciones={MEDIOS_DEL_VECINO.map((m) => ({ valor: m, texto: NOMBRE_MEDIO_DEL_VECINO[m] }))}
        />
      </Campos>
      <Acciones>
        <BotonEnviar tono="secundario" pendiente={pendiente} cargando="Agregando…">
          Agregar la cuota
        </BotonEnviar>
      </Acciones>
      <Avisos>{resultado.estado === "falla" ? <AvisoDeFallo error={resultado.error} /> : null}</Avisos>
    </Formulario>
  );
}

/** «Agregar un ingreso»: una transferencia o un depósito a la cuenta del barrio, con su comprobante. */
export function AgregarIngreso({ rendicionId, cuenta }: { readonly rendicionId: string; readonly cuenta: string }) {
  const { enviar, pendiente, resultado, campos, previos } = useFormulario(agregarIngresoARendicionAction);
  const subida = useSubidaDeRendicion(rendicionId, "ingreso");
  const listo = subida.estado.fase === "lista";
  const nombre = subida.estado.fase === "lista" ? subida.estado.archivo.name : "";
  const { reiniciar } = subida;
  useEffect(() => {
    if (resultado.estado === "ok") reiniciar();
  }, [resultado, reiniciar]);
  return (
    <Formulario accion={enviar} etiqueta="Agregar un ingreso al barrio">
      <input type="hidden" name="rendicionId" value={rendicionId} />
      <input type="hidden" name="nombre" value={nombre} />
      <Campos>
        <CampoTexto nombre="fecha" etiqueta="Fecha" tipo="date" requerido valorInicial={previos["fecha"]} errores={campos["fecha"]} />
        <CampoMonto nombre="importe" etiqueta="Importe" requerido valorInicial={previos["importe"]} errores={campos["importe"]} />
        <CampoOpciones
          nombre="medio"
          etiqueta="Cómo llegó"
          requerido
          enFila
          ancho
          valorInicial={previos["medio"] ?? "transferencia"}
          errores={campos["medio"]}
          opciones={MEDIOS_DEL_INGRESO.map((m) => ({ valor: m, titulo: NOMBRE_MEDIO_DEL_INGRESO[m] }))}
        />
        <CampoArchivo
          nombre="clave"
          etiqueta="Comprobante"
          requerido
          aceptar={TIPOS_DEL_COMPROBANTE}
          estado={subida.estado}
          onElegirArchivo={subida.elegirArchivo}
          onReintentar={subida.reintentar}
          errores={campos["clave"]}
          ayuda={`El comprobante de la transferencia o la boleta de depósito (PDF, JPG o PNG). Entra a la cuenta del barrio, ${cuenta}.`}
        />
      </Campos>
      <Acciones>
        <BotonEnviar tono="secundario" pendiente={pendiente} deshabilitado={!listo} cargando="Agregando…">
          Agregar el ingreso
        </BotonEnviar>
      </Acciones>
      <Avisos>{resultado.estado === "falla" ? <AvisoDeFallo error={resultado.error} /> : null}</Avisos>
    </Formulario>
  );
}

/** «Adjuntar la rendición firmada»: el PDF que mandó el estudio (en borrador, se puede cambiar). */
export function AdjuntarPdf({ rendicionId, hayUno }: { readonly rendicionId: string; readonly hayUno: boolean }) {
  const { enviar, pendiente, resultado, campos } = useFormulario(adjuntarPdfDeRendicionAction);
  const subida = useSubidaDeRendicion(rendicionId, "pdf");
  const listo = subida.estado.fase === "lista";
  const nombre = subida.estado.fase === "lista" ? subida.estado.archivo.name : "";
  const { reiniciar } = subida;
  useEffect(() => {
    if (resultado.estado === "ok") reiniciar();
  }, [resultado, reiniciar]);
  return (
    <Formulario accion={enviar} etiqueta="Adjuntar la rendición firmada">
      <input type="hidden" name="rendicionId" value={rendicionId} />
      <input type="hidden" name="nombre" value={nombre} />
      <Campos>
        <CampoArchivo
          nombre="clave"
          etiqueta={hayUno ? "Cambiar el PDF" : "Rendición firmada por el estudio (PDF)"}
          aceptar="application/pdf"
          estado={subida.estado}
          onElegirArchivo={subida.elegirArchivo}
          onReintentar={subida.reintentar}
          errores={campos["clave"]}
          ayuda="El detalle firmado que mandó el estudio. Hace falta para confirmar."
        />
      </Campos>
      <Acciones>
        <BotonEnviar tono="secundario" pendiente={pendiente} deshabilitado={!listo} cargando="Adjuntando…">
          Adjuntar el PDF
        </BotonEnviar>
      </Acciones>
      <Avisos>{resultado.estado === "falla" ? <AvisoDeFallo error={resultado.error} /> : null}</Avisos>
    </Formulario>
  );
}

/** «Quitar» una cuota o un ingreso de la rendición en borrador. */
export function Quitar({ id, que, etiqueta }: { readonly id: string; readonly que: "cuota" | "ingreso"; readonly etiqueta: string }) {
  const { enviar, pendiente, resultado } = useFormulario(quitarDeRendicionAction);
  return (
    <Formulario accion={enviar} etiqueta={etiqueta}>
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="que" value={que} />
      <Boton tipo="submit" variante="sutil" tamano="sm" etiqueta={etiqueta} deshabilitado={pendiente}>
        Quitar
      </Boton>
      {resultado.estado === "falla" ? <AvisoDeFallo error={resultado.error} /> : null}
    </Formulario>
  );
}

/** «Confirmar la rendición»: solo cuando cuadra y está el PDF. Después no cambia. */
export function Confirmar({ rendicionId, habilitado, motivo }: { readonly rendicionId: string; readonly habilitado: boolean; readonly motivo: string | null }) {
  const { enviar, pendiente, resultado } = useFormulario(confirmarRendicionAction);
  return (
    <Formulario accion={enviar} etiqueta="Confirmar la rendición">
      <input type="hidden" name="rendicionId" value={rendicionId} />
      <Acciones ayuda={motivo ?? "Al confirmar, cada ingreso queda como pago de sus cuotas, que pasan a «Pagada · rendición». Después no se modifica."}>
        <BotonEnviar pendiente={pendiente} deshabilitado={!habilitado} cargando="Confirmando…">
          Confirmar la rendición
        </BotonEnviar>
      </Acciones>
      <Avisos>{resultado.estado === "falla" ? <AvisoDeFallo error={resultado.error} /> : null}</Avisos>
    </Formulario>
  );
}
