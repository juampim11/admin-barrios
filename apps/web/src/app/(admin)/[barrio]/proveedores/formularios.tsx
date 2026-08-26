"use client";

/**
 * Los cuatro formularios del catálogo de proveedores: alta, corrección, desactivación y reactivación.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * POR QUÉ "CORREGIR" ABRE UNA FILA ENTERA Y NO CELDAS SUELTAS
 *
 * El prototipo clickeable aprobado (`/design`, 2026-08-21) mostraba solo la razón social editable
 * dentro de la celda. Es una simplificación del mock: `corregirProveedorSchema` reemplaza los **seis**
 * campos de una — no hay un `PATCH` parcial — y dos de ellos (`condicionFiscal`, y `cbu`/`alias` por
 * separado) ni siquiera tienen columna propia en la tabla, que los junta para no ensanchar la grilla.
 * Editar de verdad exige los seis campos a la vista, así que "Corregir" abre una fila de ancho
 * completo con el mismo `Formulario`/`Campos`/`CampoTexto` que el alta — no una versión angosta que
 * prometa menos de lo que el esquema exige.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * "REACTIVAR" SÍ ESTÁ — CORRECCIÓN DE UNA REGRESIÓN REAL (usuario, 2026-08-26)
 *
 * El primer corte de esta pantalla salió con un `desactivarProveedorAction` sin su mitad simétrica,
 * y un docstring acá mismo que describía la ausencia como una decisión — no lo era: no hay cita en
 * `docs/diseno`, en `HANDOFF.md`, en el commit original (`c1e8977`) ni en ningún test que diga que
 * desactivar es de una sola vía. El prototipo aprobado ya mostraba "Reactivar", y "se desactiva,
 * nunca se borra" implica reversible, no una anulación. `reactivarProveedor()` es tan chico como
 * `desactivarProveedor()` (un `set activo = true`) y se agregó en la misma tanda.
 */

import { useState } from "react";
import type { Proveedor } from "@admin-barrios/data/servicios/proveedores";
import { BotonDeAccion } from "@admin-barrios/ui/cliente/boton-de-accion";
import {
  corregirProveedorAction,
  desactivarProveedorAction,
  reactivarProveedorAction,
  registrarProveedorAction,
} from "../../../../acciones/proveedores.ts";
import {
  Acciones,
  Avisos,
  AvisoDeCamposSueltos,
  AvisoDeExito,
  AvisoDeFallo,
  AvisoDeFalloCompacto,
  BotonEnviar,
  CampoTexto,
  Campos,
  Formulario,
  SoloLectores,
  useFormulario,
  type Salidas,
} from "../../../../componentes/formulario.tsx";
import { IconoCorrecto, IconoFaltante } from "../../../../componentes/iconos.tsx";
import { Chip, ui } from "../../../../componentes/ui.tsx";
import estilos from "./proveedores.module.css";

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Alta
// ────────────────────────────────────────────────────────────────────────────────────────────────

export function FormularioDeProveedor({
  barrioId,
  salidas,
}: {
  readonly barrioId: string;
  readonly salidas: Salidas;
}) {
  const { enviar, pendiente, resultado, campos, previos } = useFormulario(registrarProveedorAction);

  if (resultado.estado === "ok") {
    return <AvisoDeExito titulo={`«${resultado.valor.razonSocial}» quedó registrado en el catálogo.`} />;
  }

  return (
    <Formulario accion={enviar} etiqueta="Registrar un proveedor nuevo">
      <input type="hidden" name="barrioId" value={barrioId} />

      <Campos>
        <CampoTexto
          nombre="razonSocial"
          etiqueta="Razón social"
          requerido
          maximo={300}
          ancho
          errores={campos["razonSocial"]}
          valorInicial={previos["razonSocial"]}
        />
        <CampoTexto
          nombre="cuit"
          etiqueta="CUIT"
          maximo={20}
          errores={campos["cuit"]}
          valorInicial={previos["cuit"]}
          ayuda="Ej: 30-71234567-8"
        />
        <CampoTexto
          nombre="condicionFiscal"
          etiqueta="Condición fiscal"
          maximo={100}
          errores={campos["condicionFiscal"]}
          valorInicial={previos["condicionFiscal"]}
          ayuda="Ej: Responsable Inscripto, Monotributo."
        />
        <CampoTexto
          nombre="contacto"
          etiqueta="Contacto"
          maximo={300}
          errores={campos["contacto"]}
          valorInicial={previos["contacto"]}
        />
        <CampoTexto
          nombre="cbu"
          etiqueta="CBU"
          maximo={22}
          errores={campos["cbu"]}
          valorInicial={previos["cbu"]}
          ayuda="22 dígitos, sin espacios."
        />
        <CampoTexto
          nombre="alias"
          etiqueta="Alias"
          maximo={50}
          errores={campos["alias"]}
          valorInicial={previos["alias"]}
        />
      </Campos>

      <Avisos>
        {resultado.estado === "falla" ? <AvisoDeFallo error={resultado.error} salidas={salidas} /> : null}
        {campos[""] ? <AvisoDeCamposSueltos mensajes={campos[""]} /> : null}
      </Avisos>

      <Acciones>
        <BotonEnviar pendiente={pendiente} cargando="Registrando…">
          Registrar proveedor
        </BotonEnviar>
      </Acciones>
    </Formulario>
  );
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Corregir / desactivar — una fila con su propio estado
// ────────────────────────────────────────────────────────────────────────────────────────────────

export function FilaDeProveedor({
  proveedor,
  salidas,
}: {
  readonly proveedor: Proveedor;
  readonly salidas: Salidas;
}) {
  const [editando, setEditando] = useState(false);

  return (
    <>
      <tr className={proveedor.activo ? undefined : estilos.filaInactiva}>
        <th scope="row" className={ui.columnaAncla}>
          <span className={ui.principal}>{proveedor.razonSocial}</span>
        </th>
        <td className={ui.mono}>{proveedor.cuit ?? <span className={ui.secundaria}>—</span>}</td>
        <td>{proveedor.contacto ?? <span className={ui.secundaria}>—</span>}</td>
        <td className={ui.mono}>
          {proveedor.cbu || proveedor.alias ? (
            <>
              {proveedor.cbu ?? "—"}
              {proveedor.alias ? ` / ${proveedor.alias}` : ""}
            </>
          ) : (
            <span className={ui.secundaria}>—</span>
          )}
        </td>
        <td>
          {proveedor.activo ? (
            <Chip tono="exito" icono={<IconoCorrecto />}>
              Activo
            </Chip>
          ) : (
            <Chip tono="neutro" icono={<IconoFaltante />} punteado>
              Inactivo
            </Chip>
          )}
        </td>
        <td>
          <div className={estilos.accionesFila}>
            <BotonDeAccion variante="secundario" tamano="sm" onClick={() => setEditando((v) => !v)}>
              {editando ? "Cerrar" : "Corregir"}
              <SoloLectores> a {proveedor.razonSocial}</SoloLectores>
            </BotonDeAccion>
            {proveedor.activo ? (
              <BotonDesactivar proveedorId={proveedor.id} salidas={salidas} />
            ) : (
              <BotonReactivar proveedorId={proveedor.id} salidas={salidas} />
            )}
          </div>
        </td>
      </tr>
      {editando ? (
        <tr>
          <td colSpan={6}>
            <FormularioDeCorreccion
              proveedor={proveedor}
              salidas={salidas}
              onGuardado={() => setEditando(false)}
            />
          </td>
        </tr>
      ) : null}
    </>
  );
}

function FormularioDeCorreccion({
  proveedor,
  salidas,
  onGuardado,
}: {
  readonly proveedor: Proveedor;
  readonly salidas: Salidas;
  readonly onGuardado: () => void;
}) {
  const { enviar, pendiente, resultado, campos, previos } = useFormulario(corregirProveedorAction);

  // Se cierra la fila SOLO cuando la corrección se guardó bien — nunca en `falla`/`campos`, mismo
  // criterio que `useSubidaDeComprobante` con `reiniciar`: un rechazo no puede hacer desaparecer lo
  // que la persona ya tipeó.
  if (resultado.estado === "ok") {
    onGuardado();
    return null;
  }

  return (
    <Formulario accion={enviar} etiqueta={`Corregir a ${proveedor.razonSocial}`}>
      <input type="hidden" name="proveedorId" value={proveedor.id} />

      <Campos>
        <CampoTexto
          nombre="razonSocial"
          etiqueta="Razón social"
          requerido
          maximo={300}
          ancho
          errores={campos["razonSocial"]}
          valorInicial={previos["razonSocial"] ?? proveedor.razonSocial}
        />
        <CampoTexto
          nombre="cuit"
          etiqueta="CUIT"
          maximo={20}
          errores={campos["cuit"]}
          valorInicial={previos["cuit"] ?? (proveedor.cuit ?? "")}
        />
        <CampoTexto
          nombre="condicionFiscal"
          etiqueta="Condición fiscal"
          maximo={100}
          errores={campos["condicionFiscal"]}
          valorInicial={previos["condicionFiscal"] ?? (proveedor.condicionFiscal ?? "")}
        />
        <CampoTexto
          nombre="contacto"
          etiqueta="Contacto"
          maximo={300}
          errores={campos["contacto"]}
          valorInicial={previos["contacto"] ?? (proveedor.contacto ?? "")}
        />
        <CampoTexto
          nombre="cbu"
          etiqueta="CBU"
          maximo={22}
          errores={campos["cbu"]}
          valorInicial={previos["cbu"] ?? (proveedor.cbu ?? "")}
          ayuda="22 dígitos, sin espacios."
        />
        <CampoTexto
          nombre="alias"
          etiqueta="Alias"
          maximo={50}
          errores={campos["alias"]}
          valorInicial={previos["alias"] ?? (proveedor.alias ?? "")}
        />
      </Campos>

      <Avisos>
        {resultado.estado === "falla" ? <AvisoDeFallo error={resultado.error} salidas={salidas} /> : null}
        {campos[""] ? <AvisoDeCamposSueltos mensajes={campos[""]} /> : null}
      </Avisos>

      <Acciones>
        <BotonEnviar pendiente={pendiente} cargando="Guardando…">
          Guardar
        </BotonEnviar>
      </Acciones>
    </Formulario>
  );
}

/** Desactivar, sin confirmación — mismo criterio que `BotonQuitarGasto`: es reversible del lado de
 *  los datos que importan (la orden vieja lo sigue nombrando) y agregar un diálogo acá enseña a
 *  apretar "sí" sin leer, costumbre que después llega a un botón que sí es irreversible. */
function BotonDesactivar({
  proveedorId,
  salidas,
}: {
  readonly proveedorId: string;
  readonly salidas: Salidas;
}) {
  const { enviar, pendiente, resultado } = useFormulario(desactivarProveedorAction);

  return (
    <form action={enviar} className={estilos.formularioEnLinea}>
      <input type="hidden" name="proveedorId" value={proveedorId} />
      <BotonEnviar tono="peligro" pendiente={pendiente} cargando="Desactivando…">
        Desactivar
      </BotonEnviar>
      <div aria-live="polite">
        {resultado.estado === "falla" ? (
          <AvisoDeFalloCompacto error={resultado.error} salidas={salidas} />
        ) : null}
        {resultado.estado === "campos" ? (
          <AvisoDeCamposSueltos mensajes={Object.values(resultado.campos).flatMap((m) => m ?? [])} />
        ) : null}
      </div>
    </form>
  );
}

/** La mitad simétrica de `BotonDesactivar`. Sin confirmación, mismo criterio: reactivar es
 *  exactamente tan reversible como desactivar — es el mismo `activo`, al revés. */
function BotonReactivar({
  proveedorId,
  salidas,
}: {
  readonly proveedorId: string;
  readonly salidas: Salidas;
}) {
  const { enviar, pendiente, resultado } = useFormulario(reactivarProveedorAction);

  return (
    <form action={enviar} className={estilos.formularioEnLinea}>
      <input type="hidden" name="proveedorId" value={proveedorId} />
      <BotonEnviar tono="secundario" pendiente={pendiente} cargando="Reactivando…">
        Reactivar
      </BotonEnviar>
      <div aria-live="polite">
        {resultado.estado === "falla" ? (
          <AvisoDeFalloCompacto error={resultado.error} salidas={salidas} />
        ) : null}
        {resultado.estado === "campos" ? (
          <AvisoDeCamposSueltos mensajes={Object.values(resultado.campos).flatMap((m) => m ?? [])} />
        ) : null}
      </div>
    </form>
  );
}
