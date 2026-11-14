"use client";

/**
 * Los datos informativos de una unidad (`0078`, encargo 15): el número de acción y el residente o
 * inquilino. Los dibujan igual «Agregar unidad» y «Editar» de la ficha, por eso viven juntos acá.
 *
 * Todos son opcionales y **ninguno cambia a quién se le cobra**: la boleta, el envío y la deuda van
 * siempre al propietario. Qué valores se aceptan lo dice el esquema de `shared/escrituras`, no este
 * archivo. En «Editar» un campo vacío borra el dato (el esquema distingue vacío de ausente).
 */

import { CARACTERES_RESIDENTE } from "@admin-barrios/shared/barrio";
import { CARACTER_RESIDENTE } from "../../../../componentes/etiquetas.tsx";
import { CampoSeleccion, CampoTexto } from "../../../../componentes/formulario.tsx";

const OPCIONES_CARACTER = CARACTERES_RESIDENTE.map((c) => ({ valor: c, texto: CARACTER_RESIDENTE[c] }));

export type ValoresInformativos = {
  readonly numeroAccion: string;
  readonly residenteNombre: string;
  readonly residenteCaracter: string;
  readonly residenteTelefono: string;
  readonly residenteMail: string;
};

export function CamposDeNumeroDeAccion({
  errores,
  valorInicial,
}: {
  readonly errores: readonly string[] | undefined;
  readonly valorInicial: string | undefined;
}) {
  return (
    <CampoTexto
      nombre="numeroAccion"
      etiqueta="N.º de acción (opcional)"
      maximo={30}
      errores={errores}
      valorInicial={valorInicial}
      ayuda="Solo si el barrio numera las acciones de cada unidad."
    />
  );
}

export function CamposDelResidente({
  campos,
  inicial,
}: {
  readonly campos: Readonly<Record<string, readonly string[] | undefined>>;
  /** El valor con que nace cada campo: lo que devolvió la acción, o el dato actual. */
  readonly inicial: (campo: keyof ValoresInformativos) => string | undefined;
}) {
  return (
    <>
      <CampoTexto
        nombre="residenteNombre"
        etiqueta="Residente o inquilino (opcional)"
        maximo={200}
        errores={campos["residenteNombre"]}
        valorInicial={inicial("residenteNombre")}
        ayuda="Solo informativo: la boleta, el envío y la deuda van al propietario."
      />
      <CampoSeleccion
        nombre="residenteCaracter"
        etiqueta="Carácter del residente"
        opciones={OPCIONES_CARACTER}
        sinSeleccion="Sin indicar"
        errores={campos["residenteCaracter"]}
        valorInicial={inicial("residenteCaracter")}
      />
      <CampoTexto
        nombre="residenteTelefono"
        etiqueta="Teléfono del residente"
        maximo={26}
        errores={campos["residenteTelefono"]}
        valorInicial={inicial("residenteTelefono")}
      />
      <CampoTexto
        nombre="residenteMail"
        etiqueta="Mail del residente"
        maximo={120}
        errores={campos["residenteMail"]}
        valorInicial={inicial("residenteMail")}
      />
    </>
  );
}
