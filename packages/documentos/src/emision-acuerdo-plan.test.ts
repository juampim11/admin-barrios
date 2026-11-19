/**
 * El PDF de un plan de pagos (encargo P2a-3), sin motor: la vista, la solicitud al generador y el HTML.
 *
 * El caso: un plan a medida de $ 900 en dos cuotas por una deuda de $ 1.000 (capital 950 + interés 50):
 * se perdona $ 100, primero el interés (50) y después el capital (50).
 */
import { describe, expect, it } from "vitest";
import { cifra, fechaImpresa, parsearVistaAcuerdoPlan, VERSION_VISTA_ACUERDO_PLAN, type VistaAcuerdoPlan } from "@admin-barrios/shared/documentos";
import { CLAUSULAS_BORRADOR, completarClausula, LEYENDA_TEXTO_A_VALIDAR } from "@admin-barrios/shared/planes-documentos";
import { solicitudDeAcuerdoPlan } from "./emision-acuerdo-plan.ts";
import { revisarTextosImpresos } from "./lenguaje-prohibido.ts";
import { MARCA_PROPUESTA } from "./plantillas/acuerdo-plan.ts";

const VALORES = {
  barrio: "Barrio Demo",
  unidad: "Mza 2 · Lote 1",
  titular: "Ana Pérez",
  deuda: "$ 1.000,00",
  quita: "$ 100,00",
  totalDelPlan: "$ 900,00",
  cuotas: "2",
  cuotasParaCaer: "2 cuotas vencidas",
};

function vista(cambios: Partial<VistaAcuerdoPlan> = {}): VistaAcuerdoPlan {
  return {
    version: VERSION_VISTA_ACUERDO_PLAN,
    camino: "modelo",
    marca: {
      barrio: { nombre: "Barrio Demo", logo: null, acentoHex: "#5f6b73" },
      emisor: { razonSocial: "Administración Demo", cuit: null, domicilio: null, contacto: null, logo: null },
      pie: [],
    },
    emitido: fechaImpresa("2026-11-17"),
    parte: null,
    firmante: null,
    plan: {
      estado: "pendiente",
      descripcion: "Plan a medida",
      financiacion: "Cronograma a medida",
      cobro: "Cobra el barrio, en la boleta de cada mes",
      cobraElEstudio: null,
      fechaFirma: null,
      acta: null,
    },
    unidad: { etiqueta: "Mza 2 · Lote 1", titular: "Ana Pérez" },
    deuda: {
      meses: [{ periodo: "01/2026", capital: cifra("950.00"), interes: cifra("50.00"), total: cifra("1000.00") }],
      capital: cifra("950.00"),
      interes: cifra("50.00"),
      total: cifra("1000.00"),
    },
    quita: { interes: cifra("50.00"), capital: cifra("50.00"), total: cifra("100.00"), porcentaje: "10" },
    financiacion: cifra("0.00"),
    totalDelPlan: cifra("900.00"),
    cuotas: [
      { numero: 1, vencimiento: fechaImpresa("2026-12-10"), importe: cifra("450.00"), capital: cifra("450.00"), interes: cifra("0.00") },
      { numero: 2, vencimiento: fechaImpresa("2027-01-10"), importe: cifra("450.00"), capital: cifra("450.00"), interes: cifra("0.00") },
    ],
    totalCuotas: { capital: cifra("900.00"), interes: cifra("0.00") },
    cuotasParaCaer: 2,
    clausulas: CLAUSULAS_BORRADOR.map((c) => ({ titulo: c.titulo, texto: completarClausula(c.texto, VALORES) })),
    textoAValidar: true,
    estudio: null,
    leyendas: [],
    ...cambios,
  };
}

describe("el borrador de las cláusulas", () => {
  it("pasa el filtro de lenguaje de la familia: el sistema no amenaza ni en el borrador", () => {
    expect(revisarTextosImpresos(CLAUSULAS_BORRADOR.flatMap((c) => [c.titulo, c.texto]))).toEqual([]);
  });
});

describe("la vista", () => {
  it("valida los cuadres de dinero: deuda + financiación = cronograma + quita, y las cuotas suman el total", () => {
    expect(() => parsearVistaAcuerdoPlan(vista())).not.toThrow();
    expect(() => parsearVistaAcuerdoPlan(vista({ totalDelPlan: cifra("901.00") }))).toThrow(/no cuadra|no suman/);
    expect(() => parsearVistaAcuerdoPlan(vista({ quita: { interes: cifra("50.00"), capital: cifra("40.00"), total: cifra("100.00"), porcentaje: "10" } }))).toThrow(
      /la quita no es interés \+ capital/,
    );
    expect(() => parsearVistaAcuerdoPlan(vista({ camino: "anexo" }))).toThrow(/las cláusulas van solo en el camino del modelo/);
  });
});

describe("la solicitud al generador", () => {
  it("camino a: carátula con las cláusulas completadas, la leyenda, las firmas y el anexo en hoja nueva", () => {
    const s = solicitudDeAcuerdoPlan(vista());
    expect(s.paginasEsperadas).toBe("variable");
    // Un plan pendiente lleva «Propuesta» en todas las hojas.
    expect(s.selloPorPagina).toEqual({ marcaAgua: MARCA_PROPUESTA, numerarPaginas: true });
    expect(s.cuerpo).toContain("Convenio de plan de pagos");
    expect(s.cuerpo).toContain("Ana Pérez");
    expect(s.cuerpo).toContain("es de $ 1.000,00");
    expect(s.cuerpo).toContain("(en este caso, $ 100,00)");
    expect(s.cuerpo).toContain(LEYENDA_TEXTO_A_VALIDAR);
    expect(s.cuerpo).toContain('class="salto seccion"');
    expect(s.cuerpo).toContain("Anexo · Las cifras del plan");
    // Una propuesta no trae renglones para firmar.
    expect(s.cuerpo).not.toContain("Firma, aclaración y DNI");
    expect(s.cuerpo).toContain("Propuesta sin aprobar: se firma el convenio que se arme después de la aprobación.");
    expect(s.cuerpo).toContain("Cada cuota sale en la boleta del mes en que vence.");
    expect(s.cuerpo).not.toMatch(/\{[a-zA-Z]+\}/);
  });

  it("camino b: solo el anexo, dice qué documento acompaña; un plan aprobado no lleva el sello", () => {
    const s = solicitudDeAcuerdoPlan(
      vista({
        camino: "anexo",
        clausulas: null,
        textoAValidar: false,
        estudio: "Estudio Ejemplo",
        plan: { ...vista().plan, estado: "vigente", fechaFirma: fechaImpresa("2026-11-20"), cobraElEstudio: "Estudio Ejemplo" },
      }),
    );
    expect(s.selloPorPagina).toEqual({ marcaAgua: null, numerarPaginas: true });
    expect(s.cuerpo).toContain("Anexo del plan de pagos");
    expect(s.cuerpo).toContain("el convenio redactado por <strong>Estudio Ejemplo</strong>");
    expect(s.cuerpo).not.toContain("Convenio de plan de pagos");
    expect(s.cuerpo).not.toContain(LEYENDA_TEXTO_A_VALIDAR);
    expect(s.cuerpo).toContain("Aprobado el <span class=\"cifra\">20/11/2026</span>");
    expect(s.cuerpo).toContain("Cada cuota la cobra Estudio Ejemplo, que la rinde al barrio.");
    expect(s.cuerpo).not.toContain("Firma, aclaración y DNI");
  });

  it("un plan aprobado lleva las firmas; sin titular cargado, la firma dice de qué unidad", () => {
    const aprobado = { ...vista().plan, estado: "vigente" as const, fechaFirma: fechaImpresa("2026-11-20") };
    expect(solicitudDeAcuerdoPlan(vista({ plan: aprobado })).cuerpo).toContain("Ana Pérez<br><span class=\"rol\">Firma, aclaración y DNI</span>");
    const sinTitular = solicitudDeAcuerdoPlan(vista({ plan: aprobado, unidad: { etiqueta: "Mza 2 · Lote 1", titular: null } }));
    expect(sinTitular.cuerpo).toContain("Titular de la unidad Mza 2 · Lote 1<br>");
  });

  it("[P2b] la parte del barrio es su razón social con figura y CUIT, y firma la administración como su representante", () => {
    const aprobado = { ...vista().plan, estado: "vigente" as const, fechaFirma: fechaImpresa("2026-11-20") };
    const parte = { nombre: "Los Aromos S.A.", figura: "sociedad anónima", cuit: "30-71234567-1", representante: "Administración Ejemplo" };
    const s = solicitudDeAcuerdoPlan(vista({ plan: aprobado, parte }));
    expect(s.cuerpo).toContain(
      "Entre <strong>Los Aromos S.A.</strong> (sociedad anónima, CUIT 30-71234567-1), con la representación de su administración, <strong>Administración Ejemplo</strong>, y ",
    );
    expect(s.cuerpo).toContain("Por Los Aromos S.A.<br><span class=\"rol\">Administración Ejemplo, como su representante</span>");
    // Sin razón social ni CUIT cargados: el nombre del barrio, sin datos inventados.
    const sola = solicitudDeAcuerdoPlan(vista({ plan: aprobado, parte: { nombre: "Barrio Ejemplo", figura: null, cuit: null, representante: null } }));
    expect(sola.cuerpo).toContain("Entre <strong>Barrio Ejemplo</strong> y ");
    expect(sola.cuerpo).toContain("Por Barrio Ejemplo<br><span class=\"rol\">Firma, aclaración y cargo</span>");
  });

  it("[F4 tramo 3] con firmante cargado, la frase de las partes y las firmas son las suyas, con la marca «a validar»", () => {
    const aprobado = { ...vista().plan, estado: "vigente" as const, fechaFirma: fechaImpresa("2026-11-20") };
    const parte = { nombre: "Los Aromos S.A.", figura: "sociedad anónima", cuit: "30-71234567-1", representante: "Administración Ejemplo" };
    const marca = `<span class="marca-a-validar">[${LEYENDA_TEXTO_A_VALIDAR}]</span>`;
    const poder = solicitudDeAcuerdoPlan(
      vista({ plan: aprobado, parte, firmante: { tipo: "administrador_poder", nombre: "Juan Gómez", cargo: null, poder: "Esc. N.º 123 del 05/03/2024, Escribanía Pérez" } }),
    );
    expect(poder.cuerpo).toContain(
      `Entre <strong>Los Aromos S.A.</strong> (sociedad anónima, CUIT 30-71234567-1), representada por <strong>Juan Gómez</strong>, administrador, invocando el poder Esc. N.º 123 del 05/03/2024, Escribanía Pérez, ${marca} y `,
    );
    expect(poder.cuerpo).toContain('Por Los Aromos S.A.<br>Juan Gómez<br><span class="rol">Administrador · Poder Esc. N.º 123 del 05/03/2024, Escribanía Pérez</span>');
    // Ya no dice «con la representación de su administración»: firma quien se cargó.
    expect(poder.cuerpo).not.toContain("con la representación de su administración");
    const presidente = solicitudDeAcuerdoPlan(vista({ plan: aprobado, parte, firmante: { tipo: "presidente_directorio", nombre: "Ana Ruiz", cargo: null, poder: null } }));
    expect(presidente.cuerpo).toContain(`representada por <strong>Ana Ruiz</strong>, en su carácter de presidente del directorio, ${marca}`);
    expect(presidente.cuerpo).toContain('Por Los Aromos S.A.<br>Ana Ruiz<br><span class="rol">Presidente del directorio</span>');
    const otro = solicitudDeAcuerdoPlan(vista({ plan: aprobado, parte, firmante: { tipo: "otro", nombre: "Luis Paz", cargo: "Tesorero de la comisión", poder: null } }));
    expect(otro.cuerpo).toContain(`representada por <strong>Luis Paz</strong>, en su carácter de Tesorero de la comisión, ${marca}`);
    expect(otro.cuerpo).toContain('Por Los Aromos S.A.<br>Luis Paz<br><span class="rol">Tesorero de la comisión</span>');
  });

  it("[F4 tramo 3] sin firmante, el convenio sale como antes; el anexo solo lleva firmas solo con firmante y aprobado", () => {
    const aprobado = { ...vista().plan, estado: "vigente" as const, fechaFirma: fechaImpresa("2026-11-20") };
    const parte = { nombre: "Los Aromos S.A.", figura: null, cuit: null, representante: "Administración Ejemplo" };
    expect(solicitudDeAcuerdoPlan(vista({ plan: aprobado, parte })).cuerpo).not.toContain("marca-a-validar");
    const anexo = { camino: "anexo" as const, clausulas: null, plan: aprobado, parte };
    expect(solicitudDeAcuerdoPlan(vista(anexo)).cuerpo).not.toContain("Firma, aclaración y DNI");
    const conFirmante = solicitudDeAcuerdoPlan(vista({ ...anexo, firmante: { tipo: "otro", nombre: "Luis Paz", cargo: "Tesorero", poder: null } }));
    expect(conFirmante.cuerpo).toContain('Por Los Aromos S.A.<br>Luis Paz<br><span class="rol">Tesorero</span>');
    expect(conFirmante.cuerpo).toContain("Firma, aclaración y DNI");
    expect(conFirmante.cuerpo).toContain("marca-a-validar");
  });

  it("lo que escribe el sistema pasa por el filtro; las cláusulas del estudio no (son su texto)", () => {
    const conAmenaza = vista({ clausulas: [{ titulo: "Incumplimiento", texto: "El barrio podrá iniciar acciones judiciales." }] });
    expect(() => solicitudDeAcuerdoPlan(conAmenaza)).not.toThrow();
    const pieConAmenaza = vista({ leyendas: ["Bajo apercibimiento de acciones legales."] });
    expect(() => solicitudDeAcuerdoPlan(pieConAmenaza)).toThrow(/lenguaje que este documento no puede imprimir/);
  });

  it("escapa lo que viene de la base", () => {
    const s = solicitudDeAcuerdoPlan(vista({ unidad: { etiqueta: "Mza 2 · Lote 1", titular: "<b>Ana</b>" } }));
    expect(s.cuerpo).toContain("&lt;b&gt;Ana&lt;/b&gt;");
    expect(s.cuerpo).not.toContain("<b>Ana</b>");
  });
});
