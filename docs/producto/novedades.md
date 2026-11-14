# Novedades

> Qué cambió para quien usa el sistema, en palabras de pantalla. Lo técnico va en `CHANGELOG.md` y en
> `HANDOFF.md`. Entradas nuevas arriba.

## Noviembre 2026 — Conceptos del barrio, grupos de unidades y planilla de usos

- **«Conceptos del barrio», en una sola pantalla.** En Configuración se ve todo lo que puede aparecer en
  el cupón de una unidad: los gastos que se reparten y los cargos y descuentos. De cada uno, a quién va,
  cómo se calcula y cómo entra cada mes. Desde ahí se cargan conceptos nuevos, se editan y se les cambia
  el valor desde un mes. Lo define la administración; el operador aplica lo que existe.
- **Un concepto puede ir a todas las unidades, a un grupo, a quien lo usó o a una unidad.**
- **Grupos de unidades.** Se arman eligiendo unidades del padrón («Lotes baldíos», por ejemplo) y sirven
  para que un concepto vaya solo a ese grupo.
- **Conceptos que se aplican solos.** Un concepto marcado «Sola» queda aplicado al calcular el mes, a
  todas las unidades o a las de su grupo, sin que nadie elija unidades. Si el grupo cambia, el mes sin
  emitir lo sigue.
- **Planilla de usos.** Para lo que se cobra por uso (un turno de pádel, una jornada del club house) se
  sube una planilla con unidad, concepto, fecha y cantidad. Antes de cargarla se ve cómo queda cada
  boleta y los errores fila por fila; se carga entera o no se carga. La boleta dice las fechas:
  «03/11, 17/11 · 2 turnos».
- **Importe a cargar cada vez.** Para una multa: el importe se escribe al aplicarla. El operador tiene un
  límite propio para estos importes.
- **«Conceptos del mes»** reemplaza a «Cargos y descuentos»: un renglón por concepto, con a quién va,
  cuántas unidades, el importe y de dónde sale (se aplica solo, vino de una planilla o se cargó a mano).
  Abajo, lo devengado en el mes y, aparte, la deuda de meses anteriores como referencia.

## Noviembre 2026 — Cómo se devenga, bonificación automática y el cupón que cobra solo el mes

- **«Cómo se devenga», una vez por barrio.** En Configuración hay un panel nuevo con cuatro decisiones:
  de dónde sale el importe del mes (lo define la administración o son los gastos del mes), cómo se
  reparte (igual para todas o por coeficiente), cómo se bonifica el pago en término y qué cobra el
  cupón. Un cambio rige desde el mes que elijas, queda en el historial con su motivo y no toca lo ya
  emitido. **Los barrios que no lo configuren siguen exactamente como estaban.**
- **Importe definido por coeficiente.** Si el barrio define el importe y lo reparte por coeficiente, en
  Configuración → Cuota se carga el **total del mes** y el sistema lo reparte al centavo. La boleta dice
  de qué total sale la parte de cada unidad.
- **La bonificación por pago en término se puede aplicar sola.** Al emitir, la recibe cada unidad que
  está al día: la que no tiene deuda vencida en ese momento, con los pagos imputados hasta ahí. En la
  pestaña Boletas, «Ver quién» muestra quién la recibe y quién no, y permite «Dársela igual» o «Quitar»
  a una unidad puntual, con motivo: queda en el historial de la unidad.
- **La boleta avisa la bonificación que no se aplicó**, con su importe.
- **El cupón puede cobrar solo el mes.** Con esa opción, «Total a pagar» es lo devengado en el mes. La
  deuda de meses anteriores se imprime debajo, mes por mes, con el interés de cada uno y su total
  aparte, aclarando que no está incluida en el cupón. La deuda y el interés se siguen registrando igual
  que antes: cambia lo que cobra el cupón, no lo que se debe.
- **Boletas del mes, de un vistazo.** Con «solo el mes», la lista muestra un renglón por unidad con lo
  que se sale de lo común (sin bonificación, con cargos, con deuda) y el total del cupón; arriba, cuánto
  se devengó en el mes y cuánta deuda anterior queda fuera de los cupones.
- **Un barrio nuevo nace con el cupón que cobra solo el mes.** Se cambia en «Cómo se devenga».

## Noviembre 2026 — Vencimientos del barrio y datos del padrón

- **Los vencimientos se configuran una vez por barrio.** En Configuración, panel «Vencimientos»: el día
  del primer vencimiento, cuántos días después va el segundo (con el mismo importe) y cuántos días
  después del último vencimiento se corta el cobro. Cada mes nuevo los trae propuestos; se pueden
  cambiar en ese mes hasta emitir.
- **«Se puede pagar hasta el …».** La fecha de corte del mes se ve en el mes, en la lista de meses y en
  el Tablero, y se imprime en la boleta. No cambia el importe ni el interés por mora.
- **Barrios sin entidad constituida.** En el alta de un barrio hay una figura nueva para los barrios que
  no son sociedad ni asociación: los representa un delegado o una comisión, y el CUIT y la razón social
  quedan opcionales.
- **Número de acción de cada unidad**, en la ficha, en la lista del padrón y en la planilla. No se puede
  repetir dentro del barrio.
- **Residente o inquilino de cada unidad**, como dato informativo (nombre, carácter, teléfono y mail).
  La boleta, el envío y la deuda siguen yendo siempre al propietario.
- **«Padrón a una fecha».** Desde el padrón se baja una planilla con los titulares que tenía el barrio
  un día determinado, con su documento y desde cuándo lo son.
