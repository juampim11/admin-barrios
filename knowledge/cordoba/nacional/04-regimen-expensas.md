---
name: regimen-expensas
description: Régimen de expensas en el CCyC — ordinarias/extraordinarias, obligados al pago, defensas, fondo de reserva, coeficientes y mora. Base del módulo de liquidación.
jurisdiccion: cordoba
nivel: nacional
sources_status: borrador-para-validar
compilado: 2026-07-22
---

# Régimen de expensas (CCyC)

> **El archivo más importante para el módulo de liquidación y cobranzas.** Verificar numeración contra el texto vigente antes de citar (ver advertencia en `01-ccyc-ph-y-conjuntos-inmobiliarios.md`).

## 1. La distinción básica: ordinarias vs. extraordinarias

`[VERIFICADO]` **Ambas son "comunes".** El CCyC las clasifica en ordinarias y extraordinarias, pero todas son expensas comunes. Es una contribución económica obligatoria destinada al mantenimiento de lo común.

**Art. 2048 — Gastos y contribuciones.** Establece tres cosas distintas:
1. Cada propietario atiende los gastos de conservación y reparación de **su propia unidad funcional**.
2. Debe pagar las **expensas comunes ordinarias** de administración y de reparación o sustitución de cosas y partes comunes o bienes del consorcio, necesarias para mantenerlos en buen estado.
3. Debe pagar las **expensas comunes extraordinarias dispuestas por resolución de la asamblea**.

**Art. 2046 inc. c)** refuerza la obligación: pagar expensas comunes ordinarias y extraordinarias **en la proporción de su parte indivisa**.

`[VERIFICADO]` **Criterio para clasificar** (doctrina consolidada):

| | Ordinarias | Extraordinarias |
|---|---|---|
| Naturaleza | Gastos corrientes y previsibles de administración y mantenimiento | Erogaciones no ordinarias; innovaciones que mejoran o revalorizan partes comunes |
| Ejemplos | Honorarios del administrador, sueldos y cargas sociales del personal, limpieza, mantenimiento, luz y agua de espacios comunes, seguros, papelería, arreglos menores | Renovación o reemplazo de instalaciones, impermeabilizaciones, reparaciones estructurales, **indemnizaciones por siniestros**, **indemnizaciones por despido del personal**, indemnizaciones a terceros por daños de cosas o partes comunes |
| Quién la dispone | La administración, en el marco del presupuesto | **La asamblea**, por resolución |

**Regla de negocio #1:** el sistema debe exigir **respaldo de decisión asamblearia** para dar de alta una expensa extraordinaria. Si el administrador la impone por su cuenta sin urgencia, es impugnable.

## 2. Quién está obligado a pagar

`[VERIFICADO]` **Art. 2050 — Obligados al pago.** Además del propietario, y **sin liberarlo**, están obligados quienes sean **poseedores por cualquier título**. La legitimación pasiva es amplia: la doctrina discute si alcanza a poseedores legítimos e ilegítimos, de buena y mala fe (en la práctica, un ocupante que aspira a la prescripción adquisitiva suele pagar expensas regularmente).

`[VERIFICADO]` **Art. 2049 — Defensas.** Los propietarios **no pueden liberarse** del pago:
- ni respecto de las **devengadas antes de su adquisición**,
- ni por **renuncia al uso y goce** de bienes o servicios comunes,
- ni por **enajenación voluntaria o forzosa**,
- ni por **abandono** de la unidad funcional.

Tampoco pueden rehusar el pago ni oponer defensas fundadas en derechos que invoquen contra el consorcio — **con la única excepción de la compensación**, sin perjuicio de reclamarlos por la vía que corresponda.

`[VERIFICADO]` Se vincula con el **art. 1937** (transmisión de obligaciones al sucesor particular).

**Regla de negocio #2:** la deuda **sigue a la unidad funcional**, no solo a la persona. El modelo de datos debe anclar la deuda a la unidad y registrar el histórico de titulares, no reiniciar el saldo al cambiar de dueño.

**Regla de negocio #3:** el sistema debe poder registrar **más de un obligado por unidad** (propietario + poseedor/ocupante) sin liberar al propietario.

## 3. Inquilinos — punto en movimiento

`[A VERIFICAR — ALTA PRIORIDAD]` La Ley de Alquileres 27.551 había modificado el art. 1209 CCyC estableciendo que el locatario **no** paga las expensas comunes extraordinarias ni las que graven la cosa. Esa ley fue **derogada por el DNU 70/2023**, lo que reabrió la discusión sobre el reparto propietario/inquilino.

**Verificar el estado actual antes de que el sistema lo modele.** Es un tema con litigiosidad y con cambios normativos recientes.

## 4. Fondo de reserva

`[VERIFICADO]`
- **Art. 2046 inc. d)** — el propietario está obligado a **contribuir a la integración del fondo de reserva, si lo hay**. Nótese: *si lo hay*. No es automáticamente obligatorio; depende del reglamento.
- **Art. 2064 inc. c)** — el **Consejo de Propietarios** tiene la atribución de **autorizar al administrador a disponer del fondo de reserva** ante **gastos imprevistos y mayores que los ordinarios**.

**Regla de negocio #4:** el fondo de reserva es una **cuenta separada con reglas de uso propias**, no un excedente de caja. El sistema debe: (a) permitir configurar si el barrio tiene fondo de reserva y cómo se integra; (b) exigir registro de la autorización antes de imputar un gasto contra el fondo; (c) reportar su saldo por separado.

## 5. Coeficientes / proporción

`[VERIFICADO]`
- En **propiedad horizontal**: la proporción es la de la **parte indivisa** de cada unidad (art. 2046 inc. c).
- En **conjuntos inmobiliarios (art. 2081 — Gastos y contribuciones)**: los propietarios están obligados a pagar las expensas, gastos y erogaciones comunes para el correcto mantenimiento y funcionamiento del conjunto **en la proporción que establece el reglamento de propiedad horizontal**.

**Regla de negocio #5:** el coeficiente **se define en el reglamento**, no lo inventa el sistema. Debe ser un dato cargado y versionado por barrio, con validación de que la suma cierre. Y como en conjuntos inmobiliarios la fuente es el reglamento, el sistema debe soportar **esquemas de prorrateo distintos al porcentual de parte indivisa** (por lote, por superficie, mixto, con ítems de consumo diferenciado).

## 6. El certificado de deuda

`[VERIFICADO]` **Art. 2048, último párrafo:** el certificado de deuda **expedido por el administrador y aprobado por el consejo de propietarios, si éste existe**, es **título ejecutivo** para el cobro de expensas y demás contribuciones.

Dos condiciones formales que el sistema debe respetar al generarlo:
1. Expedido por el **administrador**.
2. **Aprobado por el consejo de propietarios** cuando ese órgano exista.

⚠️ **Y acá está el punto crítico ya identificado:** el **art. 2081**, que es el equivalente para conjuntos inmobiliarios, **no reproduce la cláusula de título ejecutivo**. La ejecutividad en conjuntos inmobiliarios se deriva de la remisión del art. 2075, y es exactamente lo que se litiga cuando el ente no se adecuó. Ver `jurisprudencia/01-ejecutividad-expensas.md`.

**Regla de negocio #6:** el certificado debe generarse con trazabilidad completa (quién lo emitió, cuándo, con qué aprobación, qué períodos abarca, sobre qué instrumento se funda).

## 7. Mora e intereses

`[A VERIFICAR]` No se localizó una norma del CCyC que fije un régimen específico de intereses para expensas. En la práctica surge del **reglamento** o de la decisión asamblearia, con los límites generales de los intereses y la posible morigeración judicial de tasas excesivas.

**Pendiente de cargar:** criterios sobre morigeración de intereses punitorios en expensas, y si hay criterio propio de los tribunales de Córdoba.

**Regla de negocio #7:** la tasa de interés por mora es **configurable por barrio** (viene del reglamento), no una constante del sistema. Debe versionarse: si la asamblea la cambia, las deudas viejas se calculan con la tasa vigente en su momento.

## 8. Resumen de reglas de negocio derivadas

| # | Regla | Impacto |
|---|-------|---------|
| 1 | Expensa extraordinaria requiere respaldo de asamblea | Módulo de liquidación + actas |
| 2 | La deuda sigue a la unidad funcional, no al titular | Modelo de datos |
| 3 | Múltiples obligados por unidad, sin liberar al propietario | Modelo de datos |
| 4 | Fondo de reserva con reglas y autorización propias | Contabilidad |
| 5 | Coeficientes vienen del reglamento y se versionan | Liquidación |
| 6 | Certificado de deuda con trazabilidad y formalidades | Cobranzas |
| 7 | Tasa de mora configurable y versionada por barrio | Cobranzas |

⚠️ **Todo lo anterior aplica plenamente a la propiedad horizontal.** Para barrios-SA no adecuados, cada regla debe revisarse: el vínculo es societario, no real. Ver `nacional/02-ley-19550-barrio-sa.md`.

## Fuentes

- CCyC texto actualizado — InfoLeg:
  `https://servicios.infoleg.gob.ar/infolegInternet/anexos/235000-239999/235975/texact.htm`
- Articulado de PH y conjuntos inmobiliarios (recopilación sectorial, útil para ubicar artículos):
  `https://ligadelconsorcista.org/legislacion/nuevo-codigo-civil-comercial-parte-pertinente`
- Doctrina sobre clasificación de expensas y legitimación pasiva:
  `https://www.colabro.org.ar/resources/original/biblioteca%20virtual//EXPENSAS.%20MARIA%20ALEJANDRA%20PASQUET.%20LL%20(1).pdf`
  `https://www.eldial.com/nuevo/nuevo_diseno/v2/doctrina_a.asp?id=14692&base=50`
