# Novedades

> Qué cambió para quien usa el sistema, en palabras de pantalla. Lo técnico va en `CHANGELOG.md` y en
> `HANDOFF.md`. Entradas nuevas arriba.

## Noviembre 2026 — Presupuesto y resultado del mes

- **Presupuesto del mes.** En cada mes hay una pestaña «Presupuesto»: lo que el barrio espera gastar,
  rubro por rubro, al lado de lo que gastó el mes anterior, más un margen para imprevistos. Se puede
  copiar del mes anterior y agregar rubros. El presupuesto no cambia lo que se cobra.
- **El importe del mes, contra el presupuesto.** Si el barrio define el importe, al lado del
  presupuesto se ve si el importe cubre lo que hay que pedir. «Usar este importe» lo deja como la
  cuota del mes, con la misma confirmación que en Configuración → Cuota.
- **Gastos contra presupuesto.** En «Gastos y pagos», arriba de la lista, cada rubro con lo
  presupuestado, lo gastado, la diferencia y una barra de avance. Si un rubro se pasa, aparece un
  aviso con el último gasto, también en el Resumen y en «Liquidación actual».
- **Resultado del mes.** En un mes emitido, la pestaña «Resultado» muestra cómo cerró: lo que se
  pidió contra lo que se gastó, la plata que entró contra la que salió, y lo que falta cobrar de las
  boletas de ese mes. El sistema no mueve plata: qué hacer con un sobrante se va a decidir ahí más
  adelante.

## Noviembre 2026 — Correcciones del ensayo

- **Los importes se escriben igual en todos lados.** Al salir del campo se ven con el punto de miles y la
  coma decimal, y si no escribiste decimales completa «,00». El punto del teclado numérico escribe la
  coma. «250.000» es doscientos cincuenta mil. Al volver a entrar al campo se sigue editando el mismo
  importe.
- **Las planillas de deuda y de usos aceptan las fechas como las deja Excel:** el mes como «ago-26» o
  «sept-26», el vencimiento como «10/10/26», y las celdas de fecha de Excel tal cual.
- **Estado de cuenta:** en un mismo día aparecen primero lo que se devengó (la liquidación, el interés)
  y después lo que se pagó.
- **«Ver quién»** dice qué hace cada excepción («Se la damos aunque debe», «Se la quitamos aunque está
  al día») y, al lado de «Sacar la excepción», qué pasa después: «vuelve a la regla: la recibe» o «no
  la recibe». El diálogo es más ancho.
- **Conceptos del barrio:** cada concepto tiene su «Historial de valores»: qué valió, desde cuándo,
  hasta cuándo y quién lo cargó.
- **Titulares:** el documento se ve sin el tipo pegado («27989690»), y se puede cargar un CUIT
  opcional, solo informativo, para quien se identifica con DNI. Está en la ficha, en «Editar», en la
  planilla del padrón y en «Padrón a una fecha».
- **Barrio ya activado:** en el Tablero hay un enlace «Deuda anterior a la activación» que muestra lo
  que el barrio trajo de antes y explica cómo se corrige con un ajuste.
- **Además:** la ficha de la unidad tiene «Volver al padrón»; las pestañas del mes son más grandes; los
  campos de archivo muestran el nombre del archivo elegido; y el «Código para soporte» aparece solo
  cuando el error es inesperado.
- **Envío** ya no se corta con un error de conexión.

## Noviembre 2026 — Activar un barrio que ya venía funcionando

- **Un barrio nuevo nace «Sin activar».** En el Tablero aparecen los cuatro pasos para ponerlo en marcha:
  Padrón, Conceptos, Deuda anterior y Activar. Hasta activarlo no emite ni registra cobros. Los barrios
  que ya estaban funcionando no cambian.
- **La deuda de antes se trae mes por mes, no como un saldo.** Se sube una planilla con la unidad, el
  mes, el concepto, el vencimiento y el importe que falta pagar. Si un mes se pagó en parte, va lo que
  falta. Un renglón negativo y sin mes es un saldo a favor. Antes de guardar se ve cómo queda y los
  errores renglón por renglón; si uno tiene error, no entra ninguno. Si el barrio no debe nada, «El
  barrio no trae deuda».
- **«Verificar antes de activar».** Muestra el capital y el interés de cada unidad, mes por mes, con un
  campo al lado para escribir lo que decía el sistema anterior: dice si coincide o cuánto difiere (ese
  dato es solo para comparar, no se guarda).
- **La tasa para la deuda anterior se elige una sola vez, al activar.** Se propone la vigente del barrio;
  si se usa otra, pide el motivo. Con esa tasa corre el interés desde cada vencimiento hasta el día de
  la activación; desde el día siguiente, con los intereses normales del barrio.
- **Hasta emitir el primer mes se puede volver a subir la planilla** (reemplaza la anterior). Después,
  la deuda anterior se corrige con un ajuste que queda registrado: un cargo o un descuento desde
  «Conceptos del mes» → «Aplicar un concepto», con su motivo.
- **Estado de cuenta: «Deuda mes por mes».** De cada mes adeudado, el concepto, cuándo venció, el
  capital, el interés a hoy y de dónde sale: «Anterior a la activación» o «Devengado en el sistema».
- **El primer cupón cobra solo el mes** (si el barrio cobra «solo el mes»): la deuda de antes va aparte,
  mes por mes, y no se suma al cupón.
- **Los pagos cancelan primero lo que venció antes.** La deuda anterior, que es la más vieja, se cobra
  antes que los meses nuevos.
- **El saldo inicial ya no se carga en el padrón.** La ficha de la unidad lo muestra solo si lo tiene.

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
